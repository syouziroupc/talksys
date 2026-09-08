import {
  GROUNDING_CONVERSATION_MODEL,
  GROUNDING_FALLBACK_MODEL,
  QUALITY_CONVERSATION_MODEL,
  LIVE_CONVERSATION_MODEL,
  runNonStreamingCascade,
} from './cloudflare-llm.js';
import { planSearchQueries } from './search-orchestrator.js';
import { webSearch, formatSearchContext } from './web-search.js';
import { rerankSearchResults } from './search-rerank.js';
import { searchBingRss, dedupeSearchResults, hasUsefulSearchEvidence } from './search-fallbacks.js';
import { unsupportedNamedCandidates, sourceTitleRescue } from './search-answer-v18.js';

export const SEARCH_V19_REVISION = 'context-plan-first-v19';
export const SEARCH_V19_MAX_QUERIES = 8;
export const SEARCH_V19_MAX_ROUNDS = 2;

const CONVERSATION_NOISE_RE = /(こんにちは|こんばんは|おはよう|相談したい|どうしよう|どうしたら|かなぁ|かなあ|かな|なんでもいい|えーと|うーん|教えて|お願いします)/i;
const PC_RE = /(?:ノート\s*)?(?:パソコン|PC|ＰＣ)/i;
const WEB_USE_RE = /(ネットサーフィン|ネット閲覧|Web閲覧|ウェブ閲覧|ブラウザ|ネットを見る)/i;
const CHEAP_RE = /(安い|安め|格安|低価格|予算重視|コスパ)/i;
const SHOP_RE = /(買|購入|販売|店|店舗|通販|中古|新品|価格|値段|おすすめ)/i;

function clean(value, max = 280) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[「」『』"']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function unique(values, limit = SEARCH_V19_MAX_QUERIES) {
  const out = [];
  const seen = new Set();
  for (const raw of values || []) {
    const value = clean(typeof raw === 'string' ? raw : raw?.q, 120);
    if (value.length < 2) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function recentUserText(history, limit = 8) {
  return (Array.isArray(history) ? history : [])
    .slice(-limit * 2)
    .filter((item) => item?.role === 'user')
    .map((item) => clean(item.content, 500))
    .filter(Boolean)
    .slice(-limit)
    .join(' ');
}

function detectLocation(text) {
  const matches = [...String(text || '').matchAll(/([一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{1,16}(?:都|道|府|県|市|区|町|村))/g)];
  return clean(matches.at(-1)?.[1] || '', 24);
}

function detectBudget(text) {
  const value = String(text || '');
  const match = value.match(/(?:予算(?:は|が)?\s*)?([0-9０-９]{1,3}(?:[.,，][0-9０-９]+)?\s*(?:万|千)?\s*円(?:以下|以内|くらい|ぐらい|前後)?)/);
  return clean(match?.[1] || '', 24);
}

function keyContext(transcript, history) {
  const current = clean(transcript, 500);
  const priorUsers = recentUserText(history, 8);
  const all = clean(`${priorUsers} ${current}`, 1800);
  return {
    current,
    priorUsers,
    all,
    subject: PC_RE.test(all) ? 'パソコン' : '',
    use: WEB_USE_RE.test(all) ? 'ネットサーフィン' : '',
    cheap: CHEAP_RE.test(all),
    budget: detectBudget(all),
    location: detectLocation(all),
  };
}

function queryLooksConversational(query) {
  const value = clean(query, 200);
  if (!value) return true;
  if (value.length > 92) return true;
  if (CONVERSATION_NOISE_RE.test(value)) return true;
  if (/[。！？!?]/.test(value)) return true;
  return false;
}

export function buildContextualFallbackPlan(transcript, history = []) {
  const ctx = keyContext(transcript, history);
  let resolvedQuestion = ctx.current;
  const mustInclude = [];

  if (ctx.subject === 'パソコン') mustInclude.push('パソコン');
  if (ctx.use) mustInclude.push(ctx.use);
  if (ctx.cheap) mustInclude.push('安さ重視');
  if (ctx.budget) mustInclude.push(ctx.budget);
  if (ctx.location) mustInclude.push(ctx.location);

  if (ctx.subject === 'パソコン' && ctx.use && ctx.cheap) {
    resolvedQuestion = `${ctx.use}中心で使える安いパソコンの現実的な候補と選び方`;
  } else if (ctx.subject === 'パソコン' && ctx.use) {
    resolvedQuestion = `${ctx.use}中心で使うパソコンの候補と必要条件`;
  } else if (ctx.subject === 'パソコン' && ctx.cheap) {
    resolvedQuestion = '安いパソコンの現実的な候補と選び方';
  } else if (ctx.subject === 'パソコン' && !PC_RE.test(resolvedQuestion)) {
    resolvedQuestion = `パソコンについて ${resolvedQuestion}`;
  }

  if (ctx.budget && !resolvedQuestion.includes(ctx.budget)) resolvedQuestion += `。予算は${ctx.budget}`;
  if (ctx.location && !resolvedQuestion.includes(ctx.location)) resolvedQuestion += `。地域は${ctx.location}`;

  const queries = [];
  if (ctx.subject === 'パソコン') {
    if (ctx.use) queries.push(`${ctx.use} パソコン 必要スペック 安い`);
    if (ctx.cheap) queries.push(`安い 中古 ノートパソコン Windows 11 比較`);
    queries.push('中古 ノートパソコン 価格 保証 比較');
    queries.push('Windows 11 対応 中古 ノートパソコン 価格');
    if (ctx.budget) queries.unshift(`${ctx.budget} パソコン 中古 おすすめ`);
    if (ctx.location && SHOP_RE.test(ctx.all)) {
      queries.unshift(`${ctx.location} 中古 パソコン 店舗`);
      queries.unshift(`${ctx.location} パソコン 販売店`);
    }
  } else {
    const compact = clean(resolvedQuestion, 90).replace(CONVERSATION_NOISE_RE, ' ').replace(/\s+/g, ' ').trim();
    if (compact) queries.push(compact);
  }

  return {
    resolvedQuestion: clean(resolvedQuestion, 240),
    intent: SHOP_RE.test(ctx.all) ? 'shopping' : 'general_fact',
    location: ctx.location,
    mustInclude,
    queries: unique(queries, SEARCH_V19_MAX_QUERIES),
    planned: false,
    plannerModel: null,
  };
}

function planContainsContext(plan, ctx) {
  const resolved = clean(plan?.resolvedQuestion || plan?.resolved_question, 300);
  if (!resolved) return false;
  if (ctx.subject && !resolved.includes(ctx.subject) && !(ctx.subject === 'パソコン' && /PC|ＰＣ/i.test(resolved))) return false;
  if (ctx.use && !WEB_USE_RE.test(resolved)) return false;
  if (ctx.cheap && !CHEAP_RE.test(resolved) && !/安さ|低価格|予算/i.test(resolved)) return false;
  if (ctx.budget && !resolved.includes(ctx.budget)) return false;
  return true;
}

export function normalizeContextualPlan(plan, transcript, history = []) {
  const fallback = buildContextualFallbackPlan(transcript, history);
  const ctx = keyContext(transcript, history);
  const rawResolved = clean(plan?.resolvedQuestion || plan?.resolved_question, 240);
  const resolvedQuestion = planContainsContext(plan, ctx) && !queryLooksConversational(rawResolved)
    ? rawResolved
    : fallback.resolvedQuestion;

  const plannedQueries = unique(plan?.queries || [], SEARCH_V19_MAX_QUERIES)
    .filter((query) => !queryLooksConversational(query));
  const contextTokens = [ctx.subject, ctx.use, ctx.budget, ctx.location].filter(Boolean);
  const groundedQueries = plannedQueries.filter((query) => {
    if (!contextTokens.length) return true;
    return contextTokens.some((token) => query.includes(token) || (token === 'パソコン' && /PC|ＰＣ/i.test(query)));
  });

  const queries = unique([
    ...groundedQueries,
    ...fallback.queries,
  ], SEARCH_V19_MAX_QUERIES);

  return {
    ...fallback,
    ...plan,
    resolvedQuestion,
    queries: queries.length ? queries : fallback.queries,
    mustInclude: unique([...(plan?.mustInclude || plan?.must_include || []), ...fallback.mustInclude], 8),
    location: clean(plan?.location || fallback.location, 60),
    planned: Boolean(plan?.planned || plan?.plannerModel),
  };
}

function progress(options, event) {
  try { options?.onProgress?.({ revision: SEARCH_V19_REVISION, at: Date.now(), ...event }); } catch {}
}

function timedSignal(parentSignal, timeoutMs) {
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return parentSignal;
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
  if (!parentSignal) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([parentSignal, timeout]);
  return parentSignal;
}

async function resolvePlan(ai, transcript, history, options) {
  const fallback = buildContextualFallbackPlan(transcript, history);
  progress(options, { phase: 'planning', message: '過去の会話から検索課題を組み立てています' });
  let planned = null;
  try {
    planned = await planSearchQueries(ai, transcript, history, timedSignal(options.signal, 4300));
  } catch {}
  const normalized = normalizeContextualPlan(planned || fallback, transcript, history);
  progress(options, {
    phase: 'plan_ready',
    message: '検索課題を確定しました',
    resolvedQuestion: normalized.resolvedQuestion,
    queries: normalized.queries,
    mustInclude: normalized.mustInclude,
    intent: normalized.intent,
  });
  return normalized;
}

async function searchOne(query, index, signal) {
  const timeoutMs = index < 3 ? 5200 : 4300;
  const [html, rss] = await Promise.all([
    webSearch(query, { limit: 10, timeoutMs, enrichPages: index < 4, signal }).catch(() => []),
    searchBingRss(query, { limit: 10, timeoutMs }).catch(() => []),
  ]);
  return dedupeSearchResults([...html, ...rss], 20);
}

async function runSearch(ai, plan, options) {
  const firstQueries = plan.queries.slice(0, 6);
  progress(options, { phase: 'searching', message: '文脈を反映した検索語で調べています', queries: firstQueries });
  const started = Date.now();
  const batches = await Promise.all(firstQueries.map((query, index) => searchOne(query, index, options.signal)));
  let merged = dedupeSearchResults(batches.flat(), 80);
  let rounds = 1;

  if (!hasUsefulSearchEvidence(merged, 5)) {
    const recovery = unique([
      `${plan.resolvedQuestion} 公式`,
      `${plan.resolvedQuestion} 比較`,
      `${plan.resolvedQuestion} 価格`,
    ].filter((query) => !plan.queries.includes(query)), 2);
    if (recovery.length) {
      rounds = 2;
      progress(options, { phase: 'recovery', message: '根拠が薄いため追加検索しています', queries: recovery });
      const more = await Promise.all(recovery.map((query, index) => searchOne(query, index + 6, options.signal)));
      merged = dedupeSearchResults([...merged, ...more.flat()], 96);
      plan.queries = unique([...plan.queries, ...recovery], 10);
    }
  }

  progress(options, { phase: 'reranking', message: '検索結果を質問との関連度で並べ替えています', evidenceCount: merged.length });
  const ranked = await rerankSearchResults(ai, plan.resolvedQuestion, merged, 12, {
    signal: timedSignal(options.signal, 2200),
    timeoutMs: 2200,
  }).catch(() => merged.slice(0, 12));

  progress(options, {
    phase: 'evidence_ready',
    message: '回答に使う根拠を選びました',
    evidenceCount: ranked.length,
    sources: ranked.slice(0, 8).map((item) => ({ title: clean(item.title, 120), url: item.url })),
    elapsedMs: Date.now() - started,
  });
  return { ranked, rounds };
}

function buildMessages(question, history, plan, ranked) {
  const evidence = formatSearchContext(ranked) || '(直接のWeb根拠は取得できませんでした)';
  return [
    {
      role: 'system',
      content: `あなたはTalkSysの高精度検索回答担当です。会話文脈から復元された検索課題とWeb根拠を使って、日本語で具体的に答えてください。\n- ユーザーの直前までの条件を落とさない。今回の例なら、用途・安さ・予算などを回答の中心にする。\n- 検索語そのものや検索の失敗説明ではなく、質問への答えを先に述べる。\n- 現在価格、在庫、営業時間、法律、現行仕様など変わる事実は根拠にある範囲だけ使う。\n- 根拠にない店舗名や商品名を作らない。\n- 検索根拠が弱くても、安定した一般知識で実用的な選び方は答える。\n- 電話で聞き取りやすい短い文にする。URLやMarkdownは不要。`,
    },
    ...(Array.isArray(history) ? history.slice(-18).map((item) => ({ role: item.role, content: item.content })) : []),
    {
      role: 'user',
      content: `今回の発話: ${clean(question, 900)}\n\n会話から解決した検索課題: ${plan.resolvedQuestion}\n絶対に落とさない条件: ${(plan.mustInclude || []).join(' / ') || '(なし)'}\n\nWeb根拠:\n${evidence}`,
    },
  ];
}

function deterministicAnswerFallback(plan, ranked) {
  const question = plan.resolvedQuestion || '';
  const sourceRescue = sourceTitleRescue(question, ranked);
  if (sourceRescue) return sourceRescue;
  if (PC_RE.test(question) && WEB_USE_RE.test(question)) {
    return 'ネット閲覧中心で安さを優先するなら、中古ノートパソコンを中心に見るのが現実的です。Windows 11に正式対応する世代を選び、メモリは8GB以上、ストレージはSSDを基準にすると普段使いで困りにくいです。価格だけでなく、バッテリー状態と保証も合わせて比べてください。';
  }
  if (PC_RE.test(question)) {
    return '安さ重視なら中古ノートパソコンから比較するのが現実的です。Windows 11対応、メモリ8GB以上、SSD搭載を最低限の確認項目にして、保証とバッテリー状態も見てください。';
  }
  return ranked?.length
    ? '検索結果は取得できています。確認できた根拠を優先して候補を比較し、変動する価格や在庫だけは購入直前に再確認するのが安全です。'
    : '検索用の会話文脈は整理できましたが、外部根拠の取得が不安定でした。条件自体は保持したまま、一般的な選び方から回答します。';
}

async function generateAnswer(ai, question, history, plan, ranked, options) {
  const messages = buildMessages(question, history, plan, ranked);
  const attempts = [
    { model: GROUNDING_CONVERSATION_MODEL, label: '高精度回答', timeoutMs: 5600 },
    { model: GROUNDING_FALLBACK_MODEL, label: '高精度予備', timeoutMs: 4200 },
    { model: QUALITY_CONVERSATION_MODEL, label: '品質予備', timeoutMs: 3000 },
    { model: LIVE_CONVERSATION_MODEL, label: '高速予備', timeoutMs: 2200 },
  ];
  const telemetry = [];

  for (const attempt of attempts) {
    progress(options, { phase: 'answering', message: `${attempt.label}で回答を作っています`, answerRoute: attempt.label });
    const started = Date.now();
    try {
      const result = await runNonStreamingCascade(ai, [attempt.model], messages, {
        signal: timedSignal(options.signal, attempt.timeoutMs),
        maxTokens: 760,
        temperature: 0.06,
        perModelTimeoutMs: attempt.timeoutMs,
        sessionAffinity: options.sessionAffinity,
      });
      const text = clean(result.text, 6000);
      telemetry.push({ route: attempt.label, ok: Boolean(text), elapsedMs: Date.now() - started });
      if (text) return { text, model: result.model, telemetry, fallback: false };
    } catch (error) {
      telemetry.push({ route: attempt.label, ok: false, elapsedMs: Date.now() - started, error: clean(error?.message || error, 160) });
      progress(options, { phase: 'answer_retry', message: `${attempt.label}が応答しないため次の回答経路へ切り替えます`, answerRoute: attempt.label });
    }
  }

  return {
    text: deterministicAnswerFallback(plan, ranked),
    model: null,
    telemetry,
    fallback: true,
  };
}

function parseAudit(text) {
  const raw = String(text || '').trim();
  const candidate = raw.match(/\{[\s\S]*\}/)?.[0] || raw;
  try {
    const data = JSON.parse(candidate);
    return { ok: data?.ok === true, answer: clean(data?.answer, 6000), reason: clean(data?.reason, 240) };
  } catch {
    return { ok: false, answer: '', reason: 'audit_parse_failed' };
  }
}

async function auditAnswer(ai, question, plan, answer, ranked, options) {
  progress(options, { phase: 'auditing', message: '回答中の固有名詞と現在情報を根拠と照合しています' });
  const evidence = formatSearchContext(ranked) || '(根拠なし)';
  try {
    const result = await runNonStreamingCascade(ai, [GROUNDING_FALLBACK_MODEL], [
      {
        role: 'system',
        content: 'Web根拠監査。根拠にない店舗名・商品名・現在価格・在庫・営業時間・法律・現行仕様を削除または弱める。一般的な選び方は残す。JSONだけ返す: {"ok":true|false,"reason":"短い理由","answer":"修正版"}',
      },
      {
        role: 'user',
        content: `質問: ${clean(question, 800)}\n検索課題: ${plan.resolvedQuestion}\n回答: ${answer}\n\n根拠:\n${evidence}`,
      },
    ], {
      signal: timedSignal(options.signal, 3000),
      maxTokens: 700,
      temperature: 0.01,
      perModelTimeoutMs: 2850,
      sessionAffinity: options.sessionAffinity,
    });
    return parseAudit(result.text);
  } catch {
    return { ok: false, answer: '', reason: 'audit_timeout_or_model_error' };
  }
}

export async function answerWithContextualVerifiedSearchV19(ai, question, history = [], options = {}) {
  const totalStarted = Date.now();
  const plan = await resolvePlan(ai, question, history, options);
  const search = await runSearch(ai, plan, options);
  const ranked = search.ranked;
  const answerStarted = Date.now();
  let generated = await generateAnswer(ai, question, history, plan, ranked, options);
  let text = generated.text;

  const audit = await auditAnswer(ai, question, plan, text, ranked, options);
  if (audit.answer) text = audit.answer;

  const unsupported = unsupportedNamedCandidates(text, ranked);
  if (unsupported.length) {
    const rescue = sourceTitleRescue(plan.resolvedQuestion, ranked);
    if (rescue) text = rescue;
  }

  const result = {
    text: clean(text, 6000) || deterministicAnswerFallback(plan, ranked),
    provider: 'cloudflare-context-plan-first-verified-search-v19',
    model: generated.model,
    resolvedQuestion: plan.resolvedQuestion,
    queries: plan.queries,
    mustInclude: plan.mustInclude || [],
    planned: Boolean(plan.planned),
    rounds: search.rounds,
    evidenceUseful: hasUsefulSearchEvidence(ranked, 4),
    sources: ranked.slice(0, 12),
    auditPassed: audit.ok && unsupported.length === 0,
    auditReason: audit.reason,
    answerFallback: generated.fallback,
    answerAttempts: generated.telemetry,
    timings: {
      answerMs: Date.now() - answerStarted,
      totalSearchAnswerMs: Date.now() - totalStarted,
    },
  };

  progress(options, {
    phase: 'done',
    message: '検索と根拠確認が完了しました',
    resolvedQuestion: result.resolvedQuestion,
    queries: result.queries,
    evidenceCount: result.sources.length,
    sources: result.sources.slice(0, 8).map((item) => ({ title: clean(item.title, 120), url: item.url })),
    auditPassed: result.auditPassed,
    answerFallback: result.answerFallback,
    answerAttempts: result.answerAttempts,
    timings: result.timings,
  });
  return result;
}

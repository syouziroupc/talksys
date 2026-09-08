import { webSearch, needsWebSearch, looksContextDependentFollowup } from './web-search.js';
import { rerankSearchResults } from './search-rerank.js';
import { extractText } from './voice-helpers.js';
import { LIVE_VOICE_MODEL, GROUNDING_VOICE_MODEL, GROUNDING_FALLBACK_MODEL } from './streaming-workers-ai.js';
import {
  buildDeterministicSearchQueries,
  dedupeSearchResults,
  hasUsefulSearchEvidence,
  searchBingRss,
  searchOpenStreetMapLocal,
} from './search-fallbacks.js';

export const SEARCH_FILLER_MODEL = LIVE_VOICE_MODEL;
export const SEARCH_MAX_QUERIES = 8;
export const SEARCH_MAX_ROUNDS = 2;
export const SEARCH_FILLER_MIN_DELAY_MS = 320;
export const SEARCH_TOTAL_BUDGET_MS = 17000;
export const SEARCH_PLANNER_BUDGET_MS = 2800;
export const SEARCH_FETCH_BUDGET_MS = 4400;
export const SEARCH_COVERAGE_BUDGET_MS = 2200;

const CONTEXT_SEARCH_CUE_RE = /(どこ|どっち|どちら|どれ|おすすめ|買|購入|店|店舗|販売|価格|値段|在庫|営業時間|比較|評判|今|現在|最新|調べ|検索|本当|事実|仕様|法律|制度|ニュース)/i;
const EXTERNAL_CONTEXT_RE = /(パソコン|PC|ノート|iPhone|Android|Windows|Mac|製品|商品|店|店舗|会社|企業|大学|病院|ホテル|飲食|法律|制度|ニュース|価格|在庫|営業時間|市|区|町|村|県|都|府|道|Amazon|楽天|Yahoo|Google|Microsoft|Apple|Cloudflare)/i;
const HIGH_VERIFICATION_RE = /(価格|値段|在庫|営業時間|今日|現在|最新|販売中|発売|法律|制度|時刻|予定|日程|店|店舗|販売店|買う|購入先|どこで買|行き方|経路|乗り換え|交通)/i;
const GENERIC_RESEARCH_COMMAND_RE = /^(?:ちょっと)?(?:調べて(?:ごらん|みて|くれ|ください)?|検索して(?:みて|くれ|ください)?|確認して(?:みて|くれ|ください)?)[。！!？?]*$/i;
const BAD_PROGRESS_TOPIC_RE = /^(?:検索内容(?:が)?不明|検索内容|内容不明|不明|ご相談の内容|今回の内容|質問内容)$/i;

function recentConversation(history, limit = 12) {
  if (!Array.isArray(history)) return '';
  return history
    .slice(-limit)
    .filter((item) => item && (item.role === 'user' || item.role === 'assistant'))
    .map((item) => `${item.role}: ${String(item.content || '').slice(0, 850)}`)
    .join('\n');
}

function cleanQuery(value) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/^[\s"'「『]+|[\s"'」』]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280);
}

function uniqueQueries(values, limit = SEARCH_MAX_QUERIES) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const query = cleanQuery(typeof value === 'string' ? value : value?.q);
    if (query.length < 2) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(query);
    if (out.length >= limit) break;
  }
  return out;
}

function parsePlannerJson(text) {
  const raw = String(text || '').trim();
  const candidates = [raw, raw.match(/\{[\s\S]*\}/)?.[0]].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const data = JSON.parse(candidate);
      if (!data || typeof data !== 'object') continue;
      const resolvedQuestion = cleanQuery(data.resolved_question || data.resolvedQuestion || '');
      const queries = uniqueQueries(Array.isArray(data.queries) ? data.queries : []);
      const intent = cleanQuery(data.intent || '').slice(0, 40);
      const location = cleanQuery(data.location || '').slice(0, 60);
      const mustInclude = Array.isArray(data.must_include || data.mustInclude)
        ? (data.must_include || data.mustInclude).map(cleanQuery).filter(Boolean).slice(0, 8)
        : [];
      if (resolvedQuestion || queries.length) return { resolvedQuestion, queries, intent, location, mustInclude };
    } catch {}
  }
  return null;
}

function parseCoverageJson(text) {
  const raw = String(text || '').trim();
  const candidate = raw.match(/\{[\s\S]*\}/)?.[0] || raw;
  try {
    const data = JSON.parse(candidate);
    return {
      sufficient: data?.sufficient === true,
      reason: cleanQuery(data?.reason || '').slice(0, 240),
      queries: uniqueQueries(Array.isArray(data?.queries) ? data.queries : [], 4),
    };
  } catch {
    return { sufficient: false, reason: 'coverage_parse_failed', queries: [] };
  }
}

function usefulHistoryForFallback(history) {
  if (!Array.isArray(history)) return [];
  return history
    .slice(-12)
    .filter((item) => item && (item.role === 'user' || item.role === 'assistant'))
    .filter((item) => {
      const text = String(item.content || '');
      if (item.role !== 'assistant') return true;
      return !/(検索結果|裏付けが十分|ご提示いただいた|情報源を提示|調べ直します|確認できませんでした)/i.test(text);
    })
    .slice(-6);
}

export function heuristicContextQuery(transcript, history) {
  const current = cleanQuery(transcript);
  if (!current) return '';
  const dependent = looksContextDependentFollowup(current) || GENERIC_RESEARCH_COMMAND_RE.test(current);
  if (current.length >= 48 && !dependent) return current;

  const useful = usefulHistoryForFallback(history);
  const userContext = useful
    .filter((item) => item.role === 'user')
    .map((item) => cleanQuery(item.content))
    .filter(Boolean)
    .slice(-4)
    .join(' ');
  const fallbackContext = userContext || useful
    .map((item) => cleanQuery(item.content))
    .filter(Boolean)
    .slice(-3)
    .join(' ');

  if (!fallbackContext) return current;
  return cleanQuery(`${fallbackContext} ${current}`);
}

export function shouldDeepSearch(transcript, history = []) {
  const current = String(transcript || '').trim();
  if (!current) return false;
  if (needsWebSearch(current)) return true;

  const contextual = looksContextDependentFollowup(current) || CONTEXT_SEARCH_CUE_RE.test(current);
  if (!contextual) return false;

  const recent = usefulHistoryForFallback(history)
    .map((item) => String(item.content || ''))
    .join(' ');
  if (!recent) return false;
  return EXTERNAL_CONTEXT_RE.test(recent) || HIGH_VERIFICATION_RE.test(recent);
}

async function runPlannerModel(ai, model, transcript, history, signal) {
  const recent = recentConversation(history);
  const year = new Date().getFullYear();
  const result = await ai.run(model, {
    messages: [
      {
        role: 'system',
        content: `あなたは日本語会話用のWeb調査プランナーです。速さより検索精度を優先します。今回の発話を直前の会話から自己完結した調査課題へ復元し、検索エンジン向けクエリを6〜8本作ってください。\n\n必須ルール:\n- 「それ」「どこがいい？」「調べてごらん」「調べてくれない？」「別府市内なら？」などの省略は直前の会話から対象だけ復元する。「調べる」という語の辞書的意味を検索してはいけない。assistantの過去回答は事実根拠にはせず、ユーザーの訂正を最優先する。\n- ユーザーが出した予算、用途、地域、型番、日時、数量、条件を落とさない。\n- 同じ語順の言い換えだけを量産しない。検索意図を分解する。\n- 最低でも、広い探索1本、一次情報/公式1〜2本、独立した確認1本、比較/評判1本を含める。\n- 地域店舗なら「地域 商品 販売店」「地域 商品 家電量販店/専門店」「地域 商品 店舗 公式」のように複数角度で探す。\n- 価格・在庫・営業時間・法律・現行仕様・ニュースは${year}年の現在性を意識し、公式/一次情報を必ず探す。\n- 商品購入では、存在確認と価格/在庫確認を別クエリに分ける。\n- 実在を確認していない固有名詞を検索語に新規生成しない。\n- 検索語は日本語検索で自然な短い語句にする。\n\nJSONだけを返す。形式: {"resolved_question":"自己完結した調査課題","intent":"local_purchase|shopping|current_fact|general_fact|comparison|news|other","location":"地域または空文字","must_include":["絶対に落とせない条件"],"queries":["検索語1","検索語2","...最大8"]}`,
      },
      {
        role: 'user',
        content: `直近の会話:\n${recent || '(なし)'}\n\n今回の発話:\n${String(transcript || '').slice(0, 1000)}`,
      },
    ],
    max_completion_tokens: 520,
    temperature: 0.02,
  }, signal ? { signal } : undefined);
  return parsePlannerJson(extractText(result));
}

export async function planSearchQueries(ai, transcript, history, signal) {
  const fallbackQuestion = heuristicContextQuery(transcript, history) || cleanQuery(transcript);
  const models = [...new Set([GROUNDING_FALLBACK_MODEL, GROUNDING_VOICE_MODEL].filter(Boolean))];
  for (const model of models) {
    try {
      const planned = await runPlannerModel(ai, model, transcript, history, signal);
      if (!planned) continue;
      const genericCommand = GENERIC_RESEARCH_COMMAND_RE.test(cleanQuery(transcript));
      const resolvedQuestion = genericCommand ? fallbackQuestion : (planned.resolvedQuestion || fallbackQuestion);
      const deterministic = buildDeterministicSearchQueries(resolvedQuestion, history);
      const plannedQueries = genericCommand
        ? planned.queries.filter((query) => {
            const compact = cleanQuery(query);
            const signals = (resolvedQuestion.match(/[一-龠々ヶ]{2,}|[ァ-ヶー]{2,}|[A-Za-z0-9-]{3,}/g) || []).slice(-12);
            return signals.some((signal) => compact.includes(signal));
          })
        : planned.queries;
      const queries = uniqueQueries([
        ...plannedQueries.slice(0, 4),
        ...deterministic,
        ...plannedQueries.slice(4),
        resolvedQuestion,
      ], SEARCH_MAX_QUERIES);
      if (queries.length) {
        return {
          ...planned,
          resolvedQuestion,
          queries,
          plannerModel: model,
          planned: true,
        };
      }
    } catch {}
  }

  const deterministic = buildDeterministicSearchQueries(fallbackQuestion || transcript, history);
  const queries = uniqueQueries([fallbackQuestion, ...deterministic, `${fallbackQuestion} 公式`, `${fallbackQuestion} 比較`, transcript], 6);
  return {
    resolvedQuestion: fallbackQuestion || cleanQuery(transcript),
    queries,
    intent: HIGH_VERIFICATION_RE.test(fallbackQuestion) ? 'current_fact' : 'general_fact',
    location: '',
    mustInclude: [],
    plannerModel: null,
    planned: false,
  };
}

function dedupeResults(results, limit = 64) {
  return dedupeSearchResults(results, limit);
}

function looksLocalPurchase(question, plan = {}) {
  if (plan?.intent === 'local_purchase') return true;
  const value = String(question || '');
  return /(?:都|道|府|県|市|区|町|村).*(?:買|購入|販売店|店舗|店|家電量販店|中古)/i.test(value)
    || /(?:買|購入|販売店|店舗|店|家電量販店|中古).*(?:都|道|府|県|市|区|町|村)/i.test(value);
}

async function searchOne(query, timeoutMs, enrichPages) {
  const [htmlResults, rssResults] = await Promise.all([
    webSearch(query, { limit: 10, timeoutMs, enrichPages }).catch(() => []),
    searchBingRss(query, { limit: 10, timeoutMs }).catch(() => []),
  ]);
  return dedupeResults([...htmlResults, ...rssResults], 20);
}

function evidenceSummary(results, limit = 18) {
  return (results || []).slice(0, limit).map((item, index) => {
    let host = '';
    try { host = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
    return `[${index + 1}] ${String(item.title || '').slice(0, 180)}\n${host}\n${String(item.excerpt || item.snippet || '').replace(/\s+/g, ' ').slice(0, 700)}`;
  }).join('\n\n');
}

async function assessCoverage(ai, plan, results, signal) {
  if (!results?.length) return { sufficient: false, reason: 'no_results', queries: [] };
  const models = [...new Set([GROUNDING_FALLBACK_MODEL, GROUNDING_VOICE_MODEL].filter(Boolean))];
  for (const model of models) {
    try {
      const result = await ai.run(model, {
        messages: [
          {
            role: 'system',
            content: `Web調査の十分性を判定してください。回答文は作らず、検索結果が質問へ具体的に答えるのに足りるかだけを判定します。\n- 地域店舗/購入先では、実在候補が地域と結び付いた根拠が必要。名称だけの推測は不可。\n- 価格・在庫・営業時間・現行制度など変動情報は公式または独立した複数根拠を優先。\n- 一般事実でも、検索結果が質問の主要語を外しているなら不十分。\n- 不十分なら、既存検索と重複しない追加検索語を最大4本作る。\nJSONだけ: {"sufficient":true|false,"reason":"短い理由","queries":["追加検索語"]}`,
          },
          {
            role: 'user',
            content: `調査課題: ${plan.resolvedQuestion}\n意図: ${plan.intent || 'unknown'}\n地域: ${plan.location || '(なし)'}\n必須条件: ${(plan.mustInclude || []).join(' / ') || '(なし)'}\n既存検索語: ${(plan.queries || []).join(' / ')}\n\n検索結果:\n${evidenceSummary(results)}`,
          },
        ],
        max_completion_tokens: 300,
        temperature: 0.01,
      }, signal ? { signal } : undefined);
      const parsed = parseCoverageJson(extractText(result));
      if (parsed) return parsed;
    } catch {}
  }
  return { sufficient: hasUsefulSearchEvidence(results, 6), reason: 'model_unavailable', queries: [] };
}

function deterministicRecoveryQueries(plan, transcript, history) {
  const resolved = plan?.resolvedQuestion || transcript;
  const deterministic = buildDeterministicSearchQueries(resolved, history);
  const extras = [];
  for (const query of deterministic) {
    extras.push(query);
    extras.push(`${query} 公式`);
    if (/販売店|店舗|家電量販店|専門店/.test(query)) extras.push(`${query} 店舗一覧`);
  }
  if (resolved) {
    extras.push(`${resolved} 公式`);
    extras.push(`${resolved} 比較`);
    extras.push(`${resolved} 評判`);
  }
  const existing = new Set((plan?.queries || []).map((item) => cleanQuery(item).toLowerCase()));
  return uniqueQueries(extras.filter((item) => !existing.has(cleanQuery(item).toLowerCase())), 4);
}

function shouldForceSecondPass(plan, resolvedQuestion) {
  if (plan?.intent === 'local_purchase' || plan?.intent === 'shopping' || plan?.intent === 'current_fact' || plan?.intent === 'news') return true;
  return HIGH_VERIFICATION_RE.test(String(resolvedQuestion || ''));
}

function remainingBudget(startedAt, totalMs = SEARCH_TOTAL_BUDGET_MS) {
  return Math.max(0, totalMs - (Date.now() - startedAt));
}

function phaseSignal(parentSignal, timeoutMs) {
  const ms = Math.max(1, Number(timeoutMs) || 1);
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return parentSignal;
  const timeoutSignal = AbortSignal.timeout(ms);
  if (!parentSignal) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([parentSignal, timeoutSignal]);
  return parentSignal;
}

function fallbackPlan(transcript, history) {
  const resolvedQuestion = heuristicContextQuery(transcript, history) || cleanQuery(transcript);
  return {
    resolvedQuestion,
    queries: uniqueQueries([resolvedQuestion, ...buildDeterministicSearchQueries(resolvedQuestion, history)], SEARCH_MAX_QUERIES),
    intent: HIGH_VERIFICATION_RE.test(resolvedQuestion) ? 'current_fact' : 'general_fact',
    location: '',
    mustInclude: [],
    plannerModel: null,
    planned: false,
  };
}

export async function runDeepSearch(ai, transcript, history, signal, options = {}) {
  const startedAt = Date.now();
  const timings = {};
  const configuredFetch = Number(options.timeoutMs) || SEARCH_FETCH_BUDGET_MS;
  const fetchTimeoutMs = Math.max(2800, Math.min(SEARCH_FETCH_BUDGET_MS, configuredFetch));

  const seedQuestion = heuristicContextQuery(transcript, history) || cleanQuery(transcript);
  const seedQueries = uniqueQueries([
    seedQuestion,
    ...buildDeterministicSearchQueries(seedQuestion || transcript, history),
  ], 4);
  if (!seedQueries.length) seedQueries.push(cleanQuery(transcript));

  const plannerPromise = (async () => {
    const t = Date.now();
    try {
      const budget = Math.min(SEARCH_PLANNER_BUDGET_MS, Math.max(500, remainingBudget(startedAt)));
      return await planSearchQueries(ai, transcript, history, phaseSignal(signal, budget));
    } catch {
      return fallbackPlan(transcript, history);
    } finally {
      timings.plannerMs = Date.now() - t;
    }
  })();

  const firstSearchPromise = (async () => {
    const t = Date.now();
    try {
      return await Promise.all(seedQueries.map((query, index) => searchOne(query, fetchTimeoutMs, index < 2)));
    } finally {
      timings.firstSearchMs = Date.now() - t;
    }
  })();

  // High-model query planning never blocks the first deterministic retrieval pass.
  const [planRaw, firstBatches] = await Promise.all([plannerPromise, firstSearchPromise]);
  const plan = planRaw || fallbackPlan(transcript, history);
  const allQueries = uniqueQueries([...seedQueries, ...(plan.queries || []), plan.resolvedQuestion], SEARCH_MAX_QUERIES);
  plan.queries = allQueries;

  let merged = dedupeResults(firstBatches.flat(), 64);
  const seedKeys = new Set(seedQueries.map((item) => cleanQuery(item).toLowerCase()));
  const supplementalQueries = allQueries.filter((item) => !seedKeys.has(cleanQuery(item).toLowerCase())).slice(0, 4);
  const localPurchase = looksLocalPurchase(plan.resolvedQuestion || transcript, plan);
  const localQueries = localPurchase ? uniqueQueries([
    ...buildDeterministicSearchQueries(plan.resolvedQuestion || transcript, history),
    plan.location ? `${plan.location} パソコン 店舗` : '',
  ], 2) : [];

  const supplementalStarted = Date.now();
  const [supplementalBatches, localBatches] = await Promise.all([
    supplementalQueries.length && remainingBudget(startedAt) > 2500
      ? Promise.all(supplementalQueries.map((query, index) => searchOne(query, fetchTimeoutMs, index < 2)))
      : Promise.resolve([]),
    localQueries.length
      ? Promise.all(localQueries.map((query) => searchOpenStreetMapLocal(query, { timeoutMs: Math.min(fetchTimeoutMs, 3500) }).catch(() => [])))
      : Promise.resolve([]),
  ]);
  timings.supplementalSearchMs = Date.now() - supplementalStarted;
  merged = dedupeResults([...merged, ...supplementalBatches.flat(), ...localBatches.flat()], 84);

  const rankQuestion = plan.resolvedQuestion || transcript;
  const rerankStarted = Date.now();
  let prelim = await rerankSearchResults(ai, rankQuestion, merged, 12, {
    signal: phaseSignal(signal, Math.min(1800, Math.max(500, remainingBudget(startedAt)))),
    timeoutMs: 1800,
  });
  timings.firstRerankMs = Date.now() - rerankStarted;

  const coverageStarted = Date.now();
  let coverage;
  if (remainingBudget(startedAt) > 800) {
    try {
      const coverageBudget = Math.min(SEARCH_COVERAGE_BUDGET_MS, Math.max(700, remainingBudget(startedAt)));
      coverage = await assessCoverage(ai, plan, prelim, phaseSignal(signal, coverageBudget));
    } catch {
      coverage = { sufficient: hasUsefulSearchEvidence(prelim, 6), reason: 'coverage_budget_fallback', queries: [] };
    }
  } else {
    coverage = { sufficient: hasUsefulSearchEvidence(prelim, 6), reason: 'coverage_skipped_for_budget', queries: [] };
  }
  timings.coverageMs = Date.now() - coverageStarted;

  let recovered = false;
  let rounds = 1;
  const needsRecovery = !coverage.sufficient
    || (shouldForceSecondPass(plan, rankQuestion) && !hasUsefulSearchEvidence(prelim, 6));

  if (SEARCH_MAX_ROUNDS > 1 && needsRecovery && remainingBudget(startedAt) > 3600) {
    const retryQueries = uniqueQueries([
      ...(coverage.queries || []),
      ...deterministicRecoveryQueries(plan, transcript, history),
    ], 3).filter((query) => !allQueries.some((old) => old.toLowerCase() === query.toLowerCase()));

    if (retryQueries.length) {
      const retryStarted = Date.now();
      const retryTimeout = Math.min(fetchTimeoutMs, Math.max(2600, remainingBudget(startedAt) - 800));
      const retryBatches = await Promise.all(retryQueries.map((query) => searchOne(query, retryTimeout, false)));
      timings.recoverySearchMs = Date.now() - retryStarted;
      merged = dedupeResults([...merged, ...retryBatches.flat()], 88);
      recovered = retryBatches.some((batch) => batch.length > 0);
      plan.queries = uniqueQueries([...(plan.queries || []), ...retryQueries], 12);
      rounds = 2;
    }
  }

  const finalRerankStarted = Date.now();
  const results = await rerankSearchResults(ai, rankQuestion, merged, 12, {
    signal: phaseSignal(signal, Math.min(1600, Math.max(400, remainingBudget(startedAt)))),
    timeoutMs: 1600,
  });
  timings.finalRerankMs = Date.now() - finalRerankStarted;
  timings.totalDeepSearchMs = Date.now() - startedAt;

  return {
    plan,
    rawResults: merged,
    results,
    recovered,
    rounds,
    coverage,
    evidenceUseful: hasUsefulSearchEvidence(results, 4),
    timings,
  };
}

function sanitizeProgressTopic(value) {
  const topic = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[「」『』"']/g, '')
    .replace(/^(?:検索対象|トピック|topic)[:：]\s*/i, '')
    .replace(/(?:について)?検索(?:しています|中です)?[。！!]?$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 52);
  return BAD_PROGRESS_TOPIC_RE.test(topic) ? '' : topic;
}

function fallbackProgressTopic(transcript, history) {
  const current = cleanQuery(transcript);
  const contextual = heuristicContextQuery(transcript, history);
  const source = (looksContextDependentFollowup(current) || GENERIC_RESEARCH_COMMAND_RE.test(current)) ? contextual : current;
  return sanitizeProgressTopic(source || current || 'ご相談の内容') || 'ご相談の内容';
}

function sanitizeFiller(value) {
  const text = String(value || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^今、.{2,52}について検索しています。少しお待ちください。$/u.test(text)) return text;
  const allowed = [
    '確認します。少し時間かかります。',
    '詳しく確認します。少し待ってください。',
    '検索をかけます。少し待ってください。',
    '前の話を踏まえて確認しています。少し待ってください。',
  ];
  return allowed.includes(text) ? text : '';
}

function wait(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error('aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('aborted'));
    }, { once: true });
  });
}

export async function generateSearchFiller(ai, transcript, history, signal) {
  const current = cleanQuery(transcript);
  const fallback = fallbackProgressTopic(transcript, history);
  const recent = recentConversation(history, 8);
  const contextualCommand = GENERIC_RESEARCH_COMMAND_RE.test(current) && Boolean(recent);

  const modelPromise = ai?.run
    ? ai.run(SEARCH_FILLER_MODEL, {
        messages: [
          {
            role: 'system',
            content: '検索本体は別処理です。あなたは待ち時間の案内だけ担当します。直前の会話と今回の発話から、今確認している対象を日本語で12〜32文字程度に要約してください。回答・推測・店名の新規生成は禁止。「検索内容が不明」「ご相談の内容」のような曖昧語は禁止。「調べて」が今回の発話なら、その語の意味ではなく直前の話題を要約してください。検索対象の短い名詞句だけを返してください。',
          },
          {
            role: 'user',
            content: `直近の会話:\n${recent || '(なし)'}\n\n今回の発話:\n${String(transcript || '').slice(0, 800)}`,
          },
        ],
        max_completion_tokens: 64,
        temperature: 0,
        reasoning_effort: null,
        chat_template_kwargs: { enable_thinking: false, clear_thinking: true },
      }, signal ? { signal } : undefined).catch(() => null)
    : Promise.resolve(null);

  const result = await Promise.race([
    modelPromise,
    wait(620, signal).then(() => null).catch(() => null),
  ]);
  await wait(SEARCH_FILLER_MIN_DELAY_MS, signal).catch(() => null);

  const topic = sanitizeProgressTopic(extractText(result));
  if (contextualCommand && (!topic || /調べ|検索内容|質問内容|内容不明|不明/.test(topic))) {
    return '前の話を踏まえて確認しています。少し待ってください。';
  }
  const chosen = topic || fallback;
  const phrase = `今、${chosen}について検索しています。少しお待ちください。`;
  return sanitizeFiller(phrase) || (contextualCommand
    ? '前の話を踏まえて確認しています。少し待ってください。'
    : `今、${fallback.slice(0, 52)}について検索しています。少しお待ちください。`);
}

export { parsePlannerJson, uniqueQueries, dedupeResults, sanitizeFiller, assessCoverage, parseCoverageJson };

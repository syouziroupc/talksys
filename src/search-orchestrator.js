import { webSearch, needsWebSearch, looksContextDependentFollowup } from './web-search.js';
import { rerankSearchResults } from './search-rerank.js';
import { extractText } from './voice-helpers.js';
import { GROUNDING_VOICE_MODEL, GROUNDING_FALLBACK_MODEL } from './streaming-workers-ai.js';
import {
  buildDeterministicSearchQueries,
  dedupeSearchResults,
  hasUsefulSearchEvidence,
  searchBingRss,
  searchOpenStreetMapLocal,
} from './search-fallbacks.js';

export const SEARCH_FILLER_MODEL = 'deterministic-safe-filler';
export const SEARCH_MAX_QUERIES = 8;
export const SEARCH_MAX_ROUNDS = 2;
export const SEARCH_FILLER_MIN_DELAY_MS = 1200;

const CONTEXT_SEARCH_CUE_RE = /(どこ|どっち|どちら|どれ|おすすめ|買|購入|店|店舗|販売|価格|値段|在庫|営業時間|比較|評判|今|現在|最新|調べ|検索|本当|事実|仕様|法律|制度|ニュース)/i;
const EXTERNAL_CONTEXT_RE = /(パソコン|PC|ノート|iPhone|Android|Windows|Mac|製品|商品|店|店舗|会社|企業|大学|病院|ホテル|飲食|法律|制度|ニュース|価格|在庫|営業時間|市|区|町|村|県|都|府|道|Amazon|楽天|Yahoo|Google|Microsoft|Apple|Cloudflare)/i;
const HIGH_VERIFICATION_RE = /(価格|値段|在庫|営業時間|今日|現在|最新|販売中|発売|法律|制度|時刻|予定|日程|店|店舗|販売店|買う|購入先|どこで買)/i;

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
  if (current.length >= 48 && !looksContextDependentFollowup(current)) return current;

  const context = usefulHistoryForFallback(history)
    .map((item) => cleanQuery(item.content))
    .filter(Boolean)
    .slice(-5)
    .join(' ');

  if (!context) return current;
  return cleanQuery(`${context} ${current}`);
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
        content: `あなたは日本語会話用のWeb調査プランナーです。速さより検索精度を優先します。今回の発話を直前の会話から自己完結した調査課題へ復元し、検索エンジン向けクエリを6〜8本作ってください。\n\n必須ルール:\n- 「それ」「どこがいい？」「調べてくれない？」「別府市内なら？」などの省略は直前のuser/assistant会話から対象だけ復元する。assistantの過去回答は事実根拠にはしない。\n- ユーザーが出した予算、用途、地域、型番、日時、数量、条件を落とさない。\n- 同じ語順の言い換えだけを量産しない。検索意図を分解する。\n- 最低でも、広い探索1本、一次情報/公式1〜2本、独立した確認1本、比較/評判1本を含める。\n- 地域店舗なら「地域 商品 販売店」「地域 商品 家電量販店/専門店」「地域 商品 店舗 公式」のように複数角度で探す。\n- 価格・在庫・営業時間・法律・現行仕様・ニュースは${year}年の現在性を意識し、公式/一次情報を必ず探す。\n- 商品購入では、存在確認と価格/在庫確認を別クエリに分ける。\n- 実在を確認していない固有名詞を検索語に新規生成しない。\n- 検索語は日本語検索で自然な短い語句にする。\n\nJSONだけを返す。形式: {"resolved_question":"自己完結した調査課題","intent":"local_purchase|shopping|current_fact|general_fact|comparison|news|other","location":"地域または空文字","must_include":["絶対に落とせない条件"],"queries":["検索語1","検索語2","...最大8"]}`,
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
  const models = [...new Set([GROUNDING_VOICE_MODEL, GROUNDING_FALLBACK_MODEL].filter(Boolean))];
  for (const model of models) {
    try {
      const planned = await runPlannerModel(ai, model, transcript, history, signal);
      if (!planned) continue;
      const resolvedQuestion = planned.resolvedQuestion || fallbackQuestion;
      const deterministic = buildDeterministicSearchQueries(resolvedQuestion, history);
      const queries = uniqueQueries([
        ...planned.queries.slice(0, 4),
        ...deterministic,
        ...planned.queries.slice(4),
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
  const models = [...new Set([GROUNDING_VOICE_MODEL, GROUNDING_FALLBACK_MODEL].filter(Boolean))];
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

export async function runDeepSearch(ai, transcript, history, signal, options = {}) {
  const plan = await planSearchQueries(ai, transcript, history, signal);
  const queries = plan.queries.length ? plan.queries : [plan.resolvedQuestion || transcript];
  const timeoutMs = Math.max(3600, Math.min(10000, Number(options.timeoutMs) || 7600));

  const firstBatches = await Promise.all(
    queries.map((query, index) => searchOne(query, timeoutMs, index < 3)),
  );
  let merged = dedupeResults(firstBatches.flat(), 64);
  let prelim = await rerankSearchResults(ai, plan.resolvedQuestion || transcript, merged, 12);
  let coverage = await assessCoverage(ai, plan, prelim, signal);
  let recovered = false;
  let rounds = 1;

  if (SEARCH_MAX_ROUNDS > 1 && (!coverage.sufficient || shouldForceSecondPass(plan, plan.resolvedQuestion))) {
    const retryQueries = uniqueQueries([
      ...(coverage.queries || []),
      ...deterministicRecoveryQueries(plan, transcript, history),
    ], 4).filter((query) => !(plan.queries || []).some((old) => old.toLowerCase() === query.toLowerCase()));

    if (retryQueries.length) {
      const retryBatches = await Promise.all(
        retryQueries.map((query, index) => searchOne(query, timeoutMs, index < 2)),
      );
      merged = dedupeResults([...merged, ...retryBatches.flat()], 80);
      recovered = retryBatches.some((batch) => batch.length > 0);
      plan.queries = uniqueQueries([...(plan.queries || []), ...retryQueries], 12);
      prelim = await rerankSearchResults(ai, plan.resolvedQuestion || transcript, merged, 14);
      coverage = await assessCoverage(ai, plan, prelim, signal);
      rounds = 2;
    }
  }

  if (looksLocalPurchase(plan.resolvedQuestion || transcript, plan)) {
    const localQueries = uniqueQueries([
      ...buildDeterministicSearchQueries(plan.resolvedQuestion || transcript, history),
      plan.location ? `${plan.location} パソコン 店舗` : '',
    ], 3);
    const local = await Promise.all(localQueries.map((query) => searchOpenStreetMapLocal(query, { timeoutMs }).catch(() => [])));
    merged = dedupeResults([...merged, ...local.flat()], 84);
  }

  const rankQuestion = plan.resolvedQuestion || transcript;
  const results = await rerankSearchResults(ai, rankQuestion, merged, 12);

  return {
    plan,
    rawResults: merged,
    results,
    recovered,
    rounds,
    coverage,
    evidenceUseful: hasUsefulSearchEvidence(results, 4),
  };
}

function sanitizeFiller(value) {
  const text = String(value || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  const allowed = [
    '確認します。少し時間かかります。',
    '詳しく確認します。少し待ってください。',
    '検索をかけます。少し待ってください。',
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

export async function generateSearchFiller(_ai, _transcript, _history, signal) {
  await wait(SEARCH_FILLER_MIN_DELAY_MS, signal).catch(() => {});
  return '詳しく確認します。少し待ってください。';
}

export { parsePlannerJson, uniqueQueries, dedupeResults, sanitizeFiller, assessCoverage, parseCoverageJson };

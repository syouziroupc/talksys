import { webSearch } from './web-search.js';
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

export const SEARCH_FILLER_MODEL = '@cf/meta/llama-3.2-3b-instruct';
export const SEARCH_MAX_QUERIES = 3;
export const SEARCH_FILLER_MIN_DELAY_MS = 650;

function recentConversation(history, limit = 8) {
  if (!Array.isArray(history)) return '';
  return history
    .slice(-limit)
    .filter((item) => item && (item.role === 'user' || item.role === 'assistant'))
    .map((item) => `${item.role}: ${String(item.content || '').slice(0, 700)}`)
    .join('\n');
}

function cleanQuery(value) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/^[\s"'「『]+|[\s"'」』]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

function uniqueQueries(values, limit = SEARCH_MAX_QUERIES) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const query = cleanQuery(value);
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
      if (resolvedQuestion || queries.length) return { resolvedQuestion, queries };
    } catch {}
  }
  return null;
}

function usefulHistoryForFallback(history) {
  if (!Array.isArray(history)) return [];
  return history
    .slice(-10)
    .filter((item) => item && (item.role === 'user' || item.role === 'assistant'))
    .filter((item) => {
      const text = String(item.content || '');
      if (item.role !== 'assistant') return true;
      return !/(検索結果|裏付けが十分|ご提示いただいた|情報源を提示|調べ直します|確認できませんでした)/i.test(text);
    })
    .slice(-5);
}

export function heuristicContextQuery(transcript, history) {
  const current = cleanQuery(transcript);
  if (!current) return '';
  if (current.length >= 38) return current;

  const context = usefulHistoryForFallback(history)
    .map((item) => cleanQuery(item.content))
    .filter(Boolean)
    .slice(-4)
    .join(' ');

  if (!context) return current;
  return cleanQuery(`${context} ${current}`);
}

async function runPlannerModel(ai, model, transcript, history, signal) {
  const recent = recentConversation(history);
  const result = await ai.run(model, {
    messages: [
      {
        role: 'system',
        content: `日本語会話のWeb検索プランナー。今回の質問を直前の会話から自己完結した検索課題に直し、検索エンジン向けクエリを2〜3本作る。\nルール:\n- 「それ」「どこ」「大阪は？」「調べてくれない？」のような省略は、直前のuser/assistant会話から話題だけを復元する。\n- assistantの過去回答を事実とはみなさないが、「パソコンの話」「予算3万円の話」など検索対象の特定には使ってよい。\n- 予算、用途、地域、型番、日時などユーザーが示した制約を落とさない。\n- 現在情報・価格・在庫・交通・営業時間は、公式/一次情報を探すクエリを最低1本含める。\n- おすすめ・購入先・比較では、公式だけでなく販売店・比較・レビュー等を拾うクエリも1本含める。\n- 地域の店を探す質問では「地域名 商品名 販売店」「地域名 商品名 家電量販店/専門店」のように具体化する。\n- 存在しない固有名詞や条件を作らない。\nJSONだけを返す。形式: {"resolved_question":"自己完結した質問","queries":["検索語1","検索語2","検索語3"]}`,
      },
      {
        role: 'user',
        content: `直近の会話:\n${recent || '(なし)'}\n\n今回の発話:\n${String(transcript || '').slice(0, 900)}`,
      },
    ],
    max_completion_tokens: 240,
    temperature: 0.04,
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
        resolvedQuestion,
        deterministic[0],
        planned.queries[0],
        deterministic[1],
        planned.queries[1],
        planned.queries[2],
      ]);
      if (queries.length) return { resolvedQuestion, queries, plannerModel: model, planned: true };
    } catch {}
  }
  const deterministic = buildDeterministicSearchQueries(fallbackQuestion || transcript, history);
  const queries = uniqueQueries([fallbackQuestion, ...deterministic, transcript]);
  return { resolvedQuestion: fallbackQuestion || cleanQuery(transcript), queries, plannerModel: null, planned: false };
}

function dedupeResults(results, limit = 32) {
  return dedupeSearchResults(results, limit);
}

function looksLocalPurchase(question) {
  const value = String(question || '');
  return /(?:都|道|府|県|市|区|町|村).*(?:買|購入|販売店|店舗|店|家電量販店|中古)/i.test(value)
    || /(?:買|購入|販売店|店舗|店|家電量販店|中古).*(?:都|道|府|県|市|区|町|村)/i.test(value);
}

async function searchOne(query, timeoutMs, enrichPages) {
  const [htmlResults, rssResults] = await Promise.all([
    webSearch(query, { limit: 8, timeoutMs, enrichPages }).catch(() => []),
    searchBingRss(query, { limit: 8, timeoutMs }).catch(() => []),
  ]);
  return dedupeResults([...htmlResults, ...rssResults], 16);
}

function recoveryQueries(plan, transcript, history) {
  const resolved = plan?.resolvedQuestion || transcript;
  const deterministic = buildDeterministicSearchQueries(resolved, history);
  const extras = [];
  for (const query of deterministic) {
    extras.push(query);
    if (/販売店|店舗|家電量販店|専門店/.test(query)) extras.push(`${query} 公式 店舗一覧`);
  }
  if (resolved) {
    extras.push(`${resolved} 販売店`);
    extras.push(`${resolved} 店舗 公式`);
  }
  const existing = new Set((plan?.queries || []).map((item) => cleanQuery(item).toLowerCase()));
  return uniqueQueries(extras.filter((item) => !existing.has(cleanQuery(item).toLowerCase())), 4);
}

export async function runDeepSearch(ai, transcript, history, signal, options = {}) {
  const plan = await planSearchQueries(ai, transcript, history, signal);
  const queries = plan.queries.length ? plan.queries : [plan.resolvedQuestion || transcript];
  const timeoutMs = Math.max(2600, Math.min(8500, Number(options.timeoutMs) || 6200));

  const firstBatches = await Promise.all(
    queries.map((query, index) => searchOne(query, timeoutMs, index < 2)),
  );
  let merged = dedupeResults(firstBatches.flat(), 32);
  let recovered = false;

  if (!hasUsefulSearchEvidence(merged, 4)) {
    const retryQueries = recoveryQueries(plan, transcript, history);
    if (retryQueries.length) {
      const retryBatches = await Promise.all(
        retryQueries.map((query, index) => searchOne(query, timeoutMs, index === 0)),
      );
      merged = dedupeResults([...merged, ...retryBatches.flat()], 40);
      recovered = retryBatches.some((batch) => batch.length > 0);
      plan.queries = uniqueQueries([...(plan.queries || []), ...retryQueries], 6);
    }
  }

  if (looksLocalPurchase(plan.resolvedQuestion || transcript)) {
    const localQueries = buildDeterministicSearchQueries(plan.resolvedQuestion || transcript, history).slice(0, 2);
    const local = await Promise.all(localQueries.map((query) => searchOpenStreetMapLocal(query, { timeoutMs }).catch(() => [])));
    merged = dedupeResults([...merged, ...local.flat()], 40);
  }

  const rankQuestion = plan.resolvedQuestion || transcript;
  const results = await rerankSearchResults(ai, rankQuestion, merged, 8);

  return {
    plan,
    rawResults: merged,
    results,
    recovered,
    evidenceUseful: hasUsefulSearchEvidence(results, 2),
  };
}

function sanitizeFiller(value) {
  let text = String(value || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/^[\s"'「『]+|[\s"'」』]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  const first = text.match(/^.*?[。！？!?…]/)?.[0] || text;
  text = first.slice(0, 28).trim();
  if (/(答え|結論|価格は|あります|ありません|です$)/.test(text) && !/(確認|調べ|見て|探して)/.test(text)) return '';
  return text;
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
  const started = Date.now();
  let phrase = '';
  try {
    const recent = recentConversation(history, 4);
    const result = await ai.run(SEARCH_FILLER_MODEL, {
      messages: [
        {
          role: 'system',
          content: '電話会話で検索待ちの間に入れる、ごく短い自然なつなぎを1つだけ作る。答えや事実は絶対に言わない。「えーと…」「うーん、見てみますね」「ちょっと待ってくださいね」程度。毎回「ちょっと調べますね」に固定しない。説明、Markdown、URLは禁止。日本語のみ。',
        },
        {
          role: 'user',
          content: `会話:\n${recent || '(なし)'}\n今回: ${String(transcript || '').slice(0, 350)}`,
        },
      ],
      max_tokens: 24,
      temperature: 0.82,
      top_p: 0.92,
    }, signal ? { signal } : undefined);
    phrase = sanitizeFiller(extractText(result));
  } catch {}

  const elapsed = Date.now() - started;
  if (elapsed < SEARCH_FILLER_MIN_DELAY_MS) await wait(SEARCH_FILLER_MIN_DELAY_MS - elapsed, signal).catch(() => {});
  return phrase || 'えーと…見てみますね。';
}

export { parsePlannerJson, uniqueQueries, dedupeResults, sanitizeFiller };

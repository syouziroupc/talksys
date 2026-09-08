import { webSearch } from './web-search.js';
import { rerankSearchResults } from './search-rerank.js';
import { extractText } from './voice-helpers.js';
import { GROUNDING_VOICE_MODEL, GROUNDING_FALLBACK_MODEL } from './streaming-workers-ai.js';

export const SEARCH_FILLER_MODEL = '@cf/meta/llama-3.2-3b-instruct';
export const SEARCH_MAX_QUERIES = 3;

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

function uniqueQueries(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const query = cleanQuery(value);
    if (query.length < 2) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(query);
    if (out.length >= SEARCH_MAX_QUERIES) break;
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

export function heuristicContextQuery(transcript, history) {
  const current = cleanQuery(transcript);
  if (!current) return '';
  const recentUsers = Array.isArray(history)
    ? history.slice(-8).filter((item) => item?.role === 'user').map((item) => cleanQuery(item.content)).filter(Boolean)
    : [];
  const context = recentUsers.slice(-2).join(' ');
  if (!context || current.length >= 35) return current;
  return cleanQuery(`${context} ${current}`);
}

async function runPlannerModel(ai, model, transcript, history, signal) {
  const recent = recentConversation(history);
  const result = await ai.run(model, {
    messages: [
      {
        role: 'system',
        content: `日本語会話のWeb検索プランナー。今回の質問を直前の会話から自己完結した検索課題に直し、検索エンジン向けクエリを2〜3本作る。\nルール:\n- 「それ」「どこ」「大阪は？」など省略された対象は会話から復元する。\n- 予算、用途、地域、型番、日時などユーザーが示した制約を落とさない。\n- 現在情報・価格・在庫・交通・営業時間は、公式/一次情報を探すクエリを最低1本含める。\n- おすすめ・購入先・比較では、公式だけでなく販売店・比較・レビュー等を拾うクエリも1本含める。\n- 会話履歴は検索対象を解決するためだけに使い、過去のassistant発言を事実として検索結果に混ぜない。\n- 存在しない固有名詞や条件を作らない。\nJSONだけを返す。形式: {"resolved_question":"自己完結した質問","queries":["検索語1","検索語2","検索語3"]}`,
      },
      {
        role: 'user',
        content: `直近の会話:\n${recent || '(なし)'}\n\n今回の発話:\n${String(transcript || '').slice(0, 900)}`,
      },
    ],
    max_completion_tokens: 220,
    temperature: 0.05,
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
      const queries = uniqueQueries([resolvedQuestion, ...planned.queries]);
      if (queries.length) return { resolvedQuestion, queries, plannerModel: model, planned: true };
    } catch {}
  }
  const queries = uniqueQueries([fallbackQuestion, transcript]);
  return { resolvedQuestion: fallbackQuestion || cleanQuery(transcript), queries, plannerModel: null, planned: false };
}

function dedupeResults(results, limit = 24) {
  const seen = new Set();
  const out = [];
  for (const item of results || []) {
    if (!item?.url) continue;
    let key = String(item.url).replace(/[?#].*$/, '').replace(/\/$/, '');
    try {
      const url = new URL(item.url);
      key = `${url.hostname.toLowerCase()}${url.pathname}`.replace(/\/$/, '');
    } catch {}
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

export async function runDeepSearch(ai, transcript, history, signal, options = {}) {
  const plan = await planSearchQueries(ai, transcript, history, signal);
  const queries = plan.queries.length ? plan.queries : [plan.resolvedQuestion || transcript];
  const timeoutMs = Math.max(2200, Math.min(5000, Number(options.timeoutMs) || 3600));

  const searches = queries.map((query, index) => webSearch(query, {
    limit: index === 0 ? 8 : 6,
    timeoutMs,
    enrichPages: index === 0,
  }).catch(() => []));
  const batches = await Promise.all(searches);
  const merged = dedupeResults(batches.flat(), 24);
  const rankQuestion = plan.resolvedQuestion || transcript;
  const results = await rerankSearchResults(ai, rankQuestion, merged, 6);

  return {
    plan,
    rawResults: merged,
    results,
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
  const first = text.match(/^.*?[。！？!?]/)?.[0] || text;
  text = first.slice(0, 42).trim();
  if (/(答え|結論|価格は|あります|ありません|です$)/.test(text) && !/(確認|調べ|見て|探して)/.test(text)) return '';
  return text;
}

export async function generateSearchFiller(ai, transcript, history, signal) {
  try {
    const recent = recentConversation(history, 4);
    const result = await ai.run(SEARCH_FILLER_MODEL, {
      messages: [
        {
          role: 'system',
          content: '電話会話でWeb検索が終わるまでの短い自然なつなぎ発話を1文だけ作る。事実・答え・検索結果は絶対に言わない。「えーと、ちょっと見てみますね。」「うーん、少し確認しますね。」程度の長さ。毎回同じ文に固定しない。Markdown、URL、説明は禁止。日本語のみ。',
        },
        {
          role: 'user',
          content: `会話:\n${recent || '(なし)'}\n今回: ${String(transcript || '').slice(0, 350)}`,
        },
      ],
      max_tokens: 28,
      temperature: 0.75,
      top_p: 0.9,
    }, signal ? { signal } : undefined);
    return sanitizeFiller(extractText(result)) || 'えーと、ちょっと見てみますね。';
  } catch {
    return 'えーと、ちょっと見てみますね。';
  }
}

export { parsePlannerJson, uniqueQueries, dedupeResults, sanitizeFiller };

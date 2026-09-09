import { relevanceScore, webSearch } from './web-search.js';
import { rerankSearchResults } from './search-rerank.js';
import {
  buildDeterministicSearchQueries,
  dedupeSearchResults,
  hasUsefulSearchEvidence,
  searchBingRss,
  searchOpenStreetMapLocal,
} from './search-fallbacks.js';

export const SEARCH_V44_REVISION = 'deep-search-v44-default-exhaustive-budget-aware';
export const SEARCH_V44_MAX_QUERIES = 14;
export const SEARCH_V44_MAX_RECOVERY_QUERIES = 5;
export const SEARCH_V44_MAX_TOTAL_QUERIES = SEARCH_V44_MAX_QUERIES + SEARCH_V44_MAX_RECOVERY_QUERIES;
export const SEARCH_V44_MAX_ROUNDS = 3;
export const SEARCH_V44_SOURCE_LIMIT = 18;
export const SEARCH_V44_TOTAL_BUDGET_MS = 28000;
export const SEARCH_V44_QUERY_TIMEOUT_MS = 6500;
export const SEARCH_V44_RSS_CONCURRENCY = 4;
// Approximate external-fetch target before HTTP redirect hops: 14 RSS + 6-engine cross-check +
// 3 direct page reads + up to 2 local lookups + 5 recovery RSS = about 30.
// This intentionally leaves headroom below Workers Free's 50 external-subrequest ceiling.
export const SEARCH_V44_EXTERNAL_SUBREQUEST_BASE_TARGET = 30;

const PLANNER_MODEL = '@cf/zai-org/glm-5.3-flash';
const CURRENT_OR_HIGH_STAKES_RE = /(最新|現在|今日|明日|今|価格|値段|在庫|営業時間|法律|制度|規制|ニュース|発売|販売|予定|日程|時刻|時刻表|天気|株価|為替|相場|選挙|首相|大統領|CEO|仕様|バージョン|アップデート)/i;
const LOCAL_RE = /(?:都|道|府|県|市|区|町|村).*(?:店|店舗|販売店|病院|ホテル|飲食|行き方|アクセス|近く|周辺)|(?:店|店舗|販売店|病院|ホテル|飲食|近く|周辺).*(?:都|道|府|県|市|区|町|村)/i;
const SHOPPING_RE = /(買|購入|おすすめ|比較|価格|値段|在庫|販売店|店舗|通販|中古|新品|製品|商品)/i;

function clean(value, max = 4000) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function readModelText(result) {
  if (typeof result === 'string') return clean(result, 12000);
  if (!result) return '';
  for (const value of [result.response, result.result, result.text, result.output_text]) {
    if (typeof value === 'string' && value.trim()) return clean(value, 12000);
  }
  const content = result.choices?.[0]?.message?.content;
  if (typeof content === 'string') return clean(content, 12000);
  if (Array.isArray(content)) return clean(content.map((x) => typeof x === 'string' ? x : (x?.text || x?.content || '')).join(' '), 12000);
  return clean(result.choices?.[0]?.text || '', 12000);
}

function userHistory(history, limit = 10) {
  return Array.isArray(history)
    ? history.filter((x) => x && x.role === 'user' && clean(x.content)).slice(-limit)
    : [];
}

function contextHistory(history, limit = 12) {
  return Array.isArray(history)
    ? history.filter((x) => x && (x.role === 'user' || x.role === 'assistant') && clean(x.content)).slice(-limit)
    : [];
}

function fallbackResolvedQuestion(text, history) {
  const current = clean(text, 1800);
  if (!current) return '';
  if (current.length >= 42) return current;
  const users = userHistory(history, 6).map((x) => clean(x.content, 700)).filter(Boolean);
  if (!users.length) return current;
  return clean(`${users.slice(-4).join(' ')} ${current}`, 2200);
}

function uniqueQueries(values, limit = SEARCH_V44_MAX_QUERIES) {
  const seen = new Set();
  const out = [];
  for (const raw of values || []) {
    const q = clean(typeof raw === 'string' ? raw : raw?.q, 320);
    if (q.length < 2) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length >= limit) break;
  }
  return out;
}

function parseJsonObject(text) {
  const raw = String(text || '').trim();
  const candidate = raw.match(/\{[\s\S]*\}/)?.[0] || raw;
  try { return JSON.parse(candidate); } catch { return null; }
}

function deterministicQueries(resolved, history) {
  const base = buildDeterministicSearchQueries(resolved, history) || [];
  const year = new Date().getFullYear();
  const extra = [resolved, `${resolved} 公式`, `${resolved} 一次情報`, `${resolved} 比較`, `${resolved} ${year}`];
  if (SHOPPING_RE.test(resolved)) extra.push(`${resolved} 販売 価格`, `${resolved} 評判 比較`);
  if (CURRENT_OR_HIGH_STAKES_RE.test(resolved)) extra.push(`${resolved} 最新 公式 ${year}`);
  return uniqueQueries([...base, ...extra], SEARCH_V44_MAX_QUERIES);
}

async function planDeepSearch(ai, text, history, signal) {
  const fallback = fallbackResolvedQuestion(text, history);
  const recent = contextHistory(history).map((x) => `${x.role}: ${clean(x.content, 900)}`).join('\n');
  const year = new Date().getFullYear();
  try {
    const result = await ai.run(PLANNER_MODEL, {
      messages: [
        {
          role: 'system',
          content: `あなたはTalkSysのWeb調査プランナーです。検索量を惜しまず、回答に必要な根拠を徹底的に集めます。今回の発話を直前の会話から自己完結した調査課題へ復元し、重複しない検索語を10〜14本作ってください。\n\n必須:\n- ユーザーが述べた地域、予算、型番、日時、用途、数量、除外条件を落とさない。\n- assistantの過去発言は対象復元には使えるが、外部事実の根拠にはしない。\n- 広い探索、公式/一次情報、独立した別ソース、比較/反証、現在性確認を分けて検索する。\n- 価格・在庫・法律・制度・時刻・ニュース・現行仕様など変動情報は${year}年の現在性を確認する。\n- 購入相談は候補発見、価格、販売元、仕様、評判を別クエリにする。\n- 地域相談は地域名を省略しない。\n- 実在未確認の固有名詞を新しく作らない。\n- 同じ検索語の語順違いだけを量産しない。\n\nJSONだけを返す: {"resolved_question":"...","intent":"shopping|local|current|comparison|general|news|other","location":"...","must_include":["..."],"queries":["...最大14"]}`,
        },
        { role: 'user', content: `直近の会話:\n${recent || '(なし)'}\n\n今回の発話:\n${clean(text, 1800)}` },
      ],
      stream: false,
      max_completion_tokens: 900,
      temperature: 0.02,
      reasoning_effort: 'low',
    }, signal ? { signal } : undefined);
    const data = parseJsonObject(readModelText(result));
    if (data && typeof data === 'object') {
      const resolvedQuestion = clean(data.resolved_question || data.resolvedQuestion || fallback, 2200) || fallback;
      const planned = Array.isArray(data.queries) ? data.queries : [];
      const queries = uniqueQueries([...planned, ...deterministicQueries(resolvedQuestion, history)], SEARCH_V44_MAX_QUERIES);
      if (queries.length) {
        return {
          resolvedQuestion,
          intent: clean(data.intent || '', 40) || (CURRENT_OR_HIGH_STAKES_RE.test(resolvedQuestion) ? 'current' : 'general'),
          location: clean(data.location || '', 100),
          mustInclude: Array.isArray(data.must_include || data.mustInclude) ? (data.must_include || data.mustInclude).map((x) => clean(x, 180)).filter(Boolean).slice(0, 10) : [],
          queries,
          planned: true,
          plannerModel: PLANNER_MODEL,
        };
      }
    }
  } catch {}
  return {
    resolvedQuestion: fallback,
    intent: CURRENT_OR_HIGH_STAKES_RE.test(fallback) ? 'current' : (SHOPPING_RE.test(fallback) ? 'shopping' : 'general'),
    location: '',
    mustInclude: [],
    queries: deterministicQueries(fallback, history),
    planned: false,
    plannerModel: null,
  };
}

async function runRssQueries(queries, timeoutMs) {
  const list = uniqueQueries(queries, SEARCH_V44_MAX_QUERIES);
  const out = [];
  for (let offset = 0; offset < list.length; offset += SEARCH_V44_RSS_CONCURRENCY) {
    const batch = list.slice(offset, offset + SEARCH_V44_RSS_CONCURRENCY);
    const settled = await Promise.allSettled(batch.map((q) => searchBingRss(q, { limit: 12, timeoutMs })));
    out.push(...settled.flatMap((x) => x.status === 'fulfilled' && Array.isArray(x.value) ? x.value : []));
  }
  return out;
}

async function runQueryBatch(queries, options = {}) {
  const list = uniqueQueries(queries, SEARCH_V44_MAX_QUERIES);
  if (!list.length) return [];
  const rss = await runRssQueries(list, options.timeoutMs);
  let crossEngine = [];
  if (options.multiEngine === true) {
    // One representative query gets the expensive Google/DDG/Bing/Wikipedia/News cross-check.
    // All other planned questions still run through RSS, preserving breadth without exhausting
    // Workers Free external-subrequest allowance.
    crossEngine = await webSearch(list[0], {
      limit: 12,
      timeoutMs: options.timeoutMs,
      enrichPages: false,
    }).catch(() => []);
  }
  return dedupeSearchResults([...crossEngine, ...rss], 120);
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function stripHtml(value) {
  return decodeEntities(String(value || ''))
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractPageExcerpt(html) {
  const source = String(html || '');
  const meta = source.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/i)
    || source.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description)["']/i);
  const paragraphs = [];
  for (const match of source.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = stripHtml(match[1]);
    if (text.length < 35) continue;
    paragraphs.push(text);
    if (paragraphs.join(' ').length >= 3500) break;
  }
  return [meta ? decodeEntities(meta[1]) : '', ...paragraphs].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 4200);
}

async function enrichOne(item, timeoutMs) {
  if (!/^https?:\/\//i.test(item?.url || '')) return item;
  try {
    const response = await fetch(item.url, {
      redirect: 'follow',
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'ja,en;q=0.7',
        'user-agent': 'TalkSys/44 (+https://talksys.syouziroupc.workers.dev)',
      },
      signal: AbortSignal.timeout(Math.min(4200, timeoutMs)),
    });
    if (!response.ok) return item;
    const type = response.headers.get('content-type') || '';
    if (!/(?:text|html)/i.test(type)) return item;
    const html = (await response.text()).slice(0, 500000);
    const excerpt = extractPageExcerpt(html);
    return excerpt ? { ...item, excerpt, engine: item.engine ? `${item.engine}+page` : 'page-direct-v44' } : item;
  } catch {
    return item;
  }
}

async function enrichTopResults(results, question, ai, signal, timeoutMs, count = 3) {
  if (!Array.isArray(results) || !results.length || count <= 0) return results || [];
  const candidates = await rerankSearchResults(ai, question, results, Math.min(6, Math.max(count, 4)), { signal, timeoutMs: 2200 });
  const targets = candidates.slice(0, count);
  const enriched = await Promise.all(targets.map((item) => enrichOne(item, timeoutMs)));
  const byUrl = new Map(enriched.map((item) => [item.url, item]));
  return (results || []).map((item) => byUrl.get(item.url) || item);
}

async function rankExpanded(ai, question, results, signal, limit = SEARCH_V44_SOURCE_LIMIT) {
  const unique = dedupeSearchResults(results, 120)
    .map((item) => ({ item, score: relevanceScore(question, item) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item)
    .slice(0, 72);
  if (unique.length <= 6) return unique.slice(0, limit);

  const modelRanked = [];
  for (let offset = 0; offset < unique.length && modelRanked.length < Math.min(limit, 12); offset += 24) {
    const chunk = unique.slice(offset, offset + 24);
    const ranked = await rerankSearchResults(ai, question, chunk, 6, { signal, timeoutMs: 2500 });
    modelRanked.push(...ranked);
  }
  const selectedUrls = new Set(modelRanked.map((x) => x.url));
  const supplements = unique.filter((x) => !selectedUrls.has(x.url));
  return dedupeSearchResults([...modelRanked, ...supplements], limit);
}

function evidenceSummary(results, limit = SEARCH_V44_SOURCE_LIMIT) {
  return (results || []).slice(0, limit).map((item, index) => {
    let host = '';
    try { host = new URL(item?.url || '').hostname.replace(/^www\./, ''); } catch {}
    return `[${index + 1}] ${clean(item?.title, 220)}\n${host}\n${clean(item?.excerpt || item?.snippet, 1200)}`;
  }).join('\n\n');
}

async function assessCoverage(ai, plan, results, history, signal) {
  if (!results?.length) return { sufficient: false, reason: 'no_results', queries: deterministicQueries(plan.resolvedQuestion, history).slice(0, SEARCH_V44_MAX_RECOVERY_QUERIES) };
  try {
    const result = await ai.run(PLANNER_MODEL, {
      messages: [
        {
          role: 'system',
          content: 'Web調査の十分性を厳しく監査します。回答は書かず、主要な主張を複数ソースで支えられるか、現在情報に一次情報または信頼できる根拠があるか、質問の条件を落としていないかを確認してください。不足があれば既存検索と重複しない追加検索語を最大5本作ってください。JSONだけ: {"sufficient":true|false,"reason":"...","queries":["..."]}',
        },
        {
          role: 'user',
          content: `調査課題: ${plan.resolvedQuestion}\n意図: ${plan.intent}\n地域: ${plan.location || '(なし)'}\n必須条件: ${(plan.mustInclude || []).join(' / ') || '(なし)'}\n検索済み: ${(plan.queries || []).join(' / ')}\n\n上位根拠:\n${evidenceSummary(results)}`,
        },
      ],
      stream: false,
      max_completion_tokens: 420,
      temperature: 0.01,
      reasoning_effort: 'low',
    }, signal ? { signal } : undefined);
    const data = parseJsonObject(readModelText(result));
    if (data && typeof data === 'object') {
      return {
        sufficient: data.sufficient === true,
        reason: clean(data.reason || '', 300),
        queries: uniqueQueries(Array.isArray(data.queries) ? data.queries : [], SEARCH_V44_MAX_RECOVERY_QUERIES),
      };
    }
  } catch {}
  return { sufficient: hasUsefulSearchEvidence(results, 7), reason: 'coverage_model_unavailable', queries: [] };
}

function recoveryQueries(plan, history) {
  const resolved = plan.resolvedQuestion;
  return uniqueQueries([
    `${resolved} 公式 詳細`,
    `${resolved} 一次情報`,
    `${resolved} 別ソース`,
    `${resolved} 反証 問題`,
    `${resolved} 比較 評判`,
    ...deterministicQueries(resolved, history),
  ], SEARCH_V44_MAX_RECOVERY_QUERIES);
}

function shouldForceThirdRound(plan) {
  return ['shopping', 'local', 'current', 'comparison', 'news'].includes(String(plan?.intent || ''))
    || CURRENT_OR_HIGH_STAKES_RE.test(plan?.resolvedQuestion || '');
}

export async function runDeepSearchV44(ai, text, history = [], signal, options = {}) {
  const startedAt = Date.now();
  const timings = {};
  const maxBudgetMs = Math.max(12000, Math.min(45000, Number(options.totalBudgetMs) || SEARCH_V44_TOTAL_BUDGET_MS));
  const queryTimeoutMs = Math.max(3500, Math.min(9000, Number(options.queryTimeoutMs) || SEARCH_V44_QUERY_TIMEOUT_MS));
  const planStarted = Date.now();
  const plan = await planDeepSearch(ai, text, history, signal);
  timings.plannerMs = Date.now() - planStarted;

  const plannedQueries = uniqueQueries(plan.queries, SEARCH_V44_MAX_QUERIES);
  const first = plannedQueries.slice(0, 7);
  const second = plannedQueries.slice(7, 14);
  const allQueries = [...first];

  const round1Started = Date.now();
  let merged = await runQueryBatch(first, { timeoutMs: queryTimeoutMs, multiEngine: true });
  merged = await enrichTopResults(merged, plan.resolvedQuestion, ai, signal, queryTimeoutMs, 3);
  timings.round1Ms = Date.now() - round1Started;
  let rounds = 1;

  if (second.length && Date.now() - startedAt < maxBudgetMs - 4500) {
    const round2Started = Date.now();
    const round2 = await runQueryBatch(second, { timeoutMs: queryTimeoutMs, multiEngine: false });
    merged = dedupeSearchResults([...merged, ...round2], 140);
    allQueries.push(...second);
    timings.round2Ms = Date.now() - round2Started;
    rounds = 2;
  }

  if ((plan.intent === 'local' || LOCAL_RE.test(plan.resolvedQuestion)) && Date.now() - startedAt < maxBudgetMs - 3500) {
    const localQueries = uniqueQueries([
      plan.location ? `${plan.location} ${plan.resolvedQuestion}` : plan.resolvedQuestion,
      plan.location ? `${plan.location} 店舗` : '',
    ], 2);
    const localStarted = Date.now();
    const settled = await Promise.allSettled(localQueries.map((q) => searchOpenStreetMapLocal(q, { timeoutMs: Math.min(5000, queryTimeoutMs) })));
    merged = dedupeSearchResults([...merged, ...settled.flatMap((x) => x.status === 'fulfilled' && Array.isArray(x.value) ? x.value : [])], 150);
    timings.localMs = Date.now() - localStarted;
  }

  const rerank1Started = Date.now();
  let ranked = await rankExpanded(ai, plan.resolvedQuestion, merged, signal, SEARCH_V44_SOURCE_LIMIT);
  timings.rerank1Ms = Date.now() - rerank1Started;

  const coverageStarted = Date.now();
  let coverage = await assessCoverage(ai, { ...plan, queries: allQueries }, ranked, history, signal);
  timings.coverageMs = Date.now() - coverageStarted;

  const needThird = !coverage.sufficient || shouldForceThirdRound(plan);
  if (needThird && Date.now() - startedAt < maxBudgetMs - 4000) {
    const already = new Set(allQueries.map((q) => q.toLowerCase()));
    const thirdQueries = uniqueQueries([...(coverage.queries || []), ...recoveryQueries(plan, history)], SEARCH_V44_MAX_RECOVERY_QUERIES)
      .filter((q) => !already.has(q.toLowerCase()));
    if (thirdQueries.length) {
      const round3Started = Date.now();
      const round3 = await runQueryBatch(thirdQueries, { timeoutMs: queryTimeoutMs, multiEngine: false });
      merged = dedupeSearchResults([...merged, ...round3], 170);
      allQueries.push(...thirdQueries);
      timings.round3Ms = Date.now() - round3Started;
      rounds = 3;
      ranked = await rankExpanded(ai, plan.resolvedQuestion, merged, signal, SEARCH_V44_SOURCE_LIMIT);
      coverage = await assessCoverage(ai, { ...plan, queries: allQueries }, ranked, history, signal);
    }
  }

  timings.totalMs = Date.now() - startedAt;
  return {
    revision: SEARCH_V44_REVISION,
    plan: { ...plan, queries: uniqueQueries(allQueries, SEARCH_V44_MAX_TOTAL_QUERIES) },
    rawResults: merged,
    results: ranked,
    rounds,
    coverage,
    evidenceUseful: hasUsefulSearchEvidence(ranked, 4),
    subrequestBudgetAware: true,
    externalSubrequestBaseTarget: SEARCH_V44_EXTERNAL_SUBREQUEST_BASE_TARGET,
    timings,
  };
}

export const __test = {
  clean,
  fallbackResolvedQuestion,
  uniqueQueries,
  deterministicQueries,
  shouldForceThirdRound,
  extractPageExcerpt,
};

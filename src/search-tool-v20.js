import { webSearch, formatSearchContext } from './web-search.js';
import { searchBingRss, dedupeSearchResults } from './search-fallbacks.js';
import { buildContextualFallbackPlan } from './search-v19.js';

export const SEARCH_TOOL_V20_REVISION = 'evidence-only-web-tool-v20';
export const SEARCH_TOOL_V20_MAX_QUERIES = 3;
export const SEARCH_TOOL_V20_MAX_SOURCES = 10;

const LISTICLE_RE = /(おすすめ\s*\d+選|ランキング|まとめ|選び方|比較.*\d+選|店舗一覧|ショップ一覧)/i;
const OFFICIAL_HINT_RE = /(公式|店舗情報|会社概要|自治体|市役所|県庁|政府|メーカー|直営)/i;

function clean(value, max = 500) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function unique(values, limit = SEARCH_TOOL_V20_MAX_QUERIES) {
  const out = [];
  const seen = new Set();
  for (const raw of values || []) {
    const value = clean(raw, 180);
    if (value.length < 2) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function sourceQuality(item, index) {
  let score = Math.max(0, 80 - index);
  const title = clean(item?.title, 240);
  const url = String(item?.url || '');
  if (LISTICLE_RE.test(title)) score -= 28;
  if (OFFICIAL_HINT_RE.test(title)) score += 12;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (/\.go\.jp$|\.lg\.jp$|\.ac\.jp$|\.gov$|\.edu$/.test(host)) score += 18;
    if (/^(?:www\.)?(?:google|bing|duckduckgo)\./.test(host)) score -= 20;
  } catch {}
  if (String(item?.excerpt || '').length >= 250) score += 5;
  return score;
}

function rankSources(items) {
  return (items || [])
    .map((item, index) => ({ item, score: sourceQuality(item, index) }))
    .sort((a, b) => b.score - a.score)
    .map(({ item }) => item)
    .slice(0, SEARCH_TOOL_V20_MAX_SOURCES);
}

function compactSource(item) {
  return {
    title: clean(item?.title, 180),
    url: String(item?.url || '').slice(0, 800),
    evidence: clean(item?.excerpt || item?.snippet, 900),
    engine: clean(item?.engine, 40),
  };
}

export function compactToolEvidence(result) {
  return {
    revision: SEARCH_TOOL_V20_REVISION,
    resolvedQuestion: clean(result?.resolvedQuestion, 260),
    queries: Array.isArray(result?.queries) ? result.queries.slice(0, SEARCH_TOOL_V20_MAX_QUERIES) : [],
    sources: Array.isArray(result?.sources) ? result.sources.slice(0, 8).map(compactSource) : [],
    evidenceUseful: Boolean(result?.sources?.length),
  };
}

export async function collectWebEvidenceV20(query, history = [], options = {}) {
  const started = Date.now();
  const question = clean(query, 350);
  if (!question) {
    return {
      revision: SEARCH_TOOL_V20_REVISION,
      resolvedQuestion: '',
      queries: [],
      sources: [],
      evidence: '',
      elapsedMs: 0,
    };
  }

  const fallbackPlan = buildContextualFallbackPlan(question, history);
  const queries = unique([
    question,
    ...(fallbackPlan.queries || []),
  ]);

  options.onProgress?.({
    phase: 'searching',
    revision: SEARCH_TOOL_V20_REVISION,
    queries,
  });

  const batches = await Promise.all(queries.map(async (searchQuery, index) => {
    const timeoutMs = index === 0 ? 4300 : 3600;
    const [html, rss] = await Promise.all([
      webSearch(searchQuery, {
        limit: 8,
        timeoutMs,
        enrichPages: index === 0,
        signal: options.signal,
      }).catch(() => []),
      searchBingRss(searchQuery, { limit: 8, timeoutMs }).catch(() => []),
    ]);
    return [...html, ...rss];
  }));

  const merged = dedupeSearchResults(batches.flat(), 40);
  const sources = rankSources(merged);
  const evidence = formatSearchContext(sources);
  const result = {
    revision: SEARCH_TOOL_V20_REVISION,
    resolvedQuestion: clean(fallbackPlan.resolvedQuestion || question, 260),
    queries,
    sources,
    evidence,
    elapsedMs: Date.now() - started,
  };

  options.onProgress?.({
    phase: 'evidence_ready',
    revision: SEARCH_TOOL_V20_REVISION,
    resolvedQuestion: result.resolvedQuestion,
    queries,
    evidenceCount: sources.length,
    sources: sources.slice(0, 8).map((item) => ({ title: clean(item.title, 140), url: item.url })),
    elapsedMs: result.elapsedMs,
  });

  return result;
}

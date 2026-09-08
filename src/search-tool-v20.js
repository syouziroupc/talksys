import { webSearch, formatSearchContext } from './web-search.js';
import {
  searchBingRss,
  searchOpenStreetMapLocal,
  dedupeSearchResults,
  buildDeterministicSearchQueries,
} from './search-fallbacks.js';

export const SEARCH_TOOL_V20_REVISION = 'evidence-only-web-tool-v20.1-fast-local';
export const SEARCH_TOOL_V20_MAX_QUERIES = 2;
export const SEARCH_TOOL_V20_MAX_SOURCES = 8;

const LISTICLE_RE = /(おすすめ\s*\d+選|ランキング|まとめ|選び方|比較.*\d+選|店舗一覧|ショップ一覧)/i;
const OFFICIAL_HINT_RE = /(公式|店舗情報|会社概要|メーカー|直営|取扱商品|店舗検索)/i;
const FOLLOWUP_REFERENCE_RE = /(それ|その(?:店|店舗|商品|製品|機種|場所|ホテル|プラン|やつ)?|さっき|前の|こっち|そっち|あっち|同じ(?:もの|やつ|店)?)/i;
const SHORT_FOLLOWUP_RE = /^(?:(?:今日|明日|今)\s*)?(?:どこ(?:で|に|が|の)?|近く|安い(?:の|方|やつ)?|高い(?:の|方|やつ)?|いくら|何時|在庫|営業時間|買える|売って(?:る)?|おすすめ(?:は|どれ)?)/i;
const CONTEXT_NOISE_RE = /^(?:はい|うん|そう|そうだね|なるほど|ありがとう(?:ございます)?|お願いします?|えーと|うーん|じゃあ|それで)[\s。、！？!?]*$/i;
const LOCAL_COMMERCE_RE = /(どこ(?:か)?(?:で|に).{0,28}(?:買|購入|売)|販売店|家電量販店|店舗|店頭|近く|周辺|市内|県内)/i;
const STORE_SIGNAL_RE = /(店|店舗|ショップ|販売|家電|電器|電機|パソコン|\bPC\b|ビックカメラ|ヤマダ|エディオン|ケーズ|コジマ|ハードオフ|パソコン工房|ジョーシン)/i;
const LOCAL_JUNK_RE = /(観光|旅行|温泉|市役所|県庁|市公式|県公式|ホームページ$|Wikipedia|ウィキペディア|ニュース|人物|ケンミンSHOW)/i;

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

function recentUserContext(history, limit = 2) {
  const values = [];
  for (const item of Array.isArray(history) ? history : []) {
    if (item?.role !== 'user') continue;
    const value = clean(item.content, 180);
    if (!value || CONTEXT_NOISE_RE.test(value)) continue;
    if (values.at(-1) === value) continue;
    values.push(value);
  }
  return values.slice(-limit);
}

export function resolveSearchSeed(query, history = []) {
  const current = clean(query, 350);
  if (!current) return '';

  const prior = recentUserContext(history, 2).filter((value) => value !== current);
  if (!prior.length) return current;

  const explicitReference = FOLLOWUP_REFERENCE_RE.test(current);
  const shortEllipticalFollowup = current.length <= 28 && SHORT_FOLLOWUP_RE.test(current);
  if (!explicitReference && !shortEllipticalFollowup) return current;

  return clean([...prior, current].join(' '), 350);
}

function detectLocalProfile(question, queries = []) {
  const text = clean([question, ...queries].join(' '), 600);
  const locationMatches = [...text.matchAll(/([一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{1,18}(?:都|道|府|県|市|区|町|村))/g)];
  const preferred = locationMatches.find((match) => /(?:市|区|町|村)$/.test(match[1]));
  const location = clean(preferred?.[1] || locationMatches.at(-1)?.[1] || '', 24);
  let product = '';
  if (/(?:パソコン|\bPC\b|ＰＣ)/i.test(text)) product = 'パソコン';
  else if (/iPhone/i.test(text)) product = 'iPhone';
  else if (/Android/i.test(text)) product = 'Android';
  return {
    localCommerce: Boolean(location) && LOCAL_COMMERCE_RE.test(text),
    location,
    product,
  };
}

function sourceText(item) {
  return clean(`${item?.title || ''} ${item?.excerpt || item?.snippet || ''}`, 1500);
}

function sourceQuality(item, index, profile) {
  let score = Math.max(0, 80 - index);
  const title = clean(item?.title, 240);
  const text = sourceText(item);
  const url = String(item?.url || '');
  const engine = String(item?.engine || '');

  if (LISTICLE_RE.test(title)) score -= 28;
  if (OFFICIAL_HINT_RE.test(title) || OFFICIAL_HINT_RE.test(text)) score += 12;
  if (String(item?.excerpt || item?.snippet || '').length >= 180) score += 4;

  try {
    const host = new URL(url).hostname.toLowerCase();
    if (/\.go\.jp$|\.lg\.jp$|\.ac\.jp$|\.gov$|\.edu$/.test(host)) score += profile.localCommerce ? -20 : 18;
    if (/^(?:www\.)?(?:google|bing|duckduckgo)\./.test(host)) score -= 20;
    if (/wikipedia\.org$/.test(host)) score -= profile.localCommerce ? 85 : 10;
  } catch {}

  if (profile.localCommerce) {
    const locationMatch = profile.location && text.includes(profile.location);
    const productMatch = profile.product && new RegExp(profile.product === 'パソコン' ? '(?:パソコン|\\bPC\\b|ＰＣ)' : profile.product, 'i').test(text);
    const storeMatch = STORE_SIGNAL_RE.test(text);
    if (locationMatch) score += 36;
    else score -= 24;
    if (storeMatch) score += 28;
    if (productMatch) score += 18;
    if (engine === 'openstreetmap-nominatim') score += 22;
    if (/wikipedia|google-news/i.test(engine)) score -= 70;
    if (LOCAL_JUNK_RE.test(title) || LOCAL_JUNK_RE.test(text.slice(0, 450))) score -= 60;
  }

  return score;
}

function isStrongLocalCandidate(item, profile, score) {
  if (!profile.localCommerce) return true;
  const text = sourceText(item);
  const locationMatch = Boolean(profile.location) && text.includes(profile.location);
  const storeMatch = STORE_SIGNAL_RE.test(text);
  const osm = item?.engine === 'openstreetmap-nominatim';
  return score >= 72 && locationMatch && (storeMatch || osm);
}

export function rankEvidenceSourcesV20(items, question = '', queries = []) {
  const profile = detectLocalProfile(question, queries);
  const ranked = (items || [])
    .map((item, index) => ({ item, score: sourceQuality(item, index, profile) }))
    .sort((a, b) => b.score - a.score);

  if (profile.localCommerce) {
    return ranked
      .filter(({ item, score }) => isStrongLocalCandidate(item, profile, score))
      .map(({ item }) => item)
      .slice(0, SEARCH_TOOL_V20_MAX_SOURCES);
  }

  return ranked.map(({ item }) => item).slice(0, SEARCH_TOOL_V20_MAX_SOURCES);
}

function compactSource(item) {
  return {
    title: clean(item?.title, 180),
    url: String(item?.url || '').slice(0, 800),
    evidence: clean(item?.excerpt || item?.snippet, 700),
    engine: clean(item?.engine, 40),
  };
}

export function compactToolEvidence(result) {
  return {
    revision: SEARCH_TOOL_V20_REVISION,
    resolvedQuestion: clean(result?.resolvedQuestion, 260),
    queries: Array.isArray(result?.queries) ? result.queries.slice(0, SEARCH_TOOL_V20_MAX_QUERIES) : [],
    sources: Array.isArray(result?.sources) ? result.sources.slice(0, 6).map(compactSource) : [],
    evidenceUseful: Boolean(result?.sources?.length),
  };
}

async function searchBatch(searchQuery, timeoutMs, profile) {
  const tasks = [
    webSearch(searchQuery, {
      limit: 10,
      timeoutMs,
      enrichPages: false,
    }).catch(() => []),
    searchBingRss(searchQuery, { limit: 8, timeoutMs }).catch(() => []),
  ];

  if (profile.localCommerce && profile.location) {
    const osmQuery = clean(`${profile.location} ${profile.product || ''}`);
    tasks.push(searchOpenStreetMapLocal(osmQuery, { timeoutMs: Math.min(timeoutMs, 2400) }).catch(() => []));
  }

  return (await Promise.all(tasks)).flat();
}

export async function collectWebEvidenceV20(query, history = [], options = {}) {
  const started = Date.now();
  const question = resolveSearchSeed(query, history);
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

  const planned = buildDeterministicSearchQueries(question, history);
  const queries = unique([
    ...planned,
    question,
  ]);
  const profile = detectLocalProfile(question, queries);

  options.onProgress?.({
    phase: 'searching',
    revision: SEARCH_TOOL_V20_REVISION,
    resolvedQuestion: question,
    queries,
  });

  const first = await searchBatch(queries[0] || question, 2800, profile);
  let merged = dedupeSearchResults(first, 36);
  let sources = rankEvidenceSourcesV20(merged, question, queries);

  if (sources.length < 3 && queries[1]) {
    options.onProgress?.({
      phase: 'recovery',
      revision: SEARCH_TOOL_V20_REVISION,
      resolvedQuestion: question,
      queries,
      message: '有効な根拠が少ないため補助検索を実行',
    });
    const second = await searchBatch(queries[1], 2500, profile);
    merged = dedupeSearchResults([...merged, ...second], 40);
    sources = rankEvidenceSourcesV20(merged, question, queries);
  }

  const evidence = formatSearchContext(sources);
  const result = {
    revision: SEARCH_TOOL_V20_REVISION,
    resolvedQuestion: question,
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
    sources: sources.slice(0, 6).map((item) => ({ title: clean(item.title, 140), url: item.url })),
    elapsedMs: result.elapsedMs,
  });

  return result;
}

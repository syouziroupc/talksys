import { collectGroundedEvidenceV23 } from './search-v23.js';
import { searchBingRss, searchOpenStreetMapLocal, dedupeSearchResults } from './search-fallbacks.js';

export const SEARCH_TOOL_V26_REVISION = 'evidence-web-v26-redundant-local-direct-transit';

const TRANSIT_RE = /(乗り換え|乗換|経路|行き方|電車|鉄道|所要時間|運賃|時刻表|直通)/i;
const PC_RE = /(パソコン|\bPC\b|ＰＣ|ノートパソコン|ノート|Windows)/i;
const STORE_RE = /(店|店舗|ショップ|販売店|家電量販店|専門店|どこで買|おすすめ)/i;

function clean(value, max = 4000) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function stripHtml(value) {
  return decodeEntities(String(value || ''))
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stationPair(text) {
  const value = clean(text, 900);
  const pair = value.match(/([一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{1,28}?)(?:駅)?\s*(?:から|より|→|⇒|〜|～|-)\s*([一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{1,28}?)(?:駅)?\s*(?:まで|へ|に)(?=$|[のをがはで、。！？!?\s])/i);
  if (!pair?.[1] || !pair?.[2]) return [];
  return [pair[1].replace(/駅$/u, ''), pair[2].replace(/駅$/u, '')];
}

function localArea(text) {
  const value = clean(text, 900);
  const matches = [...value.matchAll(/([一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{1,18}(?:都|道|府|県|市|区|町|村))/g)];
  return clean(matches.at(-1)?.[1] || '', 40);
}

function localToken(area) {
  return clean(area, 40).replace(/(?:都|道|府|県|市|区|町|村)$/u, '');
}

function localStoreRelevant(item, area) {
  const text = clean(`${item?.title || ''} ${item?.excerpt || item?.snippet || ''}`, 1800);
  const token = localToken(area);
  if (token && !text.includes(token)) return false;
  return /(パソコン|\bPC\b|ＰＣ|家電|コンピュータ|computer|ドスパラ|ヤマダ|ケーズ|コジマ|エディオン|ショップ|店舗|販売)/i.test(text);
}

function timeoutSignal(parentSignal, timeoutMs = 3600) {
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return parentSignal;
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!parentSignal) return timeout;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([parentSignal, timeout]) : parentSignal;
}

function usefulRouteExcerpt(text, from, to) {
  const normalized = clean(text, 50000);
  const needles = [`${from}→${to}`, `${from}から${to}`, 'ルート1', '経路1'];
  let index = -1;
  for (const needle of needles) {
    index = normalized.indexOf(needle);
    if (index >= 0) break;
  }
  const start = index >= 0 ? Math.max(0, index - 180) : 0;
  return normalized.slice(start, start + 3200);
}

async function fetchYahooTransitRoute(from, to, signal) {
  const url = `https://transit.yahoo.co.jp/search/result/${encodeURIComponent(from)}-${encodeURIComponent(to)}`;
  const response = await fetch(url, {
    signal: timeoutSignal(signal, 3600),
    redirect: 'follow',
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'ja-JP,ja;q=0.9',
      'user-agent': 'Mozilla/5.0 (compatible; TalkSys/1.0; +https://talksys.syouziroupc.workers.dev)',
    },
  });
  if (!response.ok) throw new Error(`Yahoo Transit ${response.status}`);
  const html = await response.text();
  const text = stripHtml(html);
  const excerpt = usefulRouteExcerpt(text, from, to);
  if (!excerpt.includes(from) || !excerpt.includes(to)) throw new Error('Transit page endpoints did not match');
  if (!/(乗換|乗り換え|ルート|経路|運賃|円|分|発|着)/i.test(excerpt)) throw new Error('Transit page contained no usable route evidence');
  return {
    title: `${from}から${to}への乗換案内 - Yahoo!路線情報`,
    url: response.url || url,
    engine: 'yahoo-transit-direct',
    excerpt,
    snippet: excerpt,
  };
}

function evidenceFromSources(sources) {
  return (sources || []).slice(0, 8).map((item, i) => `[${i + 1}] ${clean(item?.title, 180)}\n${clean(item?.url, 500)}\n${clean(item?.excerpt || item?.snippet || '', 1200)}`).join('\n\n');
}

async function augmentLocalStoreEvidence(base, options = {}) {
  const resolved = clean(base?.resolvedQuestion || '', 900);
  const area = localArea(resolved);
  if (!area || !PC_RE.test(resolved) || !STORE_RE.test(resolved)) return base;
  const existing = Array.isArray(base?.sources) ? base.sources : [];
  if (existing.length >= 3) return base;

  const bingQueries = [
    `${area} パソコン 店舗`,
    `${area} ノートパソコン 販売店`,
    `${area} パソコン 専門店`,
    `${area} 家電量販店 パソコン`,
  ];
  const osmQueries = [`${area} パソコンショップ`, `${area} 家電量販店`];
  const settled = await Promise.allSettled([
    ...bingQueries.map((q) => searchBingRss(q, { timeoutMs: 5200, limit: 6 })),
    ...osmQueries.map((q) => searchOpenStreetMapLocal(q, { timeoutMs: 5200 })),
  ]);
  const fallback = settled.flatMap((result) => result.status === 'fulfilled' && Array.isArray(result.value) ? result.value : []).filter((item) => localStoreRelevant(item, area));
  const sources = dedupeSearchResults([...existing, ...fallback], 8);
  if (!sources.length) return { ...base, localFallbackAttempted: true };

  options.onProgress?.({
    phase: 'evidence_ready',
    revision: SEARCH_TOOL_V26_REVISION,
    resolvedQuestion: resolved,
    queries: base?.queries || bingQueries.slice(0, 3),
    evidenceCount: sources.length,
    sources: sources.map((item) => ({ title: item.title, url: item.url })),
    message: '地域店舗を複数の検索経路で再確認',
  });
  return {
    ...base,
    sources,
    evidence: evidenceFromSources(sources),
    searchUseful: true,
    localFallbackAttempted: true,
    localFallbackSucceeded: true,
  };
}

export async function augmentGroundedEvidenceV26(base, options = {}) {
  let augmented = await augmentLocalStoreEvidence(base || {}, options);
  const resolved = clean(augmented?.resolvedQuestion || '', 900);
  if (!TRANSIT_RE.test(resolved)) return { ...augmented, revision: SEARCH_TOOL_V26_REVISION };
  const [from, to] = stationPair(resolved);
  if (!from || !to) return { ...augmented, revision: SEARCH_TOOL_V26_REVISION };

  try {
    const direct = await fetchYahooTransitRoute(from, to, options.signal);
    const existing = Array.isArray(augmented?.sources) ? augmented.sources : [];
    const directKey = String(direct.url || '').replace(/[?#].*$/, '').replace(/\/$/, '');
    const sources = [direct, ...existing.filter((item) => String(item?.url || '').replace(/[?#].*$/, '').replace(/\/$/, '') !== directKey)].slice(0, 8);
    options.onProgress?.({
      phase: 'evidence_ready',
      revision: SEARCH_TOOL_V26_REVISION,
      resolvedQuestion: resolved,
      queries: augmented?.queries || [],
      evidenceCount: sources.length,
      sources: sources.map((item) => ({ title: item.title, url: item.url })),
      message: '乗換案内の実ページを優先根拠として確認',
    });
    return {
      ...augmented,
      revision: SEARCH_TOOL_V26_REVISION,
      sources,
      evidence: evidenceFromSources(sources),
      searchUseful: true,
      directTransitPrimary: true,
    };
  } catch (error) {
    return {
      ...augmented,
      revision: SEARCH_TOOL_V26_REVISION,
      directTransitError: String(error?.message || error).slice(0, 180),
    };
  }
}

export async function collectGroundedEvidenceV26(query, history = [], options = {}) {
  const base = await collectGroundedEvidenceV23(query, history, options);
  return augmentGroundedEvidenceV26(base, options);
}

export const __test = { stationPair, localArea, localStoreRelevant, usefulRouteExcerpt, stripHtml, evidenceFromSources };

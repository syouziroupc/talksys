import { webSearch, formatSearchContext } from './web-search.js';
import {
  searchBingRss,
  searchOpenStreetMapLocal,
  dedupeSearchResults,
} from './search-fallbacks.js';
import {
  collectWebEvidenceV20,
  rankEvidenceSourcesV20,
} from './search-tool-v20.js';
import { requiresFreshSearch as requiresFreshSearchV20 } from './search-policy-v20.js';

export const SEARCH_TOOL_V21_REVISION = 'evidence-only-web-tool-v21-context-transit';

const TRANSIT_INTENT_RE = /(乗り換え|乗換|経路|行き方|電車で|鉄道で|何分|所要時間|最短|時刻表|運行|発車|到着)/i;
const LOCAL_SHOP_RE = /(店頭|店舗|販売店|家電量販店|ショップ|買える|買いたい|購入|安いところ|安い店|近く|周辺|どこで買|どこにある|店.*ない)/i;
const DETAIL_RE = /(電話番号|連絡先|問い合わせ先|住所|所在地|営業時間|営業日|定休日|公式サイト|公式ページ|URL|アクセス)/i;
const FOLLOWUP_RE = /^(?:それ|その|さっき|前の|じゃあ|で、?|それで|どこ|近く|安い|高い|いくら|何時|在庫|営業時間|買える|売って|おすすめ|店頭)/i;
const STORE_SIGNAL_RE = /(店|店舗|ショップ|販売|家電|電器|電機|パソコン|PC|ＰＣ|ビックカメラ|ヤマダ|エディオン|ケーズ|コジマ|ハードオフ|パソコン工房|ジョーシン|ドスパラ|PC DEPOT|ピーシーデポ)/i;
const LISTICLE_RE = /(おすすめ\s*\d+選|ランキング|まとめ|選び方|比較.*\d+選)/i;
const ROUTE_SERVICE_HOST_RE = /(tokyu\.co\.jp|jr.*\.co\.jp|odakyu\.jp|keio\.co\.jp|seiburailway\.jp|tobu\.co\.jp|keikyu\.co\.jp|tokyometro\.jp|kotsu\.metro\.tokyo\.jp|jorudan\.co\.jp|navitime\.co\.jp|transit\.yahoo\.co\.jp)/i;
const STATION_TOKEN = '[一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]';

function clean(value, max = 600) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function recentUserContext(history, limit = 4) {
  const out = [];
  for (const item of Array.isArray(history) ? history : []) {
    if (item?.role !== 'user') continue;
    const value = clean(item.content, 220);
    if (!value || out.at(-1) === value) continue;
    out.push(value);
  }
  return out.slice(-limit);
}

function stationNames(text) {
  const value = clean(text, 900);
  const pairPattern = new RegExp(`(${STATION_TOKEN}{1,24}?駅)\\s*(?:から|より|→|⇒|〜|～|-)\\s*(${STATION_TOKEN}{1,24}?駅)`, 'i');
  const pair = value.match(pairPattern);
  if (pair?.[1] && pair?.[2]) return [...new Set([pair[1], pair[2]])];

  const singlePattern = new RegExp(`(${STATION_TOKEN}{1,24}?駅)(?=(?:から|より|まで|へ|に|で|の|を|が|は|と|周辺|近く|、|。|！|？|!|\\?|\\s|$))`, 'gi');
  const matches = [...value.matchAll(singlePattern)].map((match) => match[1]);
  return [...new Set(matches)].slice(0, 4);
}

function placeName(text) {
  const value = clean(text, 900);
  const station = stationNames(value).at(-1);
  if (station) return station;
  const matches = [...value.matchAll(/([一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{1,20}(?:都|道|府|県|市|区|町|村))/g)];
  return clean(matches.at(-1)?.[1] || '', 30);
}

function productName(text) {
  const value = clean(text, 1000);
  if (/(?:ノート\s*)?(?:パソコン|PC|ＰＣ)/i.test(value)) return 'パソコン';
  if (/iPhone/i.test(value)) return 'iPhone';
  if (/Android/i.test(value)) return 'Android スマートフォン';
  if (/スマホ|スマートフォン/i.test(value)) return 'スマートフォン';
  return '';
}

export function resolveSearchSeedV21(query, history = []) {
  const current = clean(query, 420);
  if (!current) return '';

  const recent = recentUserContext(history, 4).filter((item) => item !== current);
  if (!recent.length) return current;

  const stations = stationNames(current);
  const selfContainedTransit = stations.length >= 2 && TRANSIT_INTENT_RE.test(current);
  if (selfContainedTransit) return current;

  const currentHasProduct = Boolean(productName(current));
  const currentHasPlace = Boolean(placeName(current));
  const needsContext = current.length <= 42 && (
    FOLLOWUP_RE.test(current)
    || LOCAL_SHOP_RE.test(current)
    || (!currentHasProduct && (currentHasPlace || /どこ|店|安い|買|購入|在庫|営業時間/i.test(current)))
  );

  if (!needsContext) return current;
  return clean([...recent.slice(-3), current].join(' '), 520);
}

function profileFor(question) {
  const stations = stationNames(question);
  const transit = stations.length >= 2 && TRANSIT_INTENT_RE.test(question);
  const place = placeName(question);
  const product = productName(question);
  const localCommerce = !transit && Boolean(place) && LOCAL_SHOP_RE.test(question) && Boolean(product || STORE_SIGNAL_RE.test(question));
  return {
    transit,
    stations,
    place,
    product,
    localCommerce,
    detailLookup: DETAIL_RE.test(question),
  };
}

export function requiresFreshSearchV21(text, history = []) {
  const current = clean(text, 500);
  if (!current) return false;
  if (requiresFreshSearchV20(current)) return true;
  const seed = resolveSearchSeedV21(current, history);
  const profile = profileFor(seed);
  if (profile.transit || profile.localCommerce) return true;
  if (stationNames(current).length >= 2 && /(から|まで|→|行く|行きたい)/i.test(current)) return true;
  return false;
}

function buildQueries(question, profile) {
  if (profile.transit) {
    const [from, to] = profile.stations;
    return [
      `${from} ${to} 乗換案内`,
      `${from} ${to} 電車 経路 所要時間`,
      `${from} ${to} 鉄道 直通 乗り換え`,
    ];
  }
  if (profile.localCommerce) {
    const product = profile.product || 'パソコン';
    return [
      `${profile.place} ${product} 販売店 店頭`,
      `${profile.place} ${product} 安い 店舗`,
      `${profile.place} ${product} 中古 新品 店舗`,
    ];
  }
  return [question];
}

function sourceText(item) {
  return clean(`${item?.title || ''} ${item?.excerpt || item?.snippet || ''}`, 2200);
}

function scoreCustomSource(item, index, profile) {
  let score = Math.max(0, 100 - index);
  const text = sourceText(item);
  const title = clean(item?.title, 240);
  const url = String(item?.url || '');

  if (LISTICLE_RE.test(title)) score -= 28;
  if (String(item?.excerpt || item?.snippet || '').length >= 120) score += 8;

  if (profile.transit) {
    const stationHits = profile.stations.slice(0, 2).filter((station) => text.includes(station)).length;
    score += stationHits * 34;
    if (stationHits === 0) score -= 70;
    if (TRANSIT_INTENT_RE.test(text)) score += 18;
    try {
      if (ROUTE_SERVICE_HOST_RE.test(new URL(url).hostname)) score += 28;
    } catch {}
  }

  if (profile.localCommerce) {
    const placeToken = profile.place.replace(/駅$/, '');
    if (profile.place && (text.includes(profile.place) || (placeToken.length >= 2 && text.includes(placeToken)))) score += 38;
    else score -= 30;
    if (STORE_SIGNAL_RE.test(text)) score += 30;
    if (profile.product && text.includes(profile.product)) score += 18;
    if (item?.engine === 'openstreetmap-nominatim') score += 18;
    if (/Wikipedia|ウィキペディア|観光|旅行/i.test(text)) score -= 70;
  }

  return score;
}

function rankCustomSources(items, question, queries, profile) {
  if (!profile.transit && !profile.localCommerce) return rankEvidenceSourcesV20(items, question, queries);
  return (items || [])
    .map((item, index) => ({ item, score: scoreCustomSource(item, index, profile) }))
    .sort((a, b) => b.score - a.score)
    .filter(({ score }) => score >= (profile.transit ? 85 : 78))
    .map(({ item }) => item)
    .slice(0, 10);
}

async function searchOne(query, profile) {
  const timeoutMs = profile.detailLookup ? 4200 : 3400;
  const tasks = [
    webSearch(query, {
      limit: 10,
      timeoutMs,
      enrichPages: profile.detailLookup || profile.transit,
    }).catch(() => []),
    searchBingRss(query, { limit: 9, timeoutMs }).catch(() => []),
  ];
  if (profile.localCommerce && profile.place) {
    tasks.push(searchOpenStreetMapLocal(`${profile.place} ${profile.product || ''}`, {
      timeoutMs: Math.min(timeoutMs, 2600),
    }).catch(() => []));
  }
  return (await Promise.all(tasks)).flat();
}

export async function collectWebEvidenceV21(query, history = [], options = {}) {
  const started = Date.now();
  const question = resolveSearchSeedV21(query, history);
  if (!question) {
    return {
      revision: SEARCH_TOOL_V21_REVISION,
      resolvedQuestion: '',
      queries: [],
      sources: [],
      evidence: '',
      elapsedMs: 0,
    };
  }

  const profile = profileFor(question);
  if (!profile.transit && !profile.localCommerce) {
    const delegated = await collectWebEvidenceV20(question, [], options);
    return { ...delegated, revision: SEARCH_TOOL_V21_REVISION };
  }

  const queries = [...new Set(buildQueries(question, profile).map((item) => clean(item, 180)).filter(Boolean))].slice(0, 3);
  options.onProgress?.({
    phase: 'searching',
    revision: SEARCH_TOOL_V21_REVISION,
    resolvedQuestion: question,
    queries,
  });

  const batches = await Promise.all(queries.slice(0, 2).map((item) => searchOne(item, profile)));
  let merged = dedupeSearchResults(batches.flat(), 50);
  let sources = rankCustomSources(merged, question, queries, profile);

  if (sources.length < 3 && queries[2]) {
    options.onProgress?.({
      phase: 'recovery',
      revision: SEARCH_TOOL_V21_REVISION,
      resolvedQuestion: question,
      queries,
      message: '根拠を補強するため追加検索を実行',
    });
    const extra = await searchOne(queries[2], profile);
    merged = dedupeSearchResults([...merged, ...extra], 60);
    sources = rankCustomSources(merged, question, queries, profile);
  }

  const result = {
    revision: SEARCH_TOOL_V21_REVISION,
    resolvedQuestion: question,
    queries,
    sources,
    evidence: formatSearchContext(sources),
    elapsedMs: Date.now() - started,
  };

  options.onProgress?.({
    phase: 'evidence_ready',
    revision: SEARCH_TOOL_V21_REVISION,
    resolvedQuestion: result.resolvedQuestion,
    queries,
    evidenceCount: sources.length,
    sources: sources.slice(0, 8).map((item) => ({ title: clean(item.title, 140), url: item.url })),
    elapsedMs: result.elapsedMs,
  });

  return result;
}

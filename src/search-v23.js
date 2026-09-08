import { webSearch, formatSearchContext } from './web-search.js';
import {
  searchBingRss,
  searchOpenStreetMapLocal,
  dedupeSearchResults,
} from './search-fallbacks.js';
import { resolveGroundedQuestionV22 } from './search-v22.js';

export const SEARCH_TOOL_V23_REVISION = 'evidence-only-web-tool-v23-parallel-intent-search';

const TRANSIT_RE = /(乗り換え|乗換|経路|行き方|電車|鉄道|何分|所要時間|運賃|料金|時刻表|直通|発車|到着)/i;
const PC_RE = /(パソコン|\bPC\b|ＰＣ|Windows|MacBook|ThinkPad|Let'?s\s*note|レッツノート|CPU|GPU|Core\s*i[3579]|Ryzen|GeForce|Radeon|メモリ|RAM|SSD|NVMe|SATA|USB[- ]?C|Thunderbolt|Wi-?Fi|Bluetooth|BIOS|UEFI)/i;
const LOCAL_RE = /(店頭|店舗|販売店|ショップ|買える|買いたい|購入|近く|周辺|どこで買|どこにある|営業時間|住所|電話番号)/i;
const DETAIL_RE = /(仕様|スペック|型番|製品情報|マニュアル|取扱説明書|電話番号|住所|営業時間|価格|値段|発売日|対応|要件)/i;
const LISTICLE_RE = /(おすすめ\s*\d+選|ランキング|まとめ|選び方|比較.*\d+選)/i;
const ROUTE_HOST_RE = /(tokyu\.co\.jp|jr.*\.co\.jp|odakyu\.jp|keio\.co\.jp|seiburailway\.jp|tobu\.co\.jp|keikyu\.co\.jp|tokyometro\.jp|jorudan\.co\.jp|navitime\.co\.jp|transit\.yahoo\.co\.jp|ekitan\.com)/i;
const PC_OFFICIAL_HOST_RE = /(panasonic\.jp|nec-lavie\.jp|dynabook\.com|fmworld\.net|fujitsu\.com|lenovo\.com|dell\.com|hp\.com|asus\.com|acer\.com|microsoft\.com|apple\.com|intel\.(?:com|co\.jp)|amd\.com|nvidia\.com)/i;
const POLITE_TAIL_RE = /(?:を)?(?:教えて(?:ください|ほしい|よ)?|知りたい(?:です)?|調べて(?:ください)?|お願いします?|どうですか|どうなの|って何|とは何)[。！？!?]*$/i;
const STOPWORDS = new Set(['について','まで','から','ので','です','ます','したい','知りたい','教えて','ください','どう','どんな','もの','こと','これ','それ','その']);

function clean(value, max = 700) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function stationNames(text) {
  const value = clean(text, 900);
  const pair = value.match(/([一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{1,24}?駅)\s*(?:から|より|→|⇒|〜|～|-)\s*([一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{1,24}?駅)/i);
  if (pair?.[1] && pair?.[2]) return [...new Set([pair[1], pair[2]])];
  const matches = [...value.matchAll(/([一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{1,24}?駅)(?=(?:から|より|まで|へ|に|で|の|を|が|は|と|周辺|近く|、|。|！|？|!|\?|\s|$))/gi)]
    .map((match) => match[1]);
  return [...new Set(matches)].slice(0, 4);
}

function locationName(text) {
  const value = clean(text, 900);
  const station = stationNames(value).at(-1);
  if (station) return station;
  const matches = [...value.matchAll(/([一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{1,20}(?:都|道|府|県|市|区|町|村))/g)];
  return clean(matches.at(-1)?.[1] || '', 32);
}

function pcModelTokens(text) {
  const value = clean(text, 900);
  const patterns = [
    /\bCF-[A-Z0-9-]{2,20}\b/gi,
    /\b(?:Core\s*)?i[3579]-?\d{4,5}[A-Z]{0,2}\b/gi,
    /\bRyzen\s*[3579]\s*\d{4,5}[A-Z]{0,3}\b/gi,
    /\bRTX\s*\d{3,4}(?:\s*Ti|\s*SUPER)?\b/gi,
    /\bGTX\s*\d{3,4}(?:\s*Ti)?\b/gi,
    /\b[A-Z]{1,5}[0-9]{2,5}[A-Z0-9-]{0,12}\b/g,
  ];
  const out = [];
  for (const re of patterns) {
    for (const match of value.matchAll(re)) {
      const token = clean(match[0], 40);
      if (token && !out.includes(token)) out.push(token);
      if (out.length >= 5) return out;
    }
  }
  return out;
}

function compactQuestion(question) {
  const value = clean(question, 450).replace(POLITE_TAIL_RE, '').trim();
  return value || clean(question, 450);
}

function profileFor(question) {
  const stations = stationNames(question);
  const transit = stations.length >= 2 && TRANSIT_RE.test(question);
  const pc = PC_RE.test(question);
  const location = locationName(question);
  const local = !transit && Boolean(location) && LOCAL_RE.test(question);
  return {
    transit,
    pc,
    local,
    detail: DETAIL_RE.test(question),
    stations,
    location,
    pcTokens: pcModelTokens(question),
  };
}

export function buildSearchQueriesV23(question) {
  const q = compactQuestion(question);
  const profile = profileFor(q);
  const year = new Date().getUTCFullYear();

  if (profile.transit) {
    const [from, to] = profile.stations;
    return [
      `${from} ${to} 乗換 所要時間 運賃`,
      `${from} ${to} 直通 路線 停車駅`,
      `${from} ${to} 時刻表 乗換案内`,
    ];
  }

  if (profile.pc) {
    const model = profile.pcTokens.join(' ');
    if (model) {
      return [
        `${model} 仕様 公式`,
        `${model} マニュアル 仕様 対応`,
        q,
      ];
    }
    if (/(価格|値段|予算|万円|中古|新品|買|購入)/i.test(q)) {
      return [
        `${q} ${year}`,
        `${q} 仕様 価格`,
        `${q} 比較 ${year}`,
      ];
    }
    return [q, `${q} 公式 仕様`, `${q} 技術仕様`];
  }

  if (profile.local) return [q, `${q} 公式`, `${profile.location} ${q}`];
  if (profile.detail) return [q, `${q} 公式`, `${q} 詳細`];
  return [q, `${q} 公式`];
}

function tokenize(text) {
  return clean(text, 1200)
    .replace(/[、。！？!?（）()「」『』・/:：]/g, ' ')
    .split(/\s+/)
    .flatMap((part) => part.match(/[A-Za-z0-9][A-Za-z0-9+._-]{1,30}|[一-龠々ヶぁ-んァ-ヶー]{2,16}/g) || [])
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

function sourceText(item) {
  return clean(`${item?.title || ''} ${item?.excerpt || item?.snippet || ''}`, 2600);
}

function scoreSource(item, index, question, profile) {
  let score = 100 - Math.min(index, 80);
  const text = sourceText(item);
  const lower = text.toLowerCase();
  const title = clean(item?.title, 220);
  const url = String(item?.url || '');
  const terms = [...new Set(tokenize(question))].slice(0, 18);

  for (const term of terms) if (lower.includes(term)) score += 5;
  if (String(item?.excerpt || item?.snippet || '').length >= 180) score += 7;
  if (LISTICLE_RE.test(title)) score -= 28;
  if (/Wikipedia|ウィキペディア/i.test(title)) score -= 25;

  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch {}
  if (/\.go\.jp$|\.lg\.jp$|\.ac\.jp$|\.gov$|\.edu$/.test(host)) score += 18;

  if (profile.transit) {
    const stationHits = profile.stations.slice(0, 2).filter((station) => text.includes(station)).length;
    score += stationHits * 34;
    if (stationHits < 2) score -= 45;
    if (ROUTE_HOST_RE.test(host)) score += 32;
    if (/(所要時間|運賃|乗換|乗り換え|直通|時刻)/i.test(text)) score += 16;
  }

  if (profile.pc) {
    if (PC_OFFICIAL_HOST_RE.test(host)) score += 34;
    for (const token of profile.pcTokens) if (text.toLowerCase().includes(token.toLowerCase())) score += 22;
    if (/(仕様|スペック|CPU|メモリ|SSD|インターフェース|USB|無線|ディスプレイ|バッテリー|対応OS|最大|スロット)/i.test(text)) score += 18;
    if (/知恵袋|まとめ|ランキング/i.test(title)) score -= 25;
  }

  if (profile.local) {
    const place = profile.location.replace(/駅$/, '');
    if (profile.location && (text.includes(profile.location) || (place.length >= 2 && text.includes(place)))) score += 28;
    if (item?.engine === 'openstreetmap-nominatim') score += 20;
    if (/(店舗|店|ショップ|販売|営業時間|住所)/i.test(text)) score += 16;
  }

  return score;
}

function rankSources(items, question, profile) {
  return (items || [])
    .map((item, index) => ({ item, score: scoreSource(item, index, question, profile) }))
    .sort((a, b) => b.score - a.score)
    .filter(({ score }) => score >= 52)
    .map(({ item }) => item)
    .slice(0, 12);
}

async function searchOne(query, profile) {
  const timeoutMs = profile.transit || profile.pc || profile.detail ? 4200 : 3400;
  const enrichPages = profile.transit || profile.pc || profile.detail;
  const [primary, rss] = await Promise.all([
    webSearch(query, { limit: 9, timeoutMs, enrichPages }).catch(() => []),
    searchBingRss(query, { limit: 8, timeoutMs }).catch(() => []),
  ]);
  return [...primary, ...rss];
}

export async function collectGroundedEvidenceV23(query, history = [], options = {}) {
  const started = Date.now();
  const resolvedQuestion = resolveGroundedQuestionV22(query, history);
  if (!resolvedQuestion) {
    return {
      revision: SEARCH_TOOL_V23_REVISION,
      resolvedQuestion: '',
      queries: [],
      sources: [],
      evidence: '',
      elapsedMs: 0,
    };
  }

  const profile = profileFor(resolvedQuestion);
  const queries = [...new Set(buildSearchQueriesV23(resolvedQuestion).map((item) => clean(item, 190)).filter(Boolean))].slice(0, 3);
  options.onProgress?.({
    phase: 'planning',
    revision: SEARCH_TOOL_V23_REVISION,
    resolvedQuestion,
    queries,
    message: '質問の目的に合わせて検索語を展開',
  });
  options.onProgress?.({
    phase: 'searching',
    revision: SEARCH_TOOL_V23_REVISION,
    resolvedQuestion,
    queries,
  });

  const tasks = queries.map((item) => searchOne(item, profile));
  if (profile.local && profile.location) {
    const localQuery = clean(`${profile.location} ${profile.pc ? 'パソコン' : ''}`, 100);
    tasks.push(searchOpenStreetMapLocal(localQuery, { timeoutMs: 3000 }).catch(() => []));
  }

  const batches = await Promise.all(tasks);
  const merged = dedupeSearchResults(batches.flat(), 70);
  const sources = rankSources(merged, resolvedQuestion, profile);
  const result = {
    revision: SEARCH_TOOL_V23_REVISION,
    resolvedQuestion,
    queries,
    sources,
    evidence: formatSearchContext(sources),
    elapsedMs: Date.now() - started,
  };

  options.onProgress?.({
    phase: 'evidence_ready',
    revision: SEARCH_TOOL_V23_REVISION,
    resolvedQuestion,
    queries,
    evidenceCount: sources.length,
    sources: sources.slice(0, 8).map((item) => ({ title: clean(item.title, 150), url: item.url })),
    elapsedMs: result.elapsedMs,
    message: '質問に直接使える根拠を選定',
  });

  return result;
}

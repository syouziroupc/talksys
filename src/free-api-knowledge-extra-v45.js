export const EXTRA_KNOWLEDGE_API_REVISION = 'free-knowledge-extra-v45.1';

export const EXTRA_KNOWLEDGE_API_REGISTRY = Object.freeze({
  e_stat_dashboard: {
    label: '総務省 統計ダッシュボード WebAPI',
    category: 'japan_official_stats',
    free: true,
    keyRequired: false,
    commercialUse: true,
    attribution: 'このサービスは、統計ダッシュボードのAPI機能を使用していますが、サービスの内容は国によって保証されたものではありません。',
    termsUrl: 'https://dashboard.e-stat.go.jp/static/api',
    notes: '利用登録不要。公開サービスでは指定クレジットを表示。短時間の大量アクセスを避け、1質問あたりの呼出し数を制限する。',
  },
  eurostat: {
    label: 'Eurostat Statistics API',
    category: 'eu_official_stats',
    free: true,
    keyRequired: false,
    commercialUse: true,
    attribution: 'Source: Eurostat',
    termsUrl: 'https://ec.europa.eu/eurostat/help/copyright-notice',
    notes: '公開REST API。Eurostat自身の統計データを対象に、出典を明示する。第三者由来データや再利用例外のある貿易データは本アダプタでは扱わない。',
  },
  wikidata: {
    label: 'Wikidata Action API',
    category: 'stable_entity_fact',
    free: true,
    keyRequired: false,
    commercialUse: true,
    attribution: 'Data from Wikidata (CC0)',
    termsUrl: 'https://www.wikidata.org/wiki/Help:Data_access',
    notes: '構造化データはCC0。適切なUser-Agent、maxlag、低並列、429/Retry-After尊重。現在性が重要な役職・ニュース等には単独で使わない。',
  },
});

export const EXTRA_KNOWLEDGE_API_CATEGORIES = new Set(Object.values(EXTRA_KNOWLEDGE_API_REGISTRY).map((x) => x.category));

const JAPAN_STAT_METRIC_RE = /(人口|世帯|就業者|雇用|失業|住宅|出生|死亡|観光|宿泊|賃金|所得)/i;
const JAPAN_LOCAL_RE = /(?:e-?Stat|統計ダッシュボード|[一-龠ぁ-んァ-ヶー]{1,16}(?:都|道|府|県|市|区|町|村))/i;
const EU_RE = /(?:EU27|EU\b|欧州連合|ユーロ圏|Euro\s*area|European Union)/i;
const EU_METRIC_RE = /(人口|失業率|一人当たりGDP|GDP per capita|population|unemployment)/i;
const STABLE_ENTITY_PROPERTY_RE = /(生年月日|誕生日|出生地|標高|設立日|設立年|創立日|創立年|創業日|創業年|国籍|公式サイト)/i;
const CURRENT_SENSITIVE_RE = /(現在|今の|最新|社長|CEO|首相|大統領|会長|代表|ニュース|価格|在庫|時価総額|人口)/i;

function clean(value, max = 4000) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function userContext(text, history = []) {
  const hist = Array.isArray(history)
    ? history.filter((x) => x?.role === 'user').slice(-3).map((x) => clean(x?.content, 600)).filter(Boolean)
    : [];
  return clean(`${hist.join(' ')} ${text}`, 3000);
}

function timeoutSignal(parentSignal, ms = 5200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), ms);
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort(parentSignal.reason);
    else parentSignal.addEventListener('abort', () => controller.abort(parentSignal.reason), { once: true });
  }
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

async function fetchJson(url, { signal, fetchImpl = fetch, headers = {}, timeoutMs = 5200 } = {}) {
  const t = timeoutSignal(signal, timeoutMs);
  try {
    const response = await fetchImpl(url, { headers, signal: t.signal, redirect: 'follow' });
    if (!response.ok) {
      const retryAfter = response.headers?.get?.('retry-after');
      throw new Error(`HTTP ${response.status}${retryAfter ? ` retry-after=${retryAfter}` : ''}`);
    }
    return await response.json();
  } finally {
    t.done();
  }
}

export function detectExtraKnowledgeApiIntents(text, history = []) {
  const context = userContext(text, history);
  const out = [];
  if (JAPAN_STAT_METRIC_RE.test(context) && JAPAN_LOCAL_RE.test(context)) out.push('japan_official_stats');
  if (EU_RE.test(context) && EU_METRIC_RE.test(context)) out.push('eu_official_stats');
  if (STABLE_ENTITY_PROPERTY_RE.test(context) && !CURRENT_SENSITIVE_RE.test(context.replace(STABLE_ENTITY_PROPERTY_RE, ''))) out.push('stable_entity_fact');
  return [...new Set(out)];
}

const JAPAN_METRICS = [
  ['総人口', /人口/i],
  ['世帯数', /世帯/i],
  ['就業者', /就業者|雇用/i],
  ['完全失業率', /失業/i],
  ['住宅数', /住宅/i],
  ['出生数', /出生/i],
  ['死亡数', /死亡/i],
  ['延べ宿泊者数', /観光|宿泊/i],
  ['賃金', /賃金/i],
  ['所得', /所得/i],
];

function japanMetric(text) {
  return JAPAN_METRICS.find(([, re]) => re.test(text))?.[0] || '';
}

function japanRegionName(text) {
  const value = clean(text, 2200);
  const city = value.match(/([一-龠ぁ-んァ-ヶー]{1,12}市)/g)?.at(-1);
  const ward = value.match(/([一-龠ぁ-んァ-ヶー]{1,12}区)/g)?.at(-1);
  const town = value.match(/([一-龠ぁ-んァ-ヶー]{1,12}町)/g)?.at(-1);
  const village = value.match(/([一-龠ぁ-んァ-ヶー]{1,12}村)/g)?.at(-1);
  const prefecture = value.match(/([一-龠ぁ-んァ-ヶー]{1,12}(?:都|道|府|県))/g)?.at(-1);
  const picked = city || ward || town || village || prefecture || '';
  if (!picked) return /(?:日本|全国)/.test(value) ? '全国' : '';
  // If a prefecture name is glued in front of a city (e.g. 大分県別府市), keep
  // only the most specific administrative unit.
  return picked.replace(/^.*?(?:都|道|府|県)(?=.+(?:市|区|町|村)$)/, '');
}

function collectObjects(value, out = [], depth = 0) {
  if (depth > 12 || value == null) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, out, depth + 1);
    return out;
  }
  if (typeof value === 'object') {
    out.push(value);
    for (const item of Object.values(value)) collectObjects(item, out, depth + 1);
  }
  return out;
}

function objectText(obj) {
  try { return clean(JSON.stringify(obj), 5000); } catch { return ''; }
}

function findCodeInObject(obj, pattern) {
  for (const value of Object.values(obj || {})) {
    if (typeof value === 'string' && pattern.test(value)) return value.match(pattern)?.[0] || '';
  }
  return objectText(obj).match(pattern)?.[0] || '';
}

function selectObjectCode(data, pattern, keywords = []) {
  const objects = collectObjects(data);
  const candidates = objects.map((obj) => ({ obj, text: objectText(obj), code: findCodeInObject(obj, pattern) })).filter((x) => x.code);
  if (!candidates.length) return '';
  candidates.sort((a, b) => {
    const sa = keywords.reduce((s, k) => s + (k && a.text.includes(k) ? 3 : 0), 0);
    const sb = keywords.reduce((s, k) => s + (k && b.text.includes(k) ? 3 : 0), 0);
    return sb - sa;
  });
  return candidates[0].code;
}

function valueRecords(data, indicatorCode, regionCode) {
  const out = [];
  for (const obj of collectObjects(data)) {
    const v = obj?.VALUE ?? obj?.Value ?? obj?.value;
    if (v == null) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      const raw = v.$ ?? v._text ?? v['#text'] ?? v.value ?? v.VALUE;
      const num = Number(String(raw ?? '').replace(/,/g, ''));
      if (!Number.isFinite(num)) continue;
      const text = objectText(v);
      const time = clean(v['@time'] ?? v.time ?? text.match(/(?:20|19)\d{2}(?:CY|FY|\d{2})?\d{0,2}/)?.[0], 40);
      const region = clean(v['@region'] ?? v.region ?? regionCode, 40);
      const indicator = clean(v['@indicator'] ?? v.indicator ?? indicatorCode, 40);
      const unit = clean(v['@unit'] ?? v.unit ?? '', 80);
      if (indicatorCode && indicator && !String(indicator).startsWith(indicatorCode)) continue;
      if (regionCode && region && region !== regionCode && !text.includes(regionCode)) continue;
      out.push({ time, value: num, unit, regionCode: region || regionCode, indicatorCode: indicator || indicatorCode });
    } else {
      const num = Number(String(v).replace(/,/g, ''));
      if (Number.isFinite(num)) out.push({ time: '', value: num, unit: '', regionCode, indicatorCode });
    }
  }
  const seen = new Set();
  return out.filter((x) => {
    const key = `${x.time}|${x.value}|${x.regionCode}|${x.indicatorCode}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).sort((a, b) => String(b.time).localeCompare(String(a.time))).slice(0, 8);
}

async function runEStat(text, signal, fetchImpl) {
  const metric = japanMetric(text);
  const regionName = japanRegionName(text);
  if (!metric || !regionName) return { ok:false, tool:'e_stat_dashboard', category:'japan_official_stats', reason:'metric_or_region_not_resolved' };
  let regionCode = regionName === '全国' ? '00000' : '';
  if (!regionCode) {
    const regionUrl = `https://dashboard.e-stat.go.jp/api/1.0/Json/getRegionInfo?Lang=JP&SearchRegionWord=${encodeURIComponent(regionName)}`;
    const regionData = await fetchJson(regionUrl, { signal, fetchImpl, timeoutMs: 4300 });
    regionCode = selectObjectCode(regionData, /\b\d{5}\b/, [regionName]);
  }
  if (!regionCode) return { ok:false, tool:'e_stat_dashboard', category:'japan_official_stats', reason:'region_code_not_found' };
  const indicatorUrl = `https://dashboard.e-stat.go.jp/api/1.0/Json/getIndicatorInfo?Lang=JP&SearchIndicatorWord=${encodeURIComponent(metric)}`;
  const indicatorData = await fetchJson(indicatorUrl, { signal, fetchImpl, timeoutMs: 4300 });
  const indicatorCode = selectObjectCode(indicatorData, /\b\d{19}\b/, [metric]);
  if (!indicatorCode) return { ok:false, tool:'e_stat_dashboard', category:'japan_official_stats', reason:'indicator_code_not_found' };
  const dataUrl = `https://dashboard.e-stat.go.jp/api/1.0/Json/getData?Lang=JP&IndicatorCode=${encodeURIComponent(indicatorCode)}&RegionCode=${encodeURIComponent(regionCode)}&MetaGetFlg=Y&SectionHeaderFlg=1`;
  const data = await fetchJson(dataUrl, { signal, fetchImpl, timeoutMs: 5200 });
  const observations = valueRecords(data, indicatorCode, regionCode);
  if (!observations.length) return { ok:false, tool:'e_stat_dashboard', category:'japan_official_stats', reason:'no_observation' };
  return {
    ok:true, tool:'e_stat_dashboard', category:'japan_official_stats',
    data:{ metric, regionName, regionCode, indicatorCode, latest:observations[0], observations },
    sourceUrl:'https://dashboard.e-stat.go.jp/',
    attribution:EXTRA_KNOWLEDGE_API_REGISTRY.e_stat_dashboard.attribution,
  };
}

const EUROSTAT_METRICS = [
  { id:'population', re:/人口|population/i, dataset:'demo_pjan', filters:{ age:'TOTAL', sex:'T', unit:'NR' }, label:'Population on 1 January' },
  { id:'unemployment', re:/失業率|unemployment/i, dataset:'une_rt_a', filters:{ age:'Y15-74', sex:'T', unit:'PC_ACT' }, label:'Unemployment rate' },
  { id:'gdp_per_capita', re:/一人当たりGDP|GDP per capita/i, dataset:'nama_10_pc', filters:{ na_item:'B1GQ', unit:'CP_EUR_HAB' }, label:'GDP per capita (current euro per inhabitant)' },
];

function eurostatRequest(text) {
  const metric = EUROSTAT_METRICS.find((x) => x.re.test(text));
  if (!metric) return null;
  const geo = /ユーロ圏|Euro\s*area/i.test(text) ? 'EA20' : 'EU27_2020';
  return { metric, geo };
}

function jsonStatTimeSeries(data) {
  const timeIndex = data?.dimension?.time?.category?.index || {};
  const times = Object.entries(timeIndex).map(([label, index]) => ({ label, index:Number(index) })).filter((x) => Number.isFinite(x.index));
  const values = data?.value || {};
  const rows = times.map(({label,index}) => {
    const raw = Array.isArray(values) ? values[index] : values[String(index)];
    const value = Number(raw);
    return Number.isFinite(value) ? { time:label, value } : null;
  }).filter(Boolean).sort((a,b)=>String(b.time).localeCompare(String(a.time)));
  return rows.slice(0, 8);
}

async function runEurostat(text, signal, fetchImpl) {
  const req = eurostatRequest(text);
  if (!req) return { ok:false, tool:'eurostat', category:'eu_official_stats', reason:'metric_not_resolved' };
  const params = new URLSearchParams({ lang:'en', geo:req.geo, ...req.metric.filters });
  const url = `https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/${req.metric.dataset}?${params}`;
  const data = await fetchJson(url, { signal, fetchImpl, timeoutMs: 5600, headers:{ 'User-Agent':'TalkSys/45 (https://talksys.syouziroupc.workers.dev)' } });
  const observations = jsonStatTimeSeries(data);
  if (!observations.length) return { ok:false, tool:'eurostat', category:'eu_official_stats', reason:'no_observation' };
  return {
    ok:true, tool:'eurostat', category:'eu_official_stats',
    data:{ metric:req.metric.id, label:req.metric.label, geo:req.geo, latest:observations[0], observations },
    sourceUrl:`https://ec.europa.eu/eurostat/databrowser/view/${req.metric.dataset}/default/table`,
    attribution:EXTRA_KNOWLEDGE_API_REGISTRY.eurostat.attribution,
  };
}

const WIKIDATA_PROPERTIES = [
  { id:'P569', key:'birthDate', re:/生年月日|誕生日/i, label:'生年月日' },
  { id:'P19', key:'birthPlace', re:/出生地/i, label:'出生地' },
  { id:'P2044', key:'elevation', re:/標高/i, label:'標高' },
  { id:'P571', key:'inception', re:/設立日|設立年|創立日|創立年|創業日|創業年/i, label:'設立・創立' },
  { id:'P27', key:'citizenship', re:/国籍/i, label:'国籍' },
  { id:'P856', key:'officialWebsite', re:/公式サイト/i, label:'公式サイト' },
];

function wikidataRequest(text) {
  const prop = WIKIDATA_PROPERTIES.find((x) => x.re.test(text));
  if (!prop) return null;
  let subject = clean(text, 1000);
  subject = subject.replace(prop.re, '§').split('§')[0].replace(/[のはをについて教えて調べ確認し検索、。！？?！]+$/g, '').trim();
  subject = subject.replace(/^(?:Wikidataで|ウィキデータで)/i, '').trim();
  if (!subject || subject.length > 100) return null;
  return { subject, prop };
}

function snakValue(claim) {
  const value = claim?.mainsnak?.datavalue?.value;
  if (value == null) return null;
  if (typeof value === 'string') return { kind:'string', value };
  if (typeof value === 'object' && value.id) return { kind:'entity', value:value.id };
  if (typeof value === 'object' && value.time) return { kind:'time', value:clean(value.time.replace(/^\+/, '').replace('T00:00:00Z',''), 80), precision:value.precision };
  if (typeof value === 'object' && value.amount != null) return { kind:'quantity', value:Number(value.amount), unit:clean(value.unit, 200) };
  return { kind:'other', value:clean(JSON.stringify(value), 500) };
}

function unitLabel(unit) {
  if (/Q11573$/.test(unit)) return 'm';
  if (/Q828224$/.test(unit)) return 'km';
  return unit ? unit.split('/').pop() : '';
}

async function runWikidata(text, signal, fetchImpl) {
  const req = wikidataRequest(text);
  if (!req) return { ok:false, tool:'wikidata', category:'stable_entity_fact', reason:'entity_or_property_not_resolved' };
  const common = { signal, fetchImpl, timeoutMs:4300, headers:{ 'User-Agent':'TalkSys/45 (https://talksys.syouziroupc.workers.dev)', 'Accept-Encoding':'gzip, deflate' } };
  const searchParams = new URLSearchParams({ action:'wbsearchentities', search:req.subject, language:'ja', uselang:'ja', type:'item', limit:'5', format:'json', maxlag:'5', origin:'*' });
  const search = await fetchJson(`https://www.wikidata.org/w/api.php?${searchParams}`, common);
  const hit = (search?.search || [])[0];
  if (!hit?.id) return { ok:false, tool:'wikidata', category:'stable_entity_fact', reason:'entity_not_found' };
  const entityParams = new URLSearchParams({ action:'wbgetentities', ids:hit.id, props:'labels|descriptions|claims|sitelinks', languages:'ja|en', languagefallback:'1', format:'json', maxlag:'5', origin:'*' });
  const entityData = await fetchJson(`https://www.wikidata.org/w/api.php?${entityParams}`, common);
  const entity = entityData?.entities?.[hit.id];
  const claims = (entity?.claims?.[req.prop.id] || []).map(snakValue).filter(Boolean).slice(0, 6);
  if (!claims.length) return { ok:false, tool:'wikidata', category:'stable_entity_fact', reason:'property_not_found' };
  const linkedIds = [...new Set(claims.filter((x)=>x.kind==='entity').map((x)=>x.value))];
  let linkedLabels = {};
  if (linkedIds.length) {
    const labelParams = new URLSearchParams({ action:'wbgetentities', ids:linkedIds.join('|'), props:'labels|descriptions', languages:'ja|en', languagefallback:'1', format:'json', maxlag:'5', origin:'*' });
    const labelData = await fetchJson(`https://www.wikidata.org/w/api.php?${labelParams}`, common);
    linkedLabels = Object.fromEntries(linkedIds.map((id)=>{
      const x=labelData?.entities?.[id];
      return [id, clean(x?.labels?.ja?.value || x?.labels?.en?.value || id, 160)];
    }));
  }
  const values = claims.map((x)=>{
    if (x.kind==='entity') return { ...x, label:linkedLabels[x.value] || x.value };
    if (x.kind==='quantity') return { ...x, unitLabel:unitLabel(x.unit) };
    return x;
  });
  return {
    ok:true, tool:'wikidata', category:'stable_entity_fact',
    data:{ entityId:hit.id, label:clean(entity?.labels?.ja?.value || hit.label,180), description:clean(entity?.descriptions?.ja?.value || hit.description,300), propertyId:req.prop.id, property:req.prop.label, values },
    sourceUrl:`https://www.wikidata.org/wiki/${hit.id}`,
    attribution:EXTRA_KNOWLEDGE_API_REGISTRY.wikidata.attribution,
  };
}

export async function runExtraKnowledgeApiIntent(intent, text, signal, fetchImpl) {
  if (intent === 'japan_official_stats') return runEStat(text, signal, fetchImpl);
  if (intent === 'eu_official_stats') return runEurostat(text, signal, fetchImpl);
  if (intent === 'stable_entity_fact') return runWikidata(text, signal, fetchImpl);
  return { ok:false, tool:intent, category:intent, reason:'unsupported_extra_intent' };
}

export function publicExtraKnowledgeApiRegistry() {
  return Object.fromEntries(Object.entries(EXTRA_KNOWLEDGE_API_REGISTRY).map(([id,item]) => [id, {
    label:item.label,
    category:item.category,
    free:item.free === true,
    keyRequired:item.keyRequired === true,
    commercialUse:item.commercialUse === true,
    attribution:item.attribution,
    termsUrl:item.termsUrl,
    notes:item.notes,
  }]));
}

export const __test = { japanMetric, japanRegionName, selectObjectCode, valueRecords, eurostatRequest, jsonStatTimeSeries, wikidataRequest, snakValue };

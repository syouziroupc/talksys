export const KNOWLEDGE_API_REVISION = 'free-knowledge-api-v45';

export const KNOWLEDGE_API_REGISTRY = Object.freeze({
  crossref: {
    label: 'Crossref REST API',
    category: 'scholarly_metadata',
    free: true,
    keyRequired: false,
    commercialUse: true,
    attribution: 'Metadata from Crossref',
    termsUrl: 'https://www.crossref.org/documentation/retrieve-metadata/rest-api/',
    notes: '公開REST APIは登録不要・無料。書誌メタデータはほぼ著作権対象外/CC0。abstract本文は著作権があり得るためTalkSysでは取得・再利用しない。',
  },
  world_bank_wdi: {
    label: 'World Bank Indicators API (WDI)',
    category: 'macro_indicator',
    free: true,
    keyRequired: false,
    commercialUse: true,
    attribution: 'World Bank Open Data (CC BY 4.0)',
    termsUrl: 'https://datacatalog.worldbank.org/public-licenses',
    notes: 'APIキー不要。World Bank自身が作成しオープンデータとして配布するWDI指標に限定して利用し、出典を明示する。',
  },
});

const SCHOLARLY_RE = /(DOI|論文|学術|研究論文|ジャーナル|journal|paper|著者|引用|文献)/i;
const MACRO_RE = /(GDP|国内総生産|一人当たりGDP|人口|失業率|インフレ|物価上昇率|平均寿命|出生率)/i;

const COUNTRIES = [
  ['JPN', /(?:日本|Japan|JPN)/i],
  ['USA', /(?:アメリカ|米国|United States|USA)/i],
  ['CHN', /(?:中国|China|CHN)/i],
  ['KOR', /(?:韓国|South Korea|Korea|KOR)/i],
  ['GBR', /(?:イギリス|英国|United Kingdom|Britain|GBR)/i],
  ['DEU', /(?:ドイツ|Germany|DEU)/i],
  ['FRA', /(?:フランス|France|FRA)/i],
  ['ITA', /(?:イタリア|Italy|ITA)/i],
  ['ESP', /(?:スペイン|Spain|ESP)/i],
  ['CAN', /(?:カナダ|Canada|CAN)/i],
  ['AUS', /(?:オーストラリア|Australia|AUS)/i],
  ['NZL', /(?:ニュージーランド|New Zealand|NZL)/i],
  ['IND', /(?:インド|India|IND)/i],
  ['IDN', /(?:インドネシア|Indonesia|IDN)/i],
  ['PHL', /(?:フィリピン|Philippines|PHL)/i],
  ['SGP', /(?:シンガポール|Singapore|SGP)/i],
  ['THA', /(?:タイ|Thailand|THA)/i],
  ['VNM', /(?:ベトナム|Vietnam|VNM)/i],
  ['BRA', /(?:ブラジル|Brazil|BRA)/i],
  ['MEX', /(?:メキシコ|Mexico|MEX)/i],
];

const INDICATORS = [
  ['NY.GDP.PCAP.CD', /(?:一人当たりGDP|GDP per capita)/i, 'GDP per capita (current US$)'],
  ['NY.GDP.MKTP.CD', /(?:GDP|国内総生産)/i, 'GDP (current US$)'],
  ['SP.POP.TOTL', /(?:人口|population)/i, 'Population, total'],
  ['SL.UEM.TOTL.ZS', /(?:失業率|unemployment)/i, 'Unemployment, total (% of total labor force)'],
  ['FP.CPI.TOTL.ZG', /(?:インフレ|物価上昇率|inflation)/i, 'Inflation, consumer prices (annual %)'],
  ['SP.DYN.LE00.IN', /(?:平均寿命|life expectancy)/i, 'Life expectancy at birth, total (years)'],
  ['SP.DYN.TFRT.IN', /(?:出生率|合計特殊出生率|fertility)/i, 'Fertility rate, total (births per woman)'],
];

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
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    t.done();
  }
}

export function detectKnowledgeApiIntents(text, history = []) {
  const context = userContext(text, history);
  const out = [];
  if (SCHOLARLY_RE.test(context)) out.push('scholarly_metadata');
  if (MACRO_RE.test(context) && COUNTRIES.some(([, re]) => re.test(context))) out.push('macro_indicator');
  return out;
}

function doiFrom(text) {
  return clean(text, 2000).match(/10\.\d{4,9}\/[A-Z0-9._;()/:+-]+/i)?.[0]?.replace(/[。,.]+$/, '') || '';
}

function scholarlyQuery(text) {
  return clean(text, 1000)
    .replace(/(?:について|に関する)?(?:論文|研究論文|文献|paper|journal)(?:を)?(?:探して|検索して|調べて|教えて)?/gi, ' ')
    .replace(/[？?。！!]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCrossrefItem(item) {
  const title = Array.isArray(item?.title) ? item.title[0] : item?.title;
  const container = Array.isArray(item?.['container-title']) ? item['container-title'][0] : item?.['container-title'];
  const authors = (item?.author || []).slice(0, 8).map((a) => clean([a?.given, a?.family].filter(Boolean).join(' '), 120)).filter(Boolean);
  const parts = item?.published?.['date-parts']?.[0] || item?.['published-print']?.['date-parts']?.[0] || item?.['published-online']?.['date-parts']?.[0] || [];
  return {
    doi: clean(item?.DOI, 200),
    title: clean(title, 500),
    authors,
    published: parts.filter((x) => Number.isFinite(Number(x))).join('-'),
    container: clean(container, 240),
    publisher: clean(item?.publisher, 180),
    type: clean(item?.type, 80),
    citedByCount: Number(item?.['is-referenced-by-count']) || 0,
    url: clean(item?.URL, 500),
  };
}

async function runCrossref(text, signal, fetchImpl) {
  const doi = doiFrom(text);
  let url;
  if (doi) {
    url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
  } else {
    const query = scholarlyQuery(text);
    if (!query) return { ok: false, tool: 'crossref', category: 'scholarly_metadata', reason: 'query_not_resolved' };
    url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=6`;
  }
  const data = await fetchJson(url, {
    signal,
    fetchImpl,
    timeoutMs: 5500,
    headers: { 'User-Agent': 'TalkSys/45 (https://talksys.syouziroupc.workers.dev)' },
  });
  const message = data?.message;
  const rawItems = doi ? [message] : (message?.items || []);
  const works = rawItems.filter(Boolean).slice(0, 6).map(normalizeCrossrefItem).filter((x) => x.doi || x.title);
  if (!works.length) return { ok: false, tool: 'crossref', category: 'scholarly_metadata', reason: 'no_metadata' };
  return {
    ok: true,
    tool: 'crossref',
    category: 'scholarly_metadata',
    data: { exactDoi: Boolean(doi), works },
    sourceUrl: doi ? `https://doi.org/${doi}` : 'https://api.crossref.org/',
    attribution: KNOWLEDGE_API_REGISTRY.crossref.attribution,
  };
}

export function extractWorldBankRequest(text) {
  const value = clean(text, 2200);
  const country = COUNTRIES.find(([, re]) => re.test(value))?.[0];
  const indicator = INDICATORS.find(([, re]) => re.test(value));
  if (!country || !indicator) return null;
  return { country, indicator: indicator[0], label: indicator[2] };
}

async function runWorldBank(text, signal, fetchImpl) {
  const req = extractWorldBankRequest(text);
  if (!req) return { ok: false, tool: 'world_bank_wdi', category: 'macro_indicator', reason: 'country_or_indicator_not_resolved' };
  const url = `https://api.worldbank.org/v2/country/${req.country}/indicator/${req.indicator}?format=json&per_page=12`;
  const data = await fetchJson(url, { signal, fetchImpl, timeoutMs: 5200 });
  const rows = Array.isArray(data) ? (data[1] || []) : [];
  const observations = rows.filter((x) => x?.value !== null && x?.value !== undefined).slice(0, 6).map((x) => ({
    country: clean(x?.country?.value, 120),
    countryCode: clean(x?.countryiso3code || req.country, 20),
    indicator: req.label,
    indicatorCode: req.indicator,
    year: clean(x?.date, 20),
    value: x?.value,
    unit: clean(x?.unit, 80),
  }));
  if (!observations.length) return { ok: false, tool: 'world_bank_wdi', category: 'macro_indicator', reason: 'no_observation' };
  return {
    ok: true,
    tool: 'world_bank_wdi',
    category: 'macro_indicator',
    data: { latest: observations[0], observations },
    sourceUrl: 'https://data.worldbank.org/',
    attribution: KNOWLEDGE_API_REGISTRY.world_bank_wdi.attribution,
  };
}

async function runIntent(intent, text, history, signal, fetchImpl) {
  const context = userContext(text, history);
  if (intent === 'scholarly_metadata') return runCrossref(context, signal, fetchImpl);
  if (intent === 'macro_indicator') return runWorldBank(context, signal, fetchImpl);
  return { ok: false, tool: intent, category: intent, reason: 'unsupported_intent' };
}

export async function runKnowledgeApiTools(text, history = [], signal, options = {}) {
  const startedAt = Date.now();
  const intents = detectKnowledgeApiIntents(text, history);
  if (!intents.length) return {
    revision: KNOWLEDGE_API_REVISION,
    recognized: false,
    intents: [],
    results: [],
    sufficient: false,
    webSupplementRecommended: true,
    elapsedMs: Date.now() - startedAt,
  };
  const settled = await Promise.allSettled(intents.map((intent) => runIntent(intent, text, history, signal, options.fetchImpl)));
  const results = settled.map((item, i) => item.status === 'fulfilled'
    ? item.value
    : { ok: false, tool: intents[i], category: intents[i], reason: clean(item.reason?.message || item.reason, 180) });
  const covered = new Set(results.filter((x) => x?.ok).map((x) => x.category));
  const sufficient = intents.every((intent) => covered.has(intent));
  return {
    revision: KNOWLEDGE_API_REVISION,
    recognized: true,
    intents,
    results,
    sufficient,
    webSupplementRecommended: !sufficient,
    apiFirst: true,
    parallelApiExecution: intents.length > 1,
    elapsedMs: Date.now() - startedAt,
  };
}

export function mergeApiBundles(...bundles) {
  const valid = bundles.filter(Boolean);
  const recognized = valid.filter((x) => x.recognized === true);
  const results = valid.flatMap((x) => Array.isArray(x.results) ? x.results : []);
  const intents = [...new Set(valid.flatMap((x) => Array.isArray(x.intents) ? x.intents : []))];
  const sufficient = recognized.length > 0 && recognized.every((x) => x.sufficient === true);
  return {
    revision: valid.map((x) => x.revision).filter(Boolean).join('+'),
    recognized: recognized.length > 0,
    intents,
    results,
    sufficient,
    webSupplementRecommended: recognized.length === 0 || recognized.some((x) => x.webSupplementRecommended === true),
    apiFirst: true,
    parallelApiExecution: valid.length > 1 || valid.some((x) => x.parallelApiExecution === true),
    elapsedMs: Math.max(0, ...valid.map((x) => Number(x.elapsedMs) || 0)),
  };
}

export function publicKnowledgeApiRegistry() {
  return Object.fromEntries(Object.entries(KNOWLEDGE_API_REGISTRY).map(([id, item]) => [id, {
    label: item.label,
    category: item.category,
    free: item.free === true,
    keyRequired: item.keyRequired === true,
    commercialUse: item.commercialUse === true,
    attribution: item.attribution,
    termsUrl: item.termsUrl,
    notes: item.notes,
  }]));
}

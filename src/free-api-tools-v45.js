export const FREE_API_REVISION = 'free-api-router-v45-terms-aware';

export const FREE_API_REGISTRY = Object.freeze({
  jma_weather: {
    label: '気象庁 防災情報JSON',
    category: 'weather',
    free: true,
    keyRequired: false,
    commercialUse: true,
    attribution: '出典：気象庁ホームページ',
    termsUrl: 'https://www.jma.go.jp/jma/kishou/info/coment.html',
    notes: '公開予報をそのまま利用。独自予報へ改変しない。取得結果は短時間キャッシュする。',
  },
  met_norway: {
    label: 'MET Norway Locationforecast',
    category: 'weather',
    free: true,
    keyRequired: false,
    commercialUse: true,
    attribution: 'Data from MET Norway',
    termsUrl: 'https://api.met.no/doc/TermsOfService',
    notes: 'CC BY 4.0/NLOD。識別User-Agent必須。Expiresを尊重してキャッシュ。',
  },
  frankfurter: {
    label: 'Frankfurter exchange rates',
    category: 'exchange_rate',
    free: true,
    keyRequired: false,
    commercialUse: true,
    attribution: 'Exchange-rate data via Frankfurter',
    termsUrl: 'https://frankfurter.dev/',
    notes: '商用利用可。月次・日次クォータなし（abuse防止rate-limitあり）。',
  },
  jma_earthquake: {
    label: '気象庁 地震情報JSON',
    category: 'earthquake',
    free: true,
    keyRequired: false,
    commercialUse: true,
    attribution: '出典：気象庁ホームページ',
    termsUrl: 'https://www.jma.go.jp/jma/kishou/info/coment.html',
    notes: '気象庁公開コンテンツ利用条件に従い、出典を明示する。',
  },
  usgs_earthquake: {
    label: 'USGS Earthquake Hazards Program',
    category: 'earthquake',
    free: true,
    keyRequired: false,
    commercialUse: true,
    attribution: 'Source: U.S. Geological Survey',
    termsUrl: 'https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits',
    notes: 'USGS作成データは原則U.S. public domain。第三者素材は除く。',
  },
  nager_holidays: {
    label: 'Nager.Date Community Holiday API',
    category: 'holiday',
    free: true,
    keyRequired: false,
    commercialUse: true,
    attribution: 'Holiday data via Nager.Date',
    termsUrl: 'https://date.nager.at/Api',
    notes: '公開Community REST API。APIページはrequest limitなしを明記。プロジェクトはMIT。',
  },
  geoapify: {
    label: 'Geoapify Free plan',
    category: 'geocoding_routing',
    free: true,
    keyRequired: true,
    envKey: 'GEOAPIFY_API_KEY',
    commercialUse: true,
    attribution: 'Powered by Geoapify; © OpenStreetMap contributors',
    termsUrl: 'https://www.geoapify.com/terms-and-conditions/',
    notes: 'Free 3,000 credits/day、最大5 req/s、クレカ不要。無料枠ではGeoapify/OSM帰属表示必須。',
  },
  odpt: {
    label: '公共交通オープンデータセンター',
    category: 'transit_status',
    free: true,
    keyRequired: true,
    envKey: 'ODPT_API_TOKEN',
    commercialUse: true,
    attribution: '公共交通オープンデータセンター提供データ',
    termsUrl: 'https://developer.odpt.org/terms',
    notes: 'ユーザー登録・トークン必須。各データ提供者の個別利用条件にも従う。動的データは生成時刻を併記する。',
  },
  navitime_market: {
    label: 'NAVITIME API Market BASIC',
    category: 'transit_route',
    free: true,
    keyRequired: true,
    envKey: 'NAVITIME_API_KEY',
    commercialUse: true,
    attribution: 'NAVITIME API',
    termsUrl: 'https://api-sdk.navitime.co.jp/api/specs/',
    notes: 'API Market BASICは500アクセス上限の無料プラン。契約先によりURL/認証が異なるため自動呼出しは設定時のみ。',
    adapterEnabled: false,
  },
});

const WEATHER_RE = /(天気|天候|気温|降水|雨|晴|曇|雪|予報|最高気温|最低気温)/i;
const EARTHQUAKE_RE = /(地震|震度|震源|マグニチュード|津波)/i;
const FX_RE = /(為替|レート|両替|円換算|ドル|ユーロ|ポンド|USD|JPY|EUR|GBP|AUD|CAD|CHF|CNY|KRW|NZD|SGD|HKD)/i;
const HOLIDAY_RE = /(祝日|休日|祭日|public holiday|bank holiday)/i;
const TRANSIT_RE = /(電車|鉄道|乗換|乗り換え|列車|運行情報|遅延|運休|時刻表|何時発|何に乗)/i;
const ROUTE_RE = /(経路|ルート|行き方|所要時間|距離|車で|徒歩で|自転車で)/i;
const PLACE_RE = /(近く|周辺|店舗|店|施設|病院|ホテル|レストラン|飲食店|カフェ)/i;

const CURRENCY_ALIASES = [
  ['USD', /(?:USD|米ドル|アメリカドル|ドル)/i],
  ['JPY', /(?:JPY|日本円|円)/i],
  ['EUR', /(?:EUR|ユーロ)/i],
  ['GBP', /(?:GBP|英ポンド|ポンド)/i],
  ['AUD', /(?:AUD|豪ドル|オーストラリアドル)/i],
  ['CAD', /(?:CAD|加ドル|カナダドル)/i],
  ['CHF', /(?:CHF|スイスフラン|フラン)/i],
  ['CNY', /(?:CNY|人民元|中国元|元)/i],
  ['KRW', /(?:KRW|韓国ウォン|ウォン)/i],
  ['NZD', /(?:NZD|NZドル|ニュージーランドドル)/i],
  ['SGD', /(?:SGD|シンガポールドル)/i],
  ['HKD', /(?:HKD|香港ドル)/i],
];

const COUNTRY_ALIASES = [
  ['JP', /(?:日本|Japan|JP)/i], ['US', /(?:アメリカ|米国|USA|United States|US)/i],
  ['GB', /(?:イギリス|英国|United Kingdom|UK|GB)/i], ['DE', /(?:ドイツ|Germany|DE)/i],
  ['FR', /(?:フランス|France|FR)/i], ['IT', /(?:イタリア|Italy|IT)/i],
  ['ES', /(?:スペイン|Spain|ES)/i], ['CA', /(?:カナダ|Canada|CA)/i],
  ['AU', /(?:オーストラリア|Australia|AU)/i], ['NZ', /(?:ニュージーランド|New Zealand|NZ)/i],
  ['KR', /(?:韓国|South Korea|Korea|KR)/i], ['CN', /(?:中国|China|CN)/i],
  ['SG', /(?:シンガポール|Singapore|SG)/i], ['CH', /(?:スイス|Switzerland|CH)/i],
];

function clean(value, max = 5000) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function joinedUserContext(text, history = []) {
  const hist = Array.isArray(history)
    ? history.filter((x) => x?.role === 'user').slice(-4).map((x) => clean(x?.content, 600)).filter(Boolean)
    : [];
  return clean(`${hist.join(' ')} ${text}`, 3600);
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function nowYear() {
  return new Date().getUTCFullYear();
}

function timeoutSignal(parentSignal, ms = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), ms);
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort(parentSignal.reason);
    else parentSignal.addEventListener('abort', () => controller.abort(parentSignal.reason), { once: true });
  }
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

function cacheTtlFromExpires(value, fallback = 900) {
  const expires = Date.parse(value || '');
  if (!Number.isFinite(expires)) return fallback;
  return Math.max(60, Math.min(7200, Math.floor((expires - Date.now()) / 1000)));
}

async function fetchJson(url, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const method = options.method || 'GET';
  const request = new Request(url, { method, headers: options.headers || {} });
  const cache = method === 'GET' ? globalThis.caches?.default : null;
  if (cache && options.cacheTtl !== 0) {
    try {
      const cached = await cache.match(request);
      if (cached) return { data: await cached.json(), status: cached.status, headers: cached.headers, cached: true };
    } catch {}
  }
  const t = timeoutSignal(options.signal, options.timeoutMs || 5200);
  try {
    const response = await fetchImpl(request, { signal: t.signal, redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (cache && options.cacheTtl !== 0) {
      const expiresTtl = cacheTtlFromExpires(response.headers.get('expires'), options.cacheTtl || 900);
      const ttl = Math.max(30, options.cacheTtlFromResponse ? expiresTtl : (options.cacheTtl || expiresTtl));
      const cachedResponse = new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${ttl}` },
      });
      try { await cache.put(request, cachedResponse); } catch {}
    }
    return { data, status: response.status, headers: response.headers, cached: false };
  } finally {
    t.done();
  }
}

export function detectApiIntents(text, history = []) {
  const context = joinedUserContext(text, history);
  const intents = [];
  if (WEATHER_RE.test(context)) intents.push('weather');
  if (EARTHQUAKE_RE.test(context)) intents.push('earthquake');
  if (FX_RE.test(context)) intents.push('exchange_rate');
  if (HOLIDAY_RE.test(context)) intents.push('holiday');
  if (TRANSIT_RE.test(context)) intents.push('transit');
  if (ROUTE_RE.test(context) && !TRANSIT_RE.test(context)) intents.push('route');
  if (PLACE_RE.test(context) && !ROUTE_RE.test(context) && !TRANSIT_RE.test(context)) intents.push('places');
  return unique(intents);
}

function stripGeoSuffix(value) {
  return clean(value, 120).replace(/(?:都|道|府|県|市|区|町|村|地方)$/u, '');
}

function areaEntries(area) {
  const groups = ['class20s', 'class15s', 'class10s', 'offices', 'centers'];
  const out = [];
  for (const group of groups) {
    for (const [code, item] of Object.entries(area?.[group] || {})) {
      out.push({ group, code, name: clean(item?.name, 120), parent: clean(item?.parent, 30), raw: item });
    }
  }
  return out;
}

export function selectJmaOfficeFromArea(area, text) {
  const input = clean(text, 1800);
  const entries = areaEntries(area);
  const byCode = new Map(entries.map((x) => [x.code, x]));
  const candidates = entries.filter((x) => {
    if (!x.name) return false;
    const stripped = stripGeoSuffix(x.name);
    return input.includes(x.name) || (stripped.length >= 2 && input.includes(stripped));
  }).sort((a, b) => b.name.length - a.name.length);
  for (const candidate of candidates) {
    let cur = candidate;
    for (let depth = 0; depth < 6 && cur; depth += 1) {
      if (cur.group === 'offices') return { officeCode: cur.code, officeName: cur.name, matchedArea: candidate.name };
      cur = byCode.get(cur.parent);
    }
  }
  return null;
}

function jmaForecastSummary(data, office) {
  const blocks = Array.isArray(data) ? data : [];
  const first = blocks[0] || {};
  const timeSeries = Array.isArray(first.timeSeries) ? first.timeSeries : [];
  const weatherSeries = timeSeries.find((x) => Array.isArray(x?.areas) && x.areas.some((a) => Array.isArray(a?.weathers))) || timeSeries[0];
  const popSeries = timeSeries.find((x) => Array.isArray(x?.areas) && x.areas.some((a) => Array.isArray(a?.pops)));
  const tempSeries = timeSeries.find((x) => Array.isArray(x?.areas) && x.areas.some((a) => Array.isArray(a?.temps)));
  const weatherArea = weatherSeries?.areas?.[0] || {};
  const popArea = popSeries?.areas?.[0] || {};
  const tempArea = tempSeries?.areas?.[0] || {};
  const times = weatherSeries?.timeDefines || [];
  const periods = times.slice(0, 4).map((time, i) => ({
    time,
    weather: clean(weatherArea?.weathers?.[i] || '', 220),
    weatherCode: clean(weatherArea?.weatherCodes?.[i] || '', 20),
    wind: clean(weatherArea?.winds?.[i] || '', 180),
  }));
  const precipitation = (popSeries?.timeDefines || []).slice(0, 8).map((time, i) => ({ time, probabilityPercent: clean(popArea?.pops?.[i] || '', 10) }));
  const temperatures = (tempSeries?.timeDefines || []).slice(0, 6).map((time, i) => ({ time, celsius: clean(tempArea?.temps?.[i] || '', 10) }));
  return {
    publishingOffice: clean(first?.publishingOffice || office?.officeName, 120),
    reportDatetime: clean(first?.reportDatetime, 80),
    targetArea: clean(weatherArea?.area?.name || office?.matchedArea || office?.officeName, 120),
    periods,
    precipitation,
    temperatures,
  };
}

async function runJmaWeather(text, signal, fetchImpl) {
  const areaRes = await fetchJson('https://www.jma.go.jp/bosai/common/const/area.json', { signal, fetchImpl, cacheTtl: 86400, timeoutMs: 5000 });
  const office = selectJmaOfficeFromArea(areaRes.data, text);
  if (!office) return { ok: false, tool: 'jma_weather', reason: 'location_not_resolved' };
  const url = `https://www.jma.go.jp/bosai/forecast/data/forecast/${encodeURIComponent(office.officeCode)}.json`;
  const forecast = await fetchJson(url, { signal, fetchImpl, cacheTtl: 600, timeoutMs: 5000 });
  return {
    ok: true,
    tool: 'jma_weather',
    category: 'weather',
    data: jmaForecastSummary(forecast.data, office),
    sourceUrl: url,
    attribution: FREE_API_REGISTRY.jma_weather.attribution,
  };
}

function explicitCoordinates(text) {
  const m = clean(text, 1200).match(/(-?\d{1,2}(?:\.\d+)?)\s*[,，]\s*(-?\d{1,3}(?:\.\d+)?)/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon, label: `${lat},${lon}` };
}

function extractWeatherPlace(text) {
  let q = clean(text, 300);
  q = q.replace(/(?:今日|明日|明後日|今週|週末|現在|いま|今)/g, ' ')
    .replace(/(?:の)?(?:天気|天候|気温|降水確率|予報|最高気温|最低気温).*/i, ' ')
    .replace(/[？?。！!]/g, ' ');
  return clean(q, 140);
}

async function geoapifyGeocode(place, env, signal, fetchImpl) {
  const key = clean(env?.GEOAPIFY_API_KEY, 300);
  if (!key || !place) return null;
  const url = `https://api.geoapify.com/v1/geocode/search?text=${encodeURIComponent(place)}&format=json&limit=3&apiKey=${encodeURIComponent(key)}`;
  const res = await fetchJson(url, { signal, fetchImpl, cacheTtl: 86400, timeoutMs: 5000 });
  const candidate = res.data?.results?.[0];
  if (!candidate) return null;
  return {
    lat: Number(candidate.lat),
    lon: Number(candidate.lon),
    label: clean(candidate.formatted || candidate.address_line1 || place, 200),
    sourceUrl: 'https://www.geoapify.com/geocoding-api/',
  };
}

function metForecastSummary(data, place) {
  const series = data?.properties?.timeseries || [];
  return {
    location: place?.label || '',
    updatedAt: clean(data?.properties?.meta?.updated_at, 80),
    units: data?.properties?.meta?.units || {},
    periods: series.slice(0, 18).map((x) => ({
      time: x?.time,
      temperature: x?.data?.instant?.details?.air_temperature,
      humidity: x?.data?.instant?.details?.relative_humidity,
      windSpeed: x?.data?.instant?.details?.wind_speed,
      symbol: x?.data?.next_1_hours?.summary?.symbol_code || x?.data?.next_6_hours?.summary?.symbol_code || '',
      precipitation: x?.data?.next_1_hours?.details?.precipitation_amount ?? x?.data?.next_6_hours?.details?.precipitation_amount,
    })),
  };
}

async function runMetWeather(text, env, signal, fetchImpl) {
  let coords = explicitCoordinates(text);
  let geoAttribution = null;
  if (!coords) {
    const place = extractWeatherPlace(text);
    coords = await geoapifyGeocode(place, env, signal, fetchImpl);
    if (coords) geoAttribution = FREE_API_REGISTRY.geoapify.attribution;
  }
  if (!coords) return { ok: false, tool: 'met_norway', reason: env?.GEOAPIFY_API_KEY ? 'location_not_resolved' : 'geoapify_key_missing' };
  const lat = Number(coords.lat).toFixed(4);
  const lon = Number(coords.lon).toFixed(4);
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
  const res = await fetchJson(url, {
    signal,
    fetchImpl,
    cacheTtl: 1800,
    cacheTtlFromResponse: true,
    timeoutMs: 5200,
    headers: { 'User-Agent': 'TalkSys/45 https://talksys.syouziroupc.workers.dev' },
  });
  return {
    ok: true,
    tool: 'met_norway',
    category: 'weather',
    data: metForecastSummary(res.data, coords),
    sourceUrl: url,
    attribution: [FREE_API_REGISTRY.met_norway.attribution, geoAttribution].filter(Boolean).join(' / '),
  };
}

async function runWeather(text, env, signal, fetchImpl) {
  try {
    const jma = await runJmaWeather(text, signal, fetchImpl);
    if (jma.ok) return jma;
  } catch {}
  return runMetWeather(text, env, signal, fetchImpl);
}

export function extractFxRequest(text) {
  const value = clean(text, 1800);
  const found = [];
  for (const [code, re] of CURRENCY_ALIASES) {
    const m = value.match(re);
    if (m) found.push({ code, index: m.index ?? 9999, token: m[0] });
  }
  found.sort((a, b) => a.index - b.index);
  const codes = unique(found.map((x) => x.code));
  if (codes.length < 2) return null;
  const amountMatch = value.match(/([0-9][0-9,]*(?:\.[0-9]+)?)/);
  const amount = amountMatch ? Number(amountMatch[1].replace(/,/g, '')) : 1;
  return { base: codes[0], quote: codes[1], amount: Number.isFinite(amount) ? amount : 1 };
}

async function runFx(text, signal, fetchImpl) {
  const req = extractFxRequest(text);
  if (!req) return { ok: false, tool: 'frankfurter', reason: 'currency_pair_not_resolved' };
  const url = `https://api.frankfurter.dev/v2/rate/${encodeURIComponent(req.base)}/${encodeURIComponent(req.quote)}`;
  const res = await fetchJson(url, { signal, fetchImpl, cacheTtl: 1800, timeoutMs: 4500 });
  const rate = Number(res.data?.rate);
  if (!Number.isFinite(rate)) return { ok: false, tool: 'frankfurter', reason: 'rate_missing' };
  return {
    ok: true,
    tool: 'frankfurter',
    category: 'exchange_rate',
    data: { date: res.data?.date, base: req.base, quote: req.quote, rate, amount: req.amount, converted: req.amount * rate },
    sourceUrl: 'https://frankfurter.dev/',
    attribution: FREE_API_REGISTRY.frankfurter.attribution,
  };
}

function normalizeJmaQuakes(data) {
  return (Array.isArray(data) ? data : []).slice(0, 12).map((x) => ({
    observedAt: clean(x?.at, 80),
    hypocenter: clean(x?.anm || x?.en_anm, 140),
    magnitude: clean(x?.mag, 20),
    maxIntensity: clean(x?.maxi, 20),
    coordinate: clean(x?.cod, 80),
    title: clean(x?.ttl, 160),
  })).filter((x) => x.observedAt || x.hypocenter);
}

function normalizeUsgsQuakes(data) {
  return (data?.features || []).slice(0, 12).map((x) => ({
    observedAt: x?.properties?.time ? new Date(x.properties.time).toISOString() : '',
    place: clean(x?.properties?.place, 180),
    magnitude: x?.properties?.mag,
    alert: clean(x?.properties?.alert, 40),
    tsunami: x?.properties?.tsunami,
    url: clean(x?.properties?.url, 500),
  }));
}

async function runEarthquakes(signal, fetchImpl) {
  const [jma, usgs] = await Promise.allSettled([
    fetchJson('https://www.jma.go.jp/bosai/quake/data/list.json', { signal, fetchImpl, cacheTtl: 180, timeoutMs: 4600 }),
    fetchJson('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson', { signal, fetchImpl, cacheTtl: 180, timeoutMs: 4600 }),
  ]);
  const jmaData = jma.status === 'fulfilled' ? normalizeJmaQuakes(jma.value.data) : [];
  const usgsData = usgs.status === 'fulfilled' ? normalizeUsgsQuakes(usgs.value.data) : [];
  if (!jmaData.length && !usgsData.length) return { ok: false, tool: 'earthquake_apis', reason: 'both_failed' };
  return {
    ok: true,
    tool: 'earthquake_apis',
    category: 'earthquake',
    data: { japanRecent: jmaData, worldLast24h: usgsData },
    sourceUrl: 'https://www.jma.go.jp/bosai/map.html#contents=earthquake_map ; https://earthquake.usgs.gov/',
    attribution: `${FREE_API_REGISTRY.jma_earthquake.attribution} / ${FREE_API_REGISTRY.usgs_earthquake.attribution}`,
  };
}

export function extractHolidayRequest(text) {
  const value = clean(text, 1600);
  const country = COUNTRY_ALIASES.find(([, re]) => re.test(value))?.[0] || 'JP';
  const yearMatch = value.match(/(?:19|20)\d{2}/);
  return { country, year: yearMatch ? Number(yearMatch[0]) : nowYear() };
}

async function runHolidays(text, signal, fetchImpl) {
  const req = extractHolidayRequest(text);
  const years = unique([req.year, req.year + 1]).slice(0, 2);
  const responses = await Promise.allSettled(years.map((year) => fetchJson(
    `https://date.nager.at/api/v3/publicholidays/${year}/${encodeURIComponent(req.country)}`,
    { signal, fetchImpl, cacheTtl: 21600, timeoutMs: 4500 },
  )));
  const holidays = [];
  responses.forEach((r, i) => {
    if (r.status !== 'fulfilled' || !Array.isArray(r.value.data)) return;
    for (const x of r.value.data) holidays.push({
      date: clean(x?.date, 30), localName: clean(x?.localName, 160), name: clean(x?.name, 160),
      global: x?.global === true, types: Array.isArray(x?.types) ? x.types.slice(0, 8) : [], year: years[i],
    });
  });
  if (!holidays.length) return { ok: false, tool: 'nager_holidays', reason: 'no_data' };
  return {
    ok: true,
    tool: 'nager_holidays',
    category: 'holiday',
    data: { country: req.country, holidays: holidays.slice(0, 40) },
    sourceUrl: 'https://date.nager.at/Api',
    attribution: FREE_API_REGISTRY.nager_holidays.attribution,
  };
}

function cleanRoutePart(value) {
  return clean(value, 180)
    .replace(/^(?:現在地|ここ)\s*/i, '')
    .replace(/(?:まで|へ|に)(?:車|徒歩|自転車)?(?:で)?(?:行|向).*/i, '')
    .replace(/(?:車|徒歩|自転車)(?:で)?(?:の)?(?:経路|ルート|行き方|所要時間).*/i, '')
    .replace(/[？?。！!]/g, '')
    .trim();
}

export function extractRoutePlaces(text) {
  const value = clean(text, 1200);
  const m = value.match(/(.+?)(?:から|→|->|〜|～)(.+)/);
  if (!m) return null;
  const from = cleanRoutePart(m[1]);
  const to = cleanRoutePart(m[2]);
  if (!from || !to) return null;
  const mode = /徒歩/i.test(value) ? 'walk' : /自転車|チャリ|サイクリング/i.test(value) ? 'bicycle' : 'drive';
  return { from, to, mode };
}

async function runGeoapifyRoute(text, env, signal, fetchImpl) {
  const key = clean(env?.GEOAPIFY_API_KEY, 300);
  if (!key) return { ok: false, tool: 'geoapify_route', reason: 'GEOAPIFY_API_KEY_missing' };
  const req = extractRoutePlaces(text);
  if (!req) return { ok: false, tool: 'geoapify_route', reason: 'route_endpoints_not_resolved' };
  const [from, to] = await Promise.all([
    geoapifyGeocode(req.from, env, signal, fetchImpl),
    geoapifyGeocode(req.to, env, signal, fetchImpl),
  ]);
  if (!from || !to) return { ok: false, tool: 'geoapify_route', reason: 'geocode_failed' };
  const mode = req.mode === 'walk' ? 'walk' : req.mode === 'bicycle' ? 'bicycle' : 'drive';
  const url = `https://api.geoapify.com/v1/routing?waypoints=${from.lat},${from.lon}%7C${to.lat},${to.lon}&mode=${mode}&details=instruction_details&apiKey=${encodeURIComponent(key)}`;
  const res = await fetchJson(url, { signal, fetchImpl, cacheTtl: 300, timeoutMs: 6000 });
  const feature = res.data?.features?.[0];
  const props = feature?.properties || {};
  return {
    ok: Boolean(feature),
    tool: 'geoapify_route',
    category: 'route',
    reason: feature ? '' : 'route_missing',
    data: feature ? {
      from: from.label, to: to.label, mode,
      distanceMeters: props.distance,
      timeSeconds: props.time,
      legs: (props.legs || []).slice(0, 4).map((leg) => ({ distance: leg?.distance, time: leg?.time, steps: (leg?.steps || []).slice(0, 20).map((s) => ({ instruction: clean(s?.instruction?.text || s?.instruction, 180), distance: s?.distance, time: s?.time })) })),
    } : null,
    sourceUrl: 'https://www.geoapify.com/routing-api/',
    attribution: FREE_API_REGISTRY.geoapify.attribution,
  };
}

async function runOdptStatus(env, signal, fetchImpl) {
  const token = clean(env?.ODPT_API_TOKEN, 500);
  if (!token) return { ok: false, tool: 'odpt', reason: 'ODPT_API_TOKEN_missing' };
  const url = `https://api.odpt.org/api/v4/odpt:TrainInformation?acl:consumerKey=${encodeURIComponent(token)}`;
  const res = await fetchJson(url, { signal, fetchImpl, cacheTtl: 60, timeoutMs: 5200 });
  const items = (Array.isArray(res.data) ? res.data : []).slice(0, 30).map((x) => ({
    railway: clean(x?.['odpt:railway'], 160),
    operator: clean(x?.['odpt:operator'], 160),
    timeOfOrigin: clean(x?.['odpt:timeOfOrigin'], 80),
    status: clean(x?.['odpt:trainInformationText']?.ja || x?.['odpt:trainInformationText']?.en || x?.['odpt:trainInformationText'], 400),
  }));
  return {
    ok: items.length > 0,
    tool: 'odpt',
    category: 'transit',
    reason: items.length ? '' : 'no_status_data',
    data: { generatedAt: new Date().toISOString(), items },
    sourceUrl: 'https://developer.odpt.org/',
    attribution: FREE_API_REGISTRY.odpt.attribution,
  };
}

async function runOneIntent(intent, text, history, env, signal, fetchImpl) {
  if (intent === 'weather') return runWeather(joinedUserContext(text, history), env, signal, fetchImpl);
  if (intent === 'earthquake') return runEarthquakes(signal, fetchImpl);
  if (intent === 'exchange_rate') return runFx(joinedUserContext(text, history), signal, fetchImpl);
  if (intent === 'holiday') return runHolidays(joinedUserContext(text, history), signal, fetchImpl);
  if (intent === 'route') return runGeoapifyRoute(joinedUserContext(text, history), env, signal, fetchImpl);
  if (intent === 'transit') return runOdptStatus(env, signal, fetchImpl);
  if (intent === 'places') return { ok: false, tool: 'geoapify_places', category: 'places', reason: env?.GEOAPIFY_API_KEY ? 'free_text_places_not_enabled' : 'GEOAPIFY_API_KEY_missing' };
  return { ok: false, tool: 'unknown', reason: 'unsupported_intent' };
}

export async function runFreeApiTools(text, history = [], env = {}, signal, options = {}) {
  const startedAt = Date.now();
  const intents = detectApiIntents(text, history);
  if (!intents.length) {
    return {
      revision: FREE_API_REVISION,
      recognized: false,
      intents: [],
      results: [],
      sufficient: false,
      webSupplementRecommended: true,
      elapsedMs: Date.now() - startedAt,
    };
  }
  const settled = await Promise.allSettled(intents.map((intent) => runOneIntent(intent, text, history, env, signal, options.fetchImpl)));
  const results = settled.map((item, index) => item.status === 'fulfilled'
    ? item.value
    : { ok: false, tool: intents[index], category: intents[index], reason: clean(item.reason?.message || item.reason, 180) });
  const covered = new Set(results.filter((x) => x?.ok).map((x) => x.category));
  const allCovered = intents.every((intent) => covered.has(intent));
  const transitNeedsWeb = intents.includes('transit');
  const placesNeedsWeb = intents.includes('places');
  const webSupplementRecommended = !allCovered || transitNeedsWeb || placesNeedsWeb;
  return {
    revision: FREE_API_REVISION,
    recognized: true,
    intents,
    results,
    sufficient: allCovered && !transitNeedsWeb && !placesNeedsWeb,
    webSupplementRecommended,
    apiFirst: true,
    parallelApiExecution: intents.length > 1,
    elapsedMs: Date.now() - startedAt,
  };
}

export function apiEvidenceText(bundle, maxChars = 12000) {
  const parts = [];
  for (const result of bundle?.results || []) {
    if (!result?.ok) continue;
    const payload = JSON.stringify(result.data ?? {});
    parts.push(`API: ${result.tool}\nCategory: ${result.category}\nSource: ${result.sourceUrl || ''}\nAttribution: ${result.attribution || ''}\nData: ${payload.slice(0, 7000)}`);
  }
  return clean(parts.join('\n\n'), maxChars);
}

export function publicApiRegistry() {
  return Object.fromEntries(Object.entries(FREE_API_REGISTRY).map(([id, item]) => [id, {
    label: item.label,
    category: item.category,
    free: item.free === true,
    keyRequired: item.keyRequired === true,
    commercialUse: item.commercialUse === true,
    attribution: item.attribution,
    termsUrl: item.termsUrl,
    notes: item.notes,
    adapterEnabled: item.adapterEnabled !== false,
  }]));
}

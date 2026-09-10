// Formal shopping API adapters for TalkSys v45.
//
// General-purpose HTML/RSS search is intentionally not used here. Each adapter
// targets a documented commerce API and is disabled unless the operator has
// supplied credentials and explicitly opted in after satisfying attribution
// and provider terms for the deployed application.

export const SHOPPING_API_REVISION = 'formal-shopping-api-v45';

export const SHOPPING_API_REGISTRY = Object.freeze({
  yahoo_jp_shopping: Object.freeze({
    category: 'shopping',
    endpoint: 'https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch',
    requiresKey: true,
    keyEnv: 'YAHOO_JP_CLIENT_ID',
    enableEnv: 'YAHOO_SHOPPING_ENABLE',
    attributionAckEnv: 'YAHOO_SHOPPING_ATTRIBUTION_OK',
    activation: 'requires key + YAHOO_SHOPPING_ENABLE=1 + YAHOO_SHOPPING_ATTRIBUTION_OK=1',
    publicDocs: 'https://developer.yahoo.co.jp/webapi/shopping/v3/itemsearch.html',
    terms: 'https://developer.yahoo.co.jp/guideline/',
    attribution: 'Webサービス by Yahoo! JAPAN credit is required on the application/site.',
    rateLimit: '1 query/second guidance for identical or short-interval access.',
    billing: 'No per-request charge is documented on the public item-search page; operator registration is required.',
  }),
  rakuten_ichiba: Object.freeze({
    category: 'shopping',
    endpoint: 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701',
    requiresKey: true,
    keyEnv: 'RAKUTEN_APPLICATION_ID + RAKUTEN_ACCESS_KEY',
    enableEnv: 'RAKUTEN_SHOPPING_ENABLE',
    attributionAckEnv: 'RAKUTEN_SHOPPING_ATTRIBUTION_OK',
    activation: 'requires both keys + RAKUTEN_SHOPPING_ENABLE=1 + RAKUTEN_SHOPPING_ATTRIBUTION_OK=1',
    publicDocs: 'https://webservice.rakuten.co.jp/documentation/ichiba-item-search',
    terms: 'https://webservice.rakuten.co.jp/guide/rule',
    attribution: 'Rakuten Web Service branding/trademark rules must be followed.',
    billing: 'Public terms state fees apply only if Rakuten separately designates them; operator opt-in is therefore required.',
  }),
});

function clean(value, max = 3000) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function publicShoppingApiRegistry() {
  return Object.fromEntries(Object.entries(SHOPPING_API_REGISTRY).map(([k, v]) => [k, { ...v }]));
}

export function parseShoppingBudget(text) {
  const value = clean(text, 1600).normalize('NFKC');
  let m = value.match(/(\d+(?:\.\d+)?)\s*万円\s*(?:以下|以内|まで)?/);
  if (m) return Math.max(1, Math.floor(Number(m[1]) * 10000));
  m = value.match(/([\d,]{4,})\s*円\s*(?:以下|以内|まで)?/);
  if (m) return Math.max(1, Number(m[1].replace(/,/g, '')) || 0);
  return 0;
}

export function shoppingKeyword(text) {
  let value = clean(text, 1600).normalize('NFKC')
    .replace(/[\d,.]+\s*万円\s*(?:以下|以内|まで)?/g, ' ')
    .replace(/[\d,]{4,}\s*円\s*(?:以下|以内|まで)?/g, ' ')
    .replace(/(?:候補から|候補を|候補|比較して|比較し|比較|選んで|選ぶ|おすすめ|何がいい|どれがいい|探して|検索して|調べて|販売|型番|価格|値段)/g, ' ')
    .replace(/ノート\s*PC/gi, 'ノートパソコン')
    .replace(/中古\s*PC/gi, '中古 パソコン')
    .replace(/\s+/g, ' ').trim();
  const words = value.split(/\s+/).filter(Boolean);
  // The provider has dedicated condition/price filters; keep the semantic core
  // short so Japanese commerce search does not over-constrain exact listings.
  value = words.filter((w) => !/^(?:以下|以内|用途|用|かつ|なおかつ|ただし)$/.test(w)).slice(0, 7).join(' ');
  return clean(value, 160) || 'ノートパソコン';
}

function itemResult(provider, item, query) {
  const title = clean(item.title, 300);
  const url = clean(item.url, 900);
  if (!title || !/^https?:\/\//i.test(url)) return null;
  const price = Number(item.price);
  const seller = clean(item.seller, 160);
  const bits = [
    Number.isFinite(price) && price > 0 ? `価格 ${Math.round(price).toLocaleString('ja-JP')}円` : '',
    seller ? `販売 ${seller}` : '',
    clean(item.condition, 80),
  ].filter(Boolean);
  return {
    title,
    url,
    snippet: bits.join(' / '),
    excerpt: bits.join(' / '),
    engine: `api:${provider}`,
    probeEngine: `api:${provider}`,
    probeQuery: clean(query, 220),
    sourceRole: 'marketplace',
    structuredShoppingApi: true,
    queryGateScore: 20,
  };
}

async function yahooSearch(question, env, deadline) {
  const started = Date.now();
  if (env?.YAHOO_SHOPPING_ENABLE !== '1') return { provider: 'yahoo_jp_shopping', ok: false, results: [], error: 'operator_opt_in_required', elapsedMs: 0 };
  if (env?.YAHOO_SHOPPING_ATTRIBUTION_OK !== '1') return { provider: 'yahoo_jp_shopping', ok: false, results: [], error: 'attribution_ack_required', elapsedMs: 0 };
  const appid = clean(env?.YAHOO_JP_CLIENT_ID, 500);
  if (!appid) return { provider: 'yahoo_jp_shopping', ok: false, results: [], error: 'missing_YAHOO_JP_CLIENT_ID', elapsedMs: 0 };
  const remaining = deadline - started;
  if (remaining < 500) return { provider: 'yahoo_jp_shopping', ok: false, results: [], error: 'budget_exhausted', elapsedMs: 0 };
  const url = new URL(SHOPPING_API_REGISTRY.yahoo_jp_shopping.endpoint);
  url.searchParams.set('appid', appid);
  url.searchParams.set('query', shoppingKeyword(question));
  url.searchParams.set('results', '10');
  url.searchParams.set('sort', '+price');
  url.searchParams.set('in_stock', 'true');
  if (/中古/.test(question)) url.searchParams.set('condition', 'used');
  const budget = parseShoppingBudget(question);
  if (budget) url.searchParams.set('price_to', String(budget));
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 TalkSys/45 (+https://talksys.syouziroupc.workers.dev)' },
      signal: AbortSignal.timeout(Math.max(400, Math.min(2200, remaining - 100))),
    });
    if (!response.ok) return { provider: 'yahoo_jp_shopping', ok: false, results: [], error: `http_${response.status}`, elapsedMs: Date.now() - started };
    const data = await response.json();
    const rows = Array.isArray(data?.hits) ? data.hits : [];
    const results = rows.map((x) => itemResult('yahoo_jp_shopping', {
      title: x?.name,
      url: x?.url,
      price: x?.price,
      seller: x?.seller?.name,
      condition: /中古/.test(question) ? '中古' : '',
    }, question)).filter(Boolean);
    return { provider: 'yahoo_jp_shopping', ok: results.length > 0, results, error: results.length ? '' : 'empty_results', elapsedMs: Date.now() - started };
  } catch (error) {
    return { provider: 'yahoo_jp_shopping', ok: false, results: [], error: clean(error?.name || error?.message || error, 120) || 'fetch_failed', elapsedMs: Date.now() - started };
  }
}

async function rakutenSearch(question, env, deadline) {
  const started = Date.now();
  if (env?.RAKUTEN_SHOPPING_ENABLE !== '1') return { provider: 'rakuten_ichiba', ok: false, results: [], error: 'operator_opt_in_required', elapsedMs: 0 };
  if (env?.RAKUTEN_SHOPPING_ATTRIBUTION_OK !== '1') return { provider: 'rakuten_ichiba', ok: false, results: [], error: 'attribution_ack_required', elapsedMs: 0 };
  const applicationId = clean(env?.RAKUTEN_APPLICATION_ID, 500);
  const accessKey = clean(env?.RAKUTEN_ACCESS_KEY, 1000);
  if (!applicationId || !accessKey) return { provider: 'rakuten_ichiba', ok: false, results: [], error: 'missing_RAKUTEN_credentials', elapsedMs: 0 };
  const remaining = deadline - started;
  if (remaining < 500) return { provider: 'rakuten_ichiba', ok: false, results: [], error: 'budget_exhausted', elapsedMs: 0 };
  const url = new URL(SHOPPING_API_REGISTRY.rakuten_ichiba.endpoint);
  url.searchParams.set('applicationId', applicationId);
  url.searchParams.set('keyword', shoppingKeyword(question));
  url.searchParams.set('format', 'json');
  url.searchParams.set('formatVersion', '2');
  url.searchParams.set('hits', '10');
  url.searchParams.set('availability', '1');
  url.searchParams.set('sort', '+itemPrice');
  const budget = parseShoppingBudget(question);
  if (budget) url.searchParams.set('maxPrice', String(budget));
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        accessKey,
        'user-agent': 'Mozilla/5.0 TalkSys/45 (+https://talksys.syouziroupc.workers.dev)',
      },
      signal: AbortSignal.timeout(Math.max(400, Math.min(2200, remaining - 100))),
    });
    if (!response.ok) return { provider: 'rakuten_ichiba', ok: false, results: [], error: `http_${response.status}`, elapsedMs: Date.now() - started };
    const data = await response.json();
    const raw = Array.isArray(data?.Items) ? data.Items : Array.isArray(data?.items) ? data.items : [];
    const rows = raw.map((x) => x?.Item || x?.item || x);
    const results = rows.map((x) => itemResult('rakuten_ichiba', {
      title: x?.itemName || x?.name,
      url: x?.itemUrl || x?.url,
      price: x?.itemPrice || x?.price,
      seller: x?.shopName || x?.shop?.name,
      condition: /中古/.test(question) ? '「中古」をキーワードに含む結果' : '',
    }, question)).filter(Boolean);
    return { provider: 'rakuten_ichiba', ok: results.length > 0, results, error: results.length ? '' : 'empty_results', elapsedMs: Date.now() - started };
  } catch (error) {
    return { provider: 'rakuten_ichiba', ok: false, results: [], error: clean(error?.name || error?.message || error, 120) || 'fetch_failed', elapsedMs: Date.now() - started };
  }
}

export async function searchFormalShoppingApis(question, env = {}, deadline = Date.now() + 2500) {
  const settled = await Promise.all([
    yahooSearch(question, env, deadline),
    rakutenSearch(question, env, deadline),
  ]);
  return {
    revision: SHOPPING_API_REVISION,
    results: settled.flatMap((x) => x.results || []),
    diagnostics: settled.map((x) => ({
      engine: `api:${x.provider}`,
      provider: x.provider,
      ok: x.ok === true,
      count: Array.isArray(x.results) ? x.results.length : 0,
      error: x.error || '',
      elapsedMs: Number(x.elapsedMs) || 0,
    })),
    configuredCount: settled.filter((x) => !['operator_opt_in_required','attribution_ack_required'].includes(x.error)).length,
    successfulCount: settled.filter((x) => x.ok).length,
  };
}

export const __test = { clean, itemResult };

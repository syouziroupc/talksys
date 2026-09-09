import { parseBingHtml, parseDuckHtml, parseGoogleHtml, parseRss } from './web-search.js';
import { searchBingRss } from './search-fallbacks.js';

export const SEARCH_PROBE_ENGINES = ['bing-rss', 'google', 'duckduckgo', 'bing-html', 'google-news'];

const SEARCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36 TalkSys/44';

function clean(value, max = 360) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

async function fetchText(url, timeoutMs, accept = 'text/html,application/xhtml+xml') {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      headers: { accept, 'accept-language': 'ja,en;q=0.7', 'user-agent': SEARCH_UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { ok: false, status: response.status, text: '', elapsedMs: Date.now() - startedAt, error: `http_${response.status}` };
    }
    const type = response.headers.get('content-type') || '';
    if (!/(?:text|html|xml|json|rss)/i.test(type)) {
      return { ok: false, status: response.status, text: '', elapsedMs: Date.now() - startedAt, error: 'unsupported_content_type' };
    }
    return { ok: true, status: response.status, text: (await response.text()).slice(0, 500000), elapsedMs: Date.now() - startedAt, error: '' };
  } catch (error) {
    return { ok: false, status: 0, text: '', elapsedMs: Date.now() - startedAt, error: clean(error?.name || error?.message || error, 120) || 'fetch_failed' };
  }
}

function normalizeResults(results, engine, query) {
  return (Array.isArray(results) ? results : []).map((item) => ({
    ...item,
    engine: item?.engine || engine,
    probeEngine: engine,
    probeQuery: query,
  }));
}

export async function searchProbe(engine, query, options = {}) {
  const value = clean(query);
  const timeoutMs = Math.max(1400, Math.min(6500, Number(options.timeoutMs) || 3600));
  const limit = Math.max(1, Math.min(12, Number(options.limit) || 10));
  const startedAt = Date.now();
  if (!value) return { engine, query: value, ok: false, results: [], error: 'empty_query', elapsedMs: 0 };

  try {
    if (engine === 'bing-rss') {
      const results = await searchBingRss(value, { limit, timeoutMs }).catch(() => []);
      return {
        engine,
        query: value,
        ok: results.length > 0,
        results: normalizeResults(results, engine, value),
        error: results.length ? '' : 'empty_results',
        elapsedMs: Date.now() - startedAt,
      };
    }

    let fetched;
    let parsed = [];
    if (engine === 'google') {
      fetched = await fetchText(`https://www.google.com/search?hl=ja&gl=jp&num=10&filter=0&q=${encodeURIComponent(value)}`, timeoutMs);
      parsed = fetched.text ? parseGoogleHtml(fetched.text, limit) : [];
    } else if (engine === 'duckduckgo') {
      fetched = await fetchText(`https://html.duckduckgo.com/html/?kl=jp-jp&q=${encodeURIComponent(value)}`, timeoutMs);
      parsed = fetched.text ? parseDuckHtml(fetched.text, limit) : [];
    } else if (engine === 'bing-html') {
      fetched = await fetchText(`https://www.bing.com/search?setlang=ja-JP&cc=jp&mkt=ja-JP&q=${encodeURIComponent(value)}`, timeoutMs);
      parsed = fetched.text ? parseBingHtml(fetched.text, limit, 'bing-html') : [];
    } else if (engine === 'google-news') {
      fetched = await fetchText(`https://news.google.com/rss/search?hl=ja&gl=JP&ceid=JP:ja&q=${encodeURIComponent(value)}`, timeoutMs, 'application/rss+xml,application/xml,text/xml');
      parsed = fetched.text ? parseRss(fetched.text, 'google-news', limit) : [];
    } else {
      return { engine, query: value, ok: false, results: [], error: 'unknown_engine', elapsedMs: Date.now() - startedAt };
    }

    const results = normalizeResults(parsed, engine, value);
    return {
      engine,
      query: value,
      ok: results.length > 0,
      results,
      error: results.length ? '' : (fetched?.error || 'empty_results'),
      status: fetched?.status || 0,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      engine,
      query: value,
      ok: false,
      results: [],
      error: clean(error?.name || error?.message || error, 120) || 'probe_failed',
      elapsedMs: Date.now() - startedAt,
    };
  }
}

export function fallbackEngine(engine) {
  const order = SEARCH_PROBE_ENGINES;
  const index = Math.max(0, order.indexOf(engine));
  return order[(index + 1) % order.length];
}

export function engineForIndex(index, offset = 0) {
  const order = SEARCH_PROBE_ENGINES;
  return order[(Math.max(0, Number(index) || 0) + Math.max(0, Number(offset) || 0)) % order.length];
}

export const __test = { clean };

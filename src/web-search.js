const FACTUAL_RE = /(検索|調べ|最新|現在|いま|今の|今日|昨日|明日|ニュース|価格|値段|発売|誰|いつ|どこ|何年|何月|本当|事実|仕様|法律|制度|営業時間|天気|株価|為替|相場|ランキング|結果|予定|日程|とは|について教えて|知ってる|どうなって|何があった)/i;
const CASUAL_RE = /^(おはよう|こんにちは|こんばんは|もしもし|ありがとう|ありがと|疲れた|眠い|腹減った|お腹すいた|暇|つかれた|元気|どうも|うん|はい|へえ|そうなんだ|なるほど|笑|わら)/i;
const FEELING_RE = /^(?:今日は|今日も|今は|なんか|ちょっと|かなり|すごく|めっちゃ|もう)?(?:ちょっと|かなり|すごく|めっちゃ)?(?:疲れた|つかれた|眠い|ねむい|腹減った|お腹すいた|暇だ|暇|しんどい|つらい|嬉しい|うれしい|悲しい|かなしい|楽しい|たのしい|元気だ|元気)[。！!…〜ーなぁなあ]*$/i;
const NEWS_RE = /(ニュース|最新|今日|昨日|今週|何があった|報道|発表)/i;

export function needsWebSearch(text) {
  const value = String(text || '').trim();
  if (!value || CASUAL_RE.test(value) || FEELING_RE.test(value)) return false;
  return FACTUAL_RE.test(value);
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function stripHtml(value) {
  return decodeEntities(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function readTag(block, tag) {
  const match = String(block || '').match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? stripHtml(match[1]) : '';
}

function normalizeQuery(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/(?:検索して|検索|調べて|調べる|教えて|知りたい|知ってる|について|最新の?|現在の?|今の?|今日の?|本当|事実|誰|何|ですか|なの|なのか|って|とは|は|を|が|に|で|の|？|\?|。|、|！|!|\s)/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .slice(0, 120);
}

function queryFeatures(query) {
  const raw = String(query || '').toLowerCase();
  const features = new Set();
  for (const word of raw.match(/[a-z0-9][a-z0-9._+-]{2,}/g) || []) features.add(word);
  const compact = normalizeQuery(raw);
  if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{N}]+$/u.test(compact)) {
    for (let n = 2; n <= Math.min(4, compact.length); n += 1) {
      for (let i = 0; i <= compact.length - n; i += 1) features.add(compact.slice(i, i + n));
    }
  } else if (compact.length >= 3) {
    features.add(compact);
  }
  return [...features].filter((item) => item.length >= 2).slice(0, 80);
}

export function relevanceScore(query, result) {
  const haystack = `${result?.title || ''} ${result?.snippet || ''}`.toLowerCase().replace(/\s+/g, ' ');
  if (!haystack.trim()) return 0;
  const features = queryFeatures(query);
  let score = 0;
  for (const feature of features) {
    if (haystack.includes(feature)) score += feature.length >= 4 ? 3 : feature.length === 3 ? 2 : 1;
  }
  try {
    const host = new URL(result.url).hostname.toLowerCase();
    if (/\.go\.jp$|\.lg\.jp$|wikipedia\.org$/.test(host)) score += 2;
  } catch {}
  return score;
}

function uniqueRanked(query, results, limit) {
  const seen = new Set();
  return results
    .map((item) => ({ ...item, score: relevanceScore(query, item) }))
    .filter((item) => item.score >= 2 && /^https?:\/\//i.test(item.url || ''))
    .sort((a, b) => b.score - a.score)
    .filter((item) => {
      const key = item.url.replace(/[?#].*$/, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit)
    .map(({ score, ...item }) => item);
}

export function parseBingHtml(html, limit = 8) {
  const blocks = String(html || '').match(/<li[^>]+class="[^"]*b_algo[^"]*"[\s\S]*?<\/li>/gi) || [];
  const out = [];
  for (const block of blocks) {
    const anchor = block.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<a[^>]+href="(https?:[^"#]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const url = decodeEntities(anchor[1]);
    const title = stripHtml(anchor[2]);
    const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = p ? stripHtml(p[1]) : '';
    if (!title || !/^https?:\/\//i.test(url)) continue;
    out.push({ title: title.slice(0, 220), url: url.slice(0, 700), snippet: snippet.slice(0, 800), engine: 'bing-html' });
    if (out.length >= limit) break;
  }
  return out;
}

export function parseRss(xml, engine = 'rss', limit = 8) {
  const items = String(xml || '').match(/<item\b[\s\S]*?<\/item>/gi) || [];
  const out = [];
  for (const item of items) {
    const title = readTag(item, 'title');
    const url = readTag(item, 'link');
    const snippet = readTag(item, 'description');
    if (!title || !/^https?:\/\//i.test(url)) continue;
    out.push({ title: title.slice(0, 220), url: url.slice(0, 700), snippet: snippet.slice(0, 800), engine });
    if (out.length >= limit) break;
  }
  return out;
}

async function searchWikipedia(query, timeoutMs) {
  const url = `https://ja.wikipedia.org/w/api.php?action=query&list=search&utf8=1&format=json&srlimit=6&srsearch=${encodeURIComponent(query)}`;
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return [];
    const data = await response.json();
    return (data?.query?.search || []).map((item) => ({
      title: String(item.title || '').slice(0, 220),
      url: `https://ja.wikipedia.org/wiki/${encodeURIComponent(String(item.title || '').replace(/ /g, '_'))}`,
      snippet: stripHtml(item.snippet || '').slice(0, 800),
      engine: 'wikipedia-ja',
    }));
  } catch {
    return [];
  }
}

async function searchBingHtml(query, timeoutMs) {
  const url = `https://www.bing.com/search?setlang=ja-JP&cc=jp&mkt=ja-JP&q=${encodeURIComponent(query)}`;
  try {
    const response = await fetch(url, {
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return [];
    return parseBingHtml(await response.text());
  } catch {
    return [];
  }
}

async function searchGoogleNews(query, timeoutMs) {
  if (!NEWS_RE.test(query)) return [];
  const url = `https://news.google.com/rss/search?hl=ja&gl=JP&ceid=JP:ja&q=${encodeURIComponent(query)}`;
  try {
    const response = await fetch(url, { headers: { accept: 'application/rss+xml,application/xml' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return [];
    return parseRss(await response.text(), 'google-news');
  } catch {
    return [];
  }
}

export async function webSearch(query, options = {}) {
  const q = String(query || '').trim().slice(0, 300);
  if (!q) return [];
  const limit = Math.max(1, Math.min(8, Number(options.limit) || 5));
  const timeoutMs = Math.max(700, Math.min(3500, Number(options.timeoutMs) || 1800));
  const perSourceTimeout = Math.max(650, Math.min(timeoutMs, 1800));
  const batches = await Promise.all([
    searchWikipedia(q, perSourceTimeout),
    searchBingHtml(q, perSourceTimeout),
    searchGoogleNews(q, perSourceTimeout),
  ]);
  return uniqueRanked(q, batches.flat(), limit);
}

export function formatSearchContext(results) {
  if (!Array.isArray(results) || !results.length) return '';
  return results.map((item, index) => {
    let host = '';
    try { host = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
    return `[${index + 1}] ${item.title}\nSource: ${host || item.url}${item.engine ? ` (${item.engine})` : ''}\nURL: ${item.url}\nSnippet: ${item.snippet || '(snippetなし)'}`;
  }).join('\n\n');
}

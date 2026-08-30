const FACTUAL_RE = /(検索|調べ|最新|現在|いま|今の|今日|昨日|明日|ニュース|価格|値段|発売|誰|いつ|どこ|何年|何月|本当|事実|仕様|法律|制度|営業時間|天気|株価|為替|相場|ランキング|結果|予定|日程|とは|について教えて|知ってる|どうなって|何があった|違い|比較|おすすめ|評判|性能|スペック|原因|理由|歴史|仕組み|意味|定義|特徴|メリット|デメリット)/i;
const KNOWLEDGE_QUESTION_RE = /(って何|ってなに|とは何|どういう|どんなもの|なぜ|なんで|どうして|どれくらい|どのくらい|どっち|どちら|どれが|何が|何を|何の|誰が|いつ|どこ|あるの|いるの|できるの|できるか|正しい|本当|違うの|違い|比べ|比較|おすすめ|教えて|説明して|知りたい)/i;
const CASUAL_RE = /^(おはよう|こんにちは|こんばんは|もしもし|ありがとう|ありがと|疲れた|眠い|腹減った|お腹すいた|暇|つかれた|元気|どうも|うん|はい|へえ|そうなんだ|なるほど|笑|わら)/i;
const FEELING_RE = /^(?:今日は|今日も|今は|なんか|ちょっと|かなり|すごく|めっちゃ|もう)?(?:ちょっと|かなり|すごく|めっちゃ)?(?:疲れた|つかれた|眠い|ねむい|腹減った|お腹すいた|暇だ|暇|しんどい|つらい|嬉しい|うれしい|悲しい|かなしい|楽しい|たのしい|元気だ|元気)[。！!…〜ーなぁなあ]*$/i;
const PERSONAL_ADVICE_RE = /(?:俺|僕|私|自分|仕事|学校|大学|家族|友達|恋人|今日|最近).*(?:疲れ|つかれ|眠|しんど|つら|悩|困|忙|嬉|悲|どうしたら|どうすれば|どう思う)/i;
const CONVERSATION_MEMORY_RE = /(さっき|先ほど|前に|前の話|この会話|今の話|今言った|前に言った|話した|言った|覚えて|覚えてる|覚えている|合言葉|私が|僕が|俺が)/i;
const EXTERNAL_ENTITY_RE = /(?:Windows|Android|iPhone|Cloudflare|OpenAI|Google|Microsoft|Amazon|Meta|NVIDIA|AMD|Intel|CPU|GPU|Wi-?Fi|Linux|GitHub|日本|アメリカ|中国|政府|首相|大統領|会社|企業|大学|製品|モデル|法律|制度)/i;
const CURRENT_RE = /(最新|現在|いま|今の|今日|昨日|明日|ニュース|価格|発売|誰|首相|大統領|法律|制度|予定|日程|営業時間|株価|為替)/i;

export function needsWebSearch(text) {
  const value = String(text || '').trim();
  if (!value || CASUAL_RE.test(value) || FEELING_RE.test(value)) return false;
  if (CONVERSATION_MEMORY_RE.test(value) && !/(検索|調べ|最新|現在|ニュース|価格|仕様|法律|制度)/i.test(value)) return false;
  if (PERSONAL_ADVICE_RE.test(value) && !EXTERNAL_ENTITY_RE.test(value)) return false;
  if (FACTUAL_RE.test(value) || KNOWLEDGE_QUESTION_RE.test(value)) return true;
  if (EXTERNAL_ENTITY_RE.test(value) && value.length >= 4) return true;
  return false;
}

export function simplifySearchQuery(value) {
  const original = String(value || '').trim();
  const simplified = original
    .replace(/(?:検索して|検索|調べて|調べる|教えてください|教えて|説明して|知りたい|知ってる|について|本当|事実|ですか|でしょうか|なの|なのか|って|とは)/gi, ' ')
    .replace(/(?:どういうもの|どんなもの|どういう意味|どういう|どんな|なぜ|なんで|どうして|どれくらい|どのくらい|どっち|どちら|どれが|何が|何を|何の|誰が|誰|いつ|どこ|何)/gi, ' ')
    .replace(/(?:を教えて|を説明して|について説明|について知りたい|って教えて)/gi, ' ')
    .replace(/[？?。！!、：:「」『』]/g, ' ')
    .replace(/(^|\s)[のはがをにでとへ](?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return simplified.length >= 2 ? simplified : original;
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function stripHtml(value) {
  return decodeEntities(String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function readTag(block, tag) {
  const match = String(block || '').match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? stripHtml(match[1]) : '';
}

function normalizeQuery(value) {
  return simplifySearchQuery(value).toLowerCase().replace(/\s/g, '').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 140);
}

function queryFeatures(query) {
  const raw = String(query || '').toLowerCase();
  const features = new Set();
  for (const word of simplifySearchQuery(raw).match(/[a-z0-9][a-z0-9._+-]{2,}/g) || []) features.add(word);
  const compact = normalizeQuery(raw);
  if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{N}]+$/u.test(compact)) {
    for (let n = 2; n <= Math.min(5, compact.length); n += 1) {
      for (let i = 0; i <= compact.length - n; i += 1) features.add(compact.slice(i, i + n));
    }
  } else if (compact.length >= 3) features.add(compact);
  return [...features].filter((item) => item.length >= 2).slice(0, 100);
}

function authorityBonus(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (/\.go\.jp$|\.lg\.jp$/.test(host)) return 8;
    if (/\.ac\.jp$|\.edu$|\.gov$/.test(host)) return 5;
    if (/wikipedia\.org$/.test(host)) return 2;
    if (/cloudflare\.com$|openai\.com$|google\.com$|microsoft\.com$|apple\.com$/.test(host)) return 4;
  } catch {}
  return 0;
}

export function relevanceScore(query, result) {
  const haystack = `${result?.title || ''} ${result?.snippet || ''} ${result?.excerpt || ''}`.toLowerCase().replace(/\s+/g, ' ');
  if (!haystack.trim()) return 0;
  let score = authorityBonus(result?.url || '');
  for (const feature of queryFeatures(query)) {
    if (haystack.includes(feature)) score += feature.length >= 5 ? 4 : feature.length >= 3 ? 2 : 1;
  }
  if (result?.excerpt && result.excerpt.length >= 300) score += 2;
  return score;
}

function uniqueRanked(query, results, limit, threshold = 2) {
  const seen = new Set();
  return results
    .map((item) => ({ ...item, score: relevanceScore(query, item) }))
    .filter((item) => item.score >= threshold && /^https?:\/\//i.test(item.url || ''))
    .sort((a, b) => b.score - a.score)
    .filter((item) => {
      let key = item.url.replace(/[?#].*$/, '');
      try {
        const u = new URL(item.url);
        key = `${u.hostname}${u.pathname}`.replace(/\/$/, '');
      } catch {}
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit)
    .map(({ score, ...item }) => item);
}

export function parseBingHtml(html, limit = 8, engine = 'bing-html') {
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
    out.push({ title: title.slice(0, 220), url: url.slice(0, 800), snippet: snippet.slice(0, 1000), engine });
    if (out.length >= limit) break;
  }
  return out;
}

function decodeGoogleUrl(value) {
  const raw = decodeEntities(value || '');
  if (/^\/url\?q=/i.test(raw)) {
    try { return decodeURIComponent(raw.match(/^\/url\?q=([^&]+)/i)?.[1] || ''); } catch { return ''; }
  }
  return raw;
}

export function parseGoogleHtml(html, limit = 10) {
  const source = String(html || '');
  const out = [];
  const patterns = [
    /<a[^>]+href="([^"]+)"[^>]*>\s*<h3[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<\/a>/gi,
    /<a[^>]+href="([^"]+)"[^>]*>[\s\S]{0,300}?<h3[^>]*>([\s\S]*?)<\/h3>/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) && out.length < limit) {
      const url = decodeGoogleUrl(match[1]);
      const title = stripHtml(match[2]);
      if (!title || !/^https?:\/\//i.test(url) || /google\.(?:com|co\.jp)\//i.test(url)) continue;
      const tail = source.slice(match.index, Math.min(source.length, match.index + 1800));
      const snippetMatch = tail.match(/<(?:div|span)[^>]*>([\s\S]{30,700}?)<\/(?:div|span)>/i);
      const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : '';
      out.push({ title: title.slice(0, 220), url: url.slice(0, 800), snippet: snippet.slice(0, 1000), engine: 'google-html' });
    }
    if (out.length) break;
  }
  return out;
}

function decodeDuckUrl(raw) {
  const value = decodeEntities(raw || '');
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value, 'https://duckduckgo.com');
    const redirected = url.searchParams.get('uddg');
    return redirected ? decodeURIComponent(redirected) : url.href;
  } catch { return value; }
}

export function parseDuckHtml(html, limit = 10) {
  const blocks = String(html || '').match(/<div[^>]+class="[^"]*result[^"]*"[\s\S]*?(?=<div[^>]+class="[^"]*result|$)/gi) || [];
  const out = [];
  for (const block of blocks) {
    const anchor = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<a[^>]+href="([^"]+)"[^>]+class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const url = decodeDuckUrl(anchor[1]);
    const title = stripHtml(anchor[2]);
    const snippetMatch = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)/i);
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : '';
    if (!title || !/^https?:\/\//i.test(url)) continue;
    out.push({ title: title.slice(0, 220), url: url.slice(0, 800), snippet: snippet.slice(0, 1000), engine: 'duckduckgo-html' });
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
    out.push({ title: title.slice(0, 220), url: url.slice(0, 800), snippet: snippet.slice(0, 1000), engine });
    if (out.length >= limit) break;
  }
  return out;
}

const SEARCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36 TalkSys/2.0';

async function fetchText(url, timeoutMs, accept = 'text/html,application/xhtml+xml') {
  try {
    const response = await fetch(url, { headers: { accept, 'accept-language': 'ja,en;q=0.7', 'user-agent': SEARCH_UA }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return '';
    const type = response.headers.get('content-type') || '';
    if (!/(?:text|html|xml|json)/i.test(type)) return '';
    return (await response.text()).slice(0, 500000);
  } catch { return ''; }
}

async function searchWikipedia(query, timeoutMs) {
  const url = `https://ja.wikipedia.org/w/api.php?action=query&list=search&utf8=1&format=json&srlimit=10&srsearch=${encodeURIComponent(query)}`;
  try {
    const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': SEARCH_UA }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return [];
    const data = await response.json();
    return (data?.query?.search || []).map((item) => ({
      title: String(item.title || '').slice(0, 220),
      url: `https://ja.wikipedia.org/wiki/${encodeURIComponent(String(item.title || '').replace(/ /g, '_'))}`,
      snippet: stripHtml(item.snippet || '').slice(0, 1000),
      engine: 'wikipedia-ja',
    }));
  } catch { return []; }
}

async function searchGoogleHtml(query, timeoutMs) {
  const html = await fetchText(`https://www.google.com/search?hl=ja&gl=jp&num=10&filter=0&q=${encodeURIComponent(query)}`, timeoutMs);
  return html ? parseGoogleHtml(html, 10) : [];
}

async function searchDuckHtml(query, timeoutMs) {
  const html = await fetchText(`https://html.duckduckgo.com/html/?kl=jp-jp&q=${encodeURIComponent(query)}`, timeoutMs);
  return html ? parseDuckHtml(html, 10) : [];
}

async function searchBingHtml(query, timeoutMs, engine = 'bing-html') {
  const html = await fetchText(`https://www.bing.com/search?setlang=ja-JP&cc=jp&mkt=ja-JP&q=${encodeURIComponent(query)}`, timeoutMs);
  return html ? parseBingHtml(html, 10, engine) : [];
}

async function searchGoogleNews(query, timeoutMs) {
  const xml = await fetchText(`https://news.google.com/rss/search?hl=ja&gl=JP&ceid=JP:ja&q=${encodeURIComponent(query)}`, timeoutMs, 'application/rss+xml,application/xml');
  return xml ? parseRss(xml, 'google-news', 10) : [];
}

function extractPageExcerpt(html) {
  const source = String(html || '');
  const meta = source.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/i)
    || source.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description)["']/i);
  const paragraphs = [];
  for (const match of source.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = stripHtml(match[1]);
    if (text.length < 35) continue;
    paragraphs.push(text);
    if (paragraphs.join(' ').length >= 2600) break;
  }
  const combined = [meta ? decodeEntities(meta[1]) : '', ...paragraphs].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return combined.slice(0, 3200);
}

async function enrichResult(item, timeoutMs) {
  if (!/^https?:\/\//i.test(item?.url || '')) return item;
  const html = await fetchText(item.url, timeoutMs);
  if (!html) return item;
  const excerpt = extractPageExcerpt(html);
  return excerpt ? { ...item, excerpt } : item;
}

function queryVariants(original) {
  const q = simplifySearchQuery(original);
  const values = [q];
  if (CURRENT_RE.test(original)) values.push(`${q} 2026`);
  if (/(日本|政府|首相|法律|制度|省|庁|自治体|市|区|県)/i.test(original)) values.push(`${q} site:go.jp`);
  else values.push(`${q} 公式`);
  return [...new Set(values.map((item) => item.replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 3);
}

export async function webSearch(query, options = {}) {
  const original = String(query || '').trim().slice(0, 350);
  if (!original) return [];
  const limit = Math.max(1, Math.min(12, Number(options.limit) || 6));
  const timeoutMs = Math.max(1000, Math.min(5000, Number(options.timeoutMs) || 3200));
  const perSourceTimeout = Math.max(900, Math.min(timeoutMs, 2300));
  const variants = queryVariants(original);
  const primary = variants[0];
  const official = variants[1] || `${primary} 公式`;
  const batches = await Promise.all([
    searchGoogleHtml(primary, perSourceTimeout),
    searchDuckHtml(primary, perSourceTimeout),
    searchBingHtml(primary, perSourceTimeout, 'bing-html'),
    searchWikipedia(primary, perSourceTimeout),
    searchGoogleNews(primary, perSourceTimeout),
    searchGoogleHtml(official, perSourceTimeout),
  ]);

  let ranked = uniqueRanked(original, batches.flat(), Math.max(limit * 2, 14), 2);
  if (options.enrichPages !== false && ranked.length) {
    const enriched = await Promise.all(ranked.slice(0, 8).map((item) => enrichResult(item, Math.min(2200, timeoutMs))));
    const byUrl = new Map(enriched.map((item) => [item.url, item]));
    ranked = ranked.map((item) => byUrl.get(item.url) || item);
  }
  return uniqueRanked(original, ranked, limit, 3);
}

export function formatSearchContext(results) {
  if (!Array.isArray(results) || !results.length) return '';
  return results.map((item, index) => {
    let host = '';
    try { host = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
    const evidence = String(item.excerpt || item.snippet || '').trim();
    return `[${index + 1}] ${item.title}\nSource: ${host || item.url}${item.engine ? ` (${item.engine})` : ''}\nURL: ${item.url}\nEvidence: ${evidence ? evidence.slice(0, 2600) : '(本文取得なし)'}`;
  }).join('\n\n');
}

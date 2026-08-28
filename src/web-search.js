const FACTUAL_RE = /(検索|調べ|最新|現在|いま|今の|今日|昨日|明日|ニュース|価格|値段|発売|誰|いつ|どこ|何年|何月|本当|事実|仕様|法律|制度|営業時間|天気|株価|為替|相場|ランキング|結果|予定|日程|とは|について教えて|知ってる|どうなって|何があった)/i;
const CASUAL_RE = /^(おはよう|こんにちは|こんばんは|もしもし|ありがとう|ありがと|疲れた|眠い|腹減った|お腹すいた|暇|つかれた|元気|どうも|うん|はい|へえ|そうなんだ|なるほど|笑|わら)/i;

export function needsWebSearch(text) {
  const value = String(text || '').trim();
  if (!value || CASUAL_RE.test(value)) return false;
  return FACTUAL_RE.test(value);
}

function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function readTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeXml(match[1]) : '';
}

export function parseBingRss(xml, limit = 5) {
  const items = String(xml || '').match(/<item\b[\s\S]*?<\/item>/gi) || [];
  const out = [];
  for (const item of items) {
    const title = readTag(item, 'title');
    const url = readTag(item, 'link');
    const snippet = readTag(item, 'description');
    if (!title || !/^https?:\/\//i.test(url)) continue;
    out.push({ title: title.slice(0, 220), url: url.slice(0, 600), snippet: snippet.slice(0, 700) });
    if (out.length >= limit) break;
  }
  return out;
}

export async function webSearch(query, options = {}) {
  const q = String(query || '').trim().slice(0, 300);
  if (!q) return [];
  const timeoutMs = Math.max(800, Math.min(5000, Number(options.timeoutMs) || 2400));
  const url = `https://www.bing.com/search?format=rss&setlang=ja-JP&cc=jp&q=${encodeURIComponent(q)}`;
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.1',
        'user-agent': 'Mozilla/5.0 TalkSys/1.0',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return [];
    const xml = await response.text();
    return parseBingRss(xml, options.limit || 5);
  } catch {
    return [];
  }
}

export function formatSearchContext(results) {
  if (!Array.isArray(results) || !results.length) return '';
  return results.map((item, index) => {
    let host = '';
    try { host = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
    return `[${index + 1}] ${item.title}\nSource: ${host || item.url}\nURL: ${item.url}\nSnippet: ${item.snippet || '(snippetなし)'}`;
  }).join('\n\n');
}

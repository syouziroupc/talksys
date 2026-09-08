const SEARCH_UA = 'TalkSys/1.0 (+https://talksys.syouziroupc.workers.dev)';

function decodeEntities(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function stripHtml(value) {
  return decodeEntities(String(value || ''))
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchText(url, timeoutMs, accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8') {
  try {
    const response = await fetch(url, {
      headers: { accept, 'user-agent': SEARCH_UA, 'accept-language': 'ja,en;q=0.7' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return '';
    return await response.text();
  } catch {
    return '';
  }
}

export function parseBingRss(xml, limit = 10) {
  const out = [];
  const items = String(xml || '').match(/<item\b[\s\S]*?<\/item>/gi) || [];
  for (const block of items) {
    const read = (tag) => {
      const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return match ? stripHtml(match[1]) : '';
    };
    const title = read('title');
    const url = decodeEntities(read('link'));
    const snippet = read('description');
    if (!title || !/^https?:\/\//i.test(url)) continue;
    out.push({
      title: title.slice(0, 220),
      url: url.slice(0, 800),
      snippet: snippet.slice(0, 1200),
      engine: 'bing-rss',
    });
    if (out.length >= limit) break;
  }
  return out;
}

export async function searchBingRss(query, options = {}) {
  const value = String(query || '').trim();
  if (!value) return [];
  const timeoutMs = Math.max(1200, Math.min(7000, Number(options.timeoutMs) || 4200));
  const xml = await fetchText(
    `https://www.bing.com/search?format=rss&setlang=ja-JP&cc=jp&q=${encodeURIComponent(value)}`,
    timeoutMs,
    'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.5',
  );
  return parseBingRss(xml, Math.max(1, Math.min(12, Number(options.limit) || 8)));
}

export async function searchOpenStreetMapLocal(query, options = {}) {
  const value = String(query || '').trim();
  if (!value) return [];
  const timeoutMs = Math.max(1200, Math.min(7000, Number(options.timeoutMs) || 4200));
  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=8&countrycodes=jp&q=${encodeURIComponent(value)}`,
      {
        headers: { accept: 'application/json', 'user-agent': SEARCH_UA, 'accept-language': 'ja' },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok) return [];
    const data = await response.json();
    if (!Array.isArray(data)) return [];
    return data
      .filter((item) => item && item.osm_type && item.osm_id && item.display_name)
      .map((item) => ({
        title: String(item.name || String(item.display_name).split(',')[0] || '').slice(0, 220),
        url: `https://www.openstreetmap.org/${item.osm_type === 'node' ? 'node' : item.osm_type === 'way' ? 'way' : 'relation'}/${item.osm_id}`,
        snippet: String(item.display_name || '').slice(0, 1200),
        engine: 'openstreetmap-nominatim',
      }));
  } catch {
    return [];
  }
}

function clean(value) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function recentText(history, limit = 8) {
  if (!Array.isArray(history)) return '';
  return history.slice(-limit).map((item) => clean(item?.content)).filter(Boolean).join(' ');
}

function detectLocation(text) {
  const value = clean(text);
  const compound = value.match(/([一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{1,14}市(?:の|\s*)[一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{1,14}(?:区|町|村|丁目))/);
  if (compound?.[1]) return compound[1].replace(/\s+/g, '').slice(0, 28);
  const wardTown = value.match(/([一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{1,14}(?:区|町|村|丁目))/);
  const city = value.match(/([一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{1,16}市)/);
  if (city?.[1] && wardTown?.[1] && !city[1].includes(wardTown[1])) return `${city[1]} ${wardTown[1]}`.slice(0, 28);
  const matches = [...value.matchAll(/([一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{1,16}(?:都|道|府|県|市|区|町|村))/g)];
  if (!matches.length) return '';
  const granular = [...matches].reverse().find((match) => /(?:区|町|村)$/.test(match[1]));
  const preferred = granular || matches.find((match) => /市$/.test(match[1])) || matches[matches.length - 1];
  return String(preferred?.[1] || '').slice(0, 24);
}

function detectProduct(text) {
  const value = clean(text);
  if (/(?:ノート\s*)?(?:パソコン|PC|ＰＣ)/i.test(value)) return 'パソコン';
  if (/iPhone/i.test(value)) return 'iPhone';
  if (/Android/i.test(value)) return 'Android スマートフォン';
  const match = value.match(/([A-Za-z][A-Za-z0-9._+\-/]{2,24}|[一-龠々ヶァ-ヶ]{2,12})(?:を|が|の|は|なら|買|購入|販売|店|店舗)/i);
  return match?.[1] || '';
}

function detailLookupQueries(current) {
  if (!/(電話番号|連絡先|問い合わせ先|住所|所在地|営業時間|営業日|定休日|公式サイト|公式ページ|URL|アクセス)/i.test(current)) return [];
  const direct = clean(current
    .replace(/(?:を)?(?:教えて(?:よ|ください)?|知りたい|お願いします?)?[。！？!?]*$/i, '')
    .replace(/\s+/g, ' '));
  if (!direct) return [];
  return [direct, `${direct} 公式`];
}

export function buildDeterministicSearchQueries(question, history = []) {
  const current = clean(question);
  const detailQueries = detailLookupQueries(current);
  if (detailQueries.length) return [...new Set(detailQueries)].slice(0, 2);

  const context = recentText(history, 10);
  const all = `${context} ${current}`.trim();
  const currentLocation = detectLocation(current);
  const location = currentLocation || detectLocation(all);
  const product = detectProduct(all) || '商品';
  const explicitPurchase = /(買|購入|どこで|販売店|店舗|店頭|家電量販店|中古|新品|在庫)/i.test(all);
  const contextualWhere = product !== '商品' && Boolean(location) && /(どこ(?:が|で)?(?:いい|良い|おすすめ)?|市内なら|県内なら)/i.test(current);
  const purchase = explicitPurchase || contextualWhere;
  const local = Boolean(location) && /(どこ|店|店舗|買|購入|販売|近く|周辺|市内|県内)/i.test(all);
  const out = [];

  if (purchase && product !== '商品') {
    if (local) {
      out.push(`${location} ${product} 販売店`);
      out.push(`${location} ${product} 家電量販店`);
      out.push(`${location} 中古 ${product} 店舗`);
    } else {
      out.push(`${product} 購入先 比較`);
      out.push(`${product} 通販 販売店`);
      out.push(`${product} 中古 専門店 保証`);
    }
  }

  if (!out.length && current) {
    out.push(current);
    if (location) out.push(`${location} ${current}`);
  }

  return [...new Set(out.map(clean).filter((item) => item.length >= 2))].slice(0, 4);
}

export function hasUsefulSearchEvidence(results, minimum = 3) {
  if (!Array.isArray(results)) return false;
  const useful = results.filter((item) => {
    const title = clean(item?.title);
    const evidence = clean(item?.excerpt || item?.snippet);
    return title.length >= 3 && (evidence.length >= 20 || /^https?:\/\//i.test(item?.url || ''));
  });
  return useful.length >= minimum;
}

export function dedupeSearchResults(results, limit = 32) {
  const seen = new Set();
  const out = [];
  for (const item of results || []) {
    if (!item?.url) continue;
    let key = String(item.url).replace(/[?#].*$/, '').replace(/\/$/, '');
    try {
      const url = new URL(item.url);
      key = `${url.hostname.toLowerCase()}${url.pathname}`.replace(/\/$/, '');
    } catch {}
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

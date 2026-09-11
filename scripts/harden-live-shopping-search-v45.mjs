import fs from 'node:fs';

function replaceOnce(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`missing marker: ${label}`);
  return text.replace(from, to);
}

// --- Search: concrete price evidence + same-turn recovery ---
const searchPath = 'src/search-v45.js';
let search = fs.readFileSync(searchPath, 'utf8');

const helperMarker = `function extractCandidates(results, limit = 4) {`;
const helpers = `function isPriceQuestion(value = '') {
  const q = clean(value, 900);
  return /(?:現在|今|実売|販売|中古|新品|最安|相場).{0,24}(?:価格|値段|いくら|安)|(?:価格|値段|いくら|最安|相場).{0,24}(?:現在|今|実売|販売|中古|新品|安)/i.test(q);
}

function concreteMoneyMentions(value = '') {
  const text = clean(value, 12000);
  return text.match(/(?:[¥￥]\\s*\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?\\s*円|\\d+(?:\\.\\d+)?\\s*万円)/g) || [];
}

function moneyEvidenceWindows(text = '', modelHints = []) {
  const plain = clean(text, 160000);
  if (!plain) return [];
  const out = [];
  const re = /(?:[¥￥]\\s*\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?\\s*円|\\d+(?:\\.\\d+)?\\s*万円)/g;
  for (const match of plain.matchAll(re)) {
    const start = Math.max(0, match.index - 110);
    const end = Math.min(plain.length, match.index + match[0].length + 110);
    const window = clean(plain.slice(start, end), 280);
    if (modelHints.length && !modelHints.some(h => window.toLowerCase().includes(h.toLowerCase()))) continue;
    if (!out.includes(window)) out.push(window);
    if (out.length >= 6) break;
  }
  return out;
}

function hasConcretePriceEvidence(results = []) {
  return (results || []).some((item) => {
    if (item?.structuredApi && item?.sourceRole !== 'seller') return false;
    const sellerish = item?.sourceRole === 'seller' || /(?:amazon|sofmap|be-stock|mercari|rakuten|yahoo|中古|販売|商品|shop|store)/i.test(`${item?.url || ''} ${item?.title || ''}`);
    if (!sellerish) return false;
    const body = `${item?.title || ''} ${item?.snippet || ''} ${item?.excerpt || ''} ${(item?.moneyEvidence || []).join(' ')}`;
    return concreteMoneyMentions(body).length > 0;
  });
}

function priceRecoveryFacets(plan, ranked = []) {
  const models = extractCandidates(ranked, 2).map(x => x.name);
  const subject = models[0] || clean(plan?.resolvedQuestion || '', 180)
    .replace(/(?:現在|今|実売|販売中|最安|相場|価格|値段|いくら|調べて|検索して|探して|確認して|もっと安いのある|その中で)/gi, ' ')
    .replace(/\\s+/g, ' ')
    .trim();
  const queries = unique([
    subject ? `${subject} 中古 販売 価格 円` : '',
    models[1] ? `${models[1]} 中古 販売 価格 円` : (subject ? `${subject} 在庫 価格 円` : ''),
  ], 2);
  return queries.map((primaryQuery, i) => ({ id: `price-recovery-${i + 1}`, stage: 'verification', sourceRole: 'seller', primaryQuery }));
}

${helperMarker}`;
search = replaceOnce(search, helperMarker, helpers, 'price helper insertion');

const enrichStart = search.indexOf('async function enrichTop(');
const enrichEnd = search.indexOf('\nfunction diversify(', enrichStart);
if (enrichStart < 0 || enrichEnd < 0) throw new Error('missing enrichTop block');
const enrichReplacement = `async function enrichTop(results, deadline, limit = 2) {
  const targets = (results || []).slice(0, limit);
  if (!targets.length || deadline - Date.now() < 900) return results || [];
  const enriched = await Promise.all(targets.map(async item => {
    const remaining = deadline - Date.now();
    if (remaining < 400 || !/^https?:\\/\\//.test(item?.url || '')) return item;
    try {
      const r = await fetch(item.url, { redirect:'follow', headers:{ accept:'text/html,application/xhtml+xml', 'user-agent':'TalkSys/45 (+https://talksys.syouziroupc.workers.dev)', 'accept-language':'ja,en;q=0.7' }, signal: AbortSignal.timeout(Math.max(300, Math.min(1500, remaining-100))) });
      if (!r.ok || !/(?:text|html)/i.test(r.headers.get('content-type') || '')) return item;
      const html = (await r.text()).slice(0, 420000);
      const fullText = html.replace(/<script\\b[\\s\\S]*?<\\/script>/gi,' ').replace(/<style\\b[\\s\\S]*?<\\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&amp;/g,' ').replace(/\\s+/g,' ').trim();
      const models = extractCandidates([item], 3).map(x => x.name);
      const moneyEvidence = moneyEvidenceWindows(fullText, models);
      const excerpt = clean(fullText.slice(0, 3600) + (moneyEvidence.length ? ` 価格表記候補: ${moneyEvidence.join(' / ')}` : ''), 6200);
      return excerpt.length > 80 ? { ...item, excerpt, moneyEvidence, engine: `${item.engine || 'web'}+page` } : item;
    } catch { return item; }
  }));
  const map = new Map(enriched.map(x => [x.url, x]));
  return (results || []).map(x => map.get(x.url) || x);
}
`;
search = search.slice(0, enrichStart) + enrichReplacement + search.slice(enrichEnd);

const coverageOld = `  let ranked = diversify(merged, SEARCH_V44_SOURCE_LIMIT);\n  ranked = await enrichTop(ranked, deadline, 2);\n  const hostCount = new Set(ranked.map(x => hostOf(x?.url)).filter(Boolean)).size;\n  const baseEvidenceUseful = ranked.length >= 2 || (ranked.length === 1 && ranked[0].queryGateScore >= 6);`;
const coverageNew = `  let ranked = diversify(merged, SEARCH_V44_SOURCE_LIMIT);\n  ranked = await enrichTop(ranked, deadline, 4);\n\n  const requiresPriceEvidence = isPriceQuestion(plan.resolvedQuestion);\n  let hasPriceEvidence = hasConcretePriceEvidence(ranked);\n  if (SEARCH_V45_GENERAL_WEB_SEARCH_ENABLED && requiresPriceEvidence && !hasPriceEvidence && deadline - Date.now() > 1500) {\n    const recoveryFacets = priceRecoveryFacets(plan, ranked).slice(0, 2);\n    if (recoveryFacets.length) {\n      const t = Date.now();\n      const recovery = await Promise.all(recoveryFacets.map(f => searchOne(f, deadline)));\n      diagnostics.push(...recovery.map(x => x.diag));\n      merged.push(...recovery.flatMap(x => x.results));\n      allQueries.push(...recoveryFacets.map(f => f.primaryQuery));\n      ranked = diversify(merged, SEARCH_V44_SOURCE_LIMIT);\n      ranked = await enrichTop(ranked, deadline, 5);\n      hasPriceEvidence = hasConcretePriceEvidence(ranked);\n      timings.priceRecoveryMs = Date.now() - t;\n      rounds = Math.max(rounds, 2);\n    }\n  }\n\n  const hostCount = new Set(ranked.map(x => hostOf(x?.url)).filter(Boolean)).size;\n  const baseEvidenceUseful = ranked.length >= 2 || (ranked.length === 1 && ranked[0].queryGateScore >= 6);`;
search = replaceOnce(search, coverageOld, coverageNew, 'coverage recovery block');

search = replaceOnce(
  search,
  `  const evidenceUseful = baseEvidenceUseful && (!requiresCurrentFirmwareVersion || hasCurrentFirmwareVersionEvidence);`,
  `  const evidenceUseful = baseEvidenceUseful\n    && (!requiresCurrentFirmwareVersion || hasCurrentFirmwareVersionEvidence)\n    && (!requiresPriceEvidence || hasPriceEvidence);`,
  'evidence useful price gate',
);

search = replaceOnce(
  search,
  `    coverage: { sufficient, reason: sufficient ? 'staged_evidence_sufficient' : (ranked.length ? 'partial_evidence' : 'no_results'), missingFacets: sufficient ? [] : (plan.facets || []).map(f => f.id) },`,
  `    coverage: {\n      sufficient,\n      reason: sufficient ? 'staged_evidence_sufficient' : (ranked.length ? 'partial_evidence' : 'no_results'),\n      missingFacets: sufficient ? [] : unique([...(requiresPriceEvidence && !hasPriceEvidence ? ['current-price'] : []), ...(plan.facets || []).map(f => f.id)], 8),\n    },`,
  'coverage missing facets',
);

search = replaceOnce(
  search,
  `    hasCurrentFirmwareVersionEvidence,\n    timings,`,
  `    hasCurrentFirmwareVersionEvidence,\n    requiresPriceEvidence,\n    hasPriceEvidence,\n    timings,`,
  'price diagnostics',
);

search = replaceOnce(
  search,
  `export const __test = { inferIntent, simplePlan, officialDomainHint, queryTerms, extractCandidates };`,
  `export const __test = { inferIntent, simplePlan, officialDomainHint, queryTerms, extractCandidates, isPriceQuestion, concreteMoneyMentions, hasConcretePriceEvidence, priceRecoveryFacets };`,
  'test exports',
);

fs.writeFileSync(searchPath, search);

// --- Worker: no background promises/user handoff + no unsupported money claims ---
const workerPath = 'src/worker-v44.js';
let worker = fs.readFileSync(workerPath, 'utf8');
worker = replaceOnce(worker, `const REVISION = 'talksys-v45-api-primary-multi-engine-search';`, `const REVISION = 'talksys-v45-api-primary-multi-engine-search-r2';`, 'runtime revision');

const canonicalEnd = `export function canonicalizeInput(value, max = 9000) {\n  return clean(String(value ?? '').normalize('NFKC'), max)\n    .replace(/べっぷ(?=市|の|[、,。\\s]|$)/gi, '別府')\n    .replace(/きょう/gi, '今日')\n    .replace(/あした/gi, '明日')\n    .replace(/あさって/gi, '明後日')\n    .replace(/[‐‑‒–—―]/g, '-');\n}\n`;
const sanitizer = `${canonicalEnd}\nfunction normalizedMoney(value = '') {\n  return String(value || '').normalize('NFKC').replace(/[\\s,]/g, '').replace(/^¥/, '￥');\n}\n\nfunction moneyMentions(value = '') {\n  return clean(value, 12000).match(/(?:[¥￥]\\s*\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?\\s*円|\\d+(?:\\.\\d+)?\\s*万円)/g) || [];\n}\n\nexport function sanitizeUserFacingAnswer(value, question = '', { hasLivePriceEvidence = true } = {}) {\n  let out = clean(value, 9000)\n    .replace(/[^。！？!?]{0,120}(?:少し|しばらく)?お待ち(?:ください|下さい|いただけますか|いただけますでしょうか)[。！？!?]?/g, '')\n    .replace(/[^。！？!?]{0,120}(?:後ほど|改めて)[^。！？!?]{0,100}(?:調べ|確認|検索)[^。！？!?]{0,80}(?:します|いたします)[。！？!?]?/g, '')\n    .replace(/[^。！？!?]{0,120}(?:ご自身で|自分で|各サイトで)[^。！？!?]{0,100}(?:検索|確認|調べ)[^。！？!?]{0,40}(?:ください|下さい)[。！？!?]?/g, '')\n    .replace(/\\s+/g, ' ')\n    .trim();\n\n  const q = canonicalizeInput(question, 1800);\n  const priceSensitive = /(?:価格|値段|相場|いくら|最安|もっと安|安いの|中古|新品)/i.test(q);\n  if (priceSensitive && !hasLivePriceEvidence) {\n    const allowed = new Set(moneyMentions(q).map(normalizedMoney));\n    const sentences = out.match(/[^。！？!?]+[。！？!?]?/g) || [out];\n    out = sentences.filter((sentence) => {\n      const amounts = moneyMentions(sentence).map(normalizedMoney);\n      return !amounts.some(amount => !allowed.has(amount));\n    }).join('').trim();\n  }\n  return out || deterministicStableFallback(q);\n}\n`;
worker = replaceOnce(worker, canonicalEnd, sanitizer, 'answer sanitizer insertion');

const beforeSources = `  const sources = (search.results || []).slice(0, SEARCH_V44_SOURCE_LIMIT).map((x) => ({`;
worker = replaceOnce(worker, beforeSources, `  answer.text = sanitizeUserFacingAnswer(answer?.text, text, { hasLivePriceEvidence: search?.hasPriceEvidence === true });\n\n${beforeSources}`, 'sanitize before return');

worker = replaceOnce(
  worker,
  `      probeFailures: Number(search.probeFailures) || 0,\n      directPrimarySourceCount: Number(search.directPrimarySourceCount) || 0,`,
  `      probeFailures: Number(search.probeFailures) || 0,\n      requiresPriceEvidence: search.requiresPriceEvidence === true,\n      hasPriceEvidence: search.hasPriceEvidence === true,\n      directPrimarySourceCount: Number(search.directPrimarySourceCount) || 0,`,
  'worker price diagnostics',
);
fs.writeFileSync(workerPath, worker);

const testPath = 'tests/v45-live-search-hardening.test.mjs';
fs.writeFileSync(testPath, `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { __test as searchTest } from '../src/search-v45.js';\nimport { sanitizeUserFacingAnswer } from '../src/worker-v44.js';\n\ntest('current price coverage requires concrete seller money evidence', () => {\n  assert.equal(searchTest.isPriceQuestion('Panasonic CF-SV8の現在の中古価格を調べて'), true);\n  assert.equal(searchTest.hasConcretePriceEvidence([{ sourceRole:'seller', title:'CF-SV8 中古', url:'https://shop.example/item', excerpt:'在庫あり' }]), false);\n  assert.equal(searchTest.hasConcretePriceEvidence([{ sourceRole:'seller', title:'CF-SV8 中古 24,800円', url:'https://shop.example/item', excerpt:'在庫あり' }]), true);\n});\n\ntest('price recovery generates same-turn seller queries', () => {\n  const facets = searchTest.priceRecoveryFacets({ resolvedQuestion:'Panasonic CF-SV8の現在の中古価格を調べて' }, [{ title:'Panasonic CF-SV8 中古', snippet:'整備済み', url:'https://shop.example/item' }]);\n  assert.ok(facets.length >= 1);\n  assert.ok(facets.every(x => x.sourceRole === 'seller'));\n  assert.match(facets[0].primaryQuery, /CF-SV8/);\n  assert.match(facets[0].primaryQuery, /価格/);\n});\n\ntest('answer sanitizer removes background promises and user handoff', () => {\n  const out = sanitizeUserFacingAnswer('販売ページは見つかりました。改めて確認しますので、少しお待ちください。各サイトでご自身で価格を確認してください。', 'CF-SV8の現在価格を調べて', { hasLivePriceEvidence:false });\n  assert.doesNotMatch(out, /待ち|後ほど|改めて確認|ご自身で|自分で/);\n});\n\ntest('answer sanitizer blocks unsupported new price claims but preserves user budget', () => {\n  const out = sanitizeUserFacingAnswer('予算3万円以下なら探せます。2万円前後の機種が見つかることがあります。メモリ8GB以上を優先します。', '3万円以下の中古ノートPCを探して', { hasLivePriceEvidence:false });\n  assert.match(out, /3万円/);\n  assert.doesNotMatch(out, /2万円/);\n  assert.match(out, /メモリ8GB/);\n});\n\ntest('answer sanitizer allows concrete price when live evidence exists', () => {\n  const out = sanitizeUserFacingAnswer('確認できた販売価格は24,800円です。', 'CF-SV8の現在価格を調べて', { hasLivePriceEvidence:true });\n  assert.match(out, /24,800円/);\n});\n`);

console.log('Applied live shopping/search hardening.');

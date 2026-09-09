function clean(value, max = 1200) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function unique(values, limit = 20) {
  const out = [];
  const seen = new Set();
  for (const raw of values || []) {
    const value = clean(raw, 320);
    if (value.length < 2) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

const DISCOVERY_HINT_RE = /(候補|機種|型番|モデル|商品|製品|店舗|店|場所|どこ|おすすめ|選ぶ|探す|選定|候補発見|candidate|model|product|store|place)/i;
const VERIFY_HINT_RE = /(仕様|スペック|価格|値段|在庫|保証|返品|対応|適合|条件|性能|バッテリー|状態|弱点|欠点|問題|注意|相場|現在|最新|spec|price|stock|warranty|support|fit|condition|risk)/i;
const GENERIC_DISCOVERY_RE = /(おすすめ|何がいい|どれがいい|選ぶ|探す|候補|安い.*(?:PC|パソコン|スマホ|製品|商品)|(?:PC|パソコン|スマホ|製品|商品).*(?:安い|おすすめ|選び))/i;
const KNOWN_MODEL_RE = /(?:\b[A-Z]{1,6}[- ]?[A-Z0-9]{1,12}(?:[- ][A-Z0-9]{1,12})*\b|\biPhone\s*\d{1,2}(?:\s*(?:Pro|Plus|mini|Max))?\b|\bPixel\s*\d{1,2}[A-Za-z]?\b|\bGalaxy\s*[A-Z]\d{1,3}[A-Za-z]?\b|\bThinkPad\s+[A-Z]\d{1,3}\b|\bCF-[A-Z0-9-]+\b)/i;

export function needsCandidateDiscovery(plan) {
  const q = clean(plan?.resolvedQuestion, 1200);
  if (!['shopping', 'local', 'comparison'].includes(String(plan?.intent || ''))) return false;
  if (KNOWN_MODEL_RE.test(q)) return false;
  return GENERIC_DISCOVERY_RE.test(q) || (plan?.facets || []).some((f) => DISCOVERY_HINT_RE.test(`${f?.id || ''} ${f?.question || ''}`));
}

function facetIsDiscovery(facet) {
  const text = `${facet?.id || ''} ${facet?.question || ''} ${facet?.evidenceNeeded || ''}`;
  return DISCOVERY_HINT_RE.test(text) && !VERIFY_HINT_RE.test(text);
}

export function discoveryQueries(plan, limit = 2) {
  const facets = Array.isArray(plan?.facets) ? plan.facets : [];
  const explicit = facets.filter(facetIsDiscovery).sort((a, b) => (Number(b?.priority) || 0) - (Number(a?.priority) || 0));
  const fallback = facets.filter((f) => DISCOVERY_HINT_RE.test(`${f?.id || ''} ${f?.question || ''}`));
  const selected = explicit.length ? explicit : fallback;
  const queries = selected.map((f) => f?.primaryQuery).filter(Boolean);
  if (queries.length) return unique(queries, limit);
  return unique([clean(plan?.resolvedQuestion, 320)], limit);
}

export function verificationFacets(plan) {
  return (Array.isArray(plan?.facets) ? plan.facets : []).filter((facet) => {
    const text = `${facet?.id || ''} ${facet?.question || ''} ${facet?.evidenceNeeded || ''}`;
    return VERIFY_HINT_RE.test(text) || !facetIsDiscovery(facet);
  });
}

export function buildCandidateVerificationQueries(plan, candidates, limit = 6) {
  const entities = unique((candidates || []).map((x) => typeof x === 'string' ? x : x?.name), 4);
  if (!entities.length) return [];
  const facets = verificationFacets(plan).slice(0, 5);
  const out = [];
  for (const entity of entities) {
    for (const facet of facets) {
      const source = clean(facet?.primaryQuery || facet?.question || facet?.evidenceNeeded, 240);
      if (!source) continue;
      const generic = source
        .replace(/(?:3万円以下|\d+(?:万|千)?円以下|中古ノートPC|中古PC|ノートPC|パソコン|スマホ|製品|商品)/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const query = clean(`${entity} ${generic || facet?.evidenceNeeded || facet?.question}`, 320);
      if (query && !out.some((x) => x.toLowerCase() === query.toLowerCase())) out.push(query);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export function candidateEvidenceText(results, limit = 24) {
  return (results || []).slice(0, limit).map((item, i) => {
    const title = clean(item?.title, 220);
    const snippet = clean(item?.excerpt || item?.snippet, 700);
    return `[${i + 1}] ${title}\n${snippet}`;
  }).join('\n\n');
}

export function normalizeCandidates(raw, evidenceText, limit = 4) {
  const evidence = clean(evidenceText, 20000).toLowerCase();
  const values = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of values) {
    const name = clean(typeof item === 'string' ? item : item?.name, 100);
    if (name.length < 2) continue;
    // Candidate names must literally occur in retrieved evidence. This prevents
    // the planner from turning remembered brands/models into fake discoveries.
    if (!evidence.includes(name.toLowerCase())) continue;
    if (out.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue;
    out.push({
      name,
      evidence: clean(typeof item === 'object' ? item?.evidence : '', 240),
    });
    if (out.length >= limit) break;
  }
  return out;
}

export const __test = { facetIsDiscovery, clean, unique, KNOWN_MODEL_RE };

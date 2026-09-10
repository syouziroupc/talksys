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
const VERIFY_HINT_RE = /(仕様|スペック|価格|値段|在庫|保証|返品|対応|適合|性能|バッテリー|状態|弱点|欠点|問題|注意|相場|現在|最新|spec|price|stock|warranty|support|fit|condition|risk)/i;
const GENERIC_DISCOVERY_RE = /(おすすめ|何がいい|どれがいい|選ぶ|探す|候補|安い.*(?:PC|パソコン|スマホ|製品|商品)|(?:PC|パソコン|スマホ|製品|商品).*(?:安い|おすすめ|選び))/i;
const STORE_INTENT_RE = /(どこで買|店舗|店で|販売店|近く|周辺|近所|持ち帰り|店頭|ショップ|store|shop|nearby)/i;
const KNOWN_MODEL_RE = /(?:\b(?=[A-Z0-9-]*\d)[A-Z]{1,6}[- ]?[A-Z0-9]{1,12}(?:[- ][A-Z0-9]{1,12})*\b|\biPhone\s*\d{1,2}(?:\s*(?:Pro|Plus|mini|Max))?\b|\bPixel\s*\d{1,2}[A-Za-z]?\b|\bGalaxy\s*[A-Z]\d{1,3}[A-Za-z]?\b|\bThinkPad\s+[A-Z]\d{1,3}\b|\bCF-[A-Z0-9-]*\d[A-Z0-9-]*\b)/i;

const ALLOWED_RESEARCH_MODES = new Set(['direct_fact', 'discover_then_verify', 'compare_known_entities', 'local_discovery', 'current_status']);
const ALLOWED_CANDIDATE_TYPES = new Set(['product_model', 'store', 'place', 'company', 'service', 'person', 'document', 'none']);

export function researchModeForPlan(plan) {
  const explicit = clean(plan?.researchMode || plan?.research_mode, 40).toLowerCase();
  if (ALLOWED_RESEARCH_MODES.has(explicit)) return explicit;
  const q = clean(plan?.resolvedQuestion, 1200);
  if (plan?.intent === 'local' || STORE_INTENT_RE.test(q)) return 'local_discovery';
  if (plan?.intent === 'shopping' && !KNOWN_MODEL_RE.test(q)) return 'discover_then_verify';
  if (plan?.intent === 'comparison' && KNOWN_MODEL_RE.test(q)) return 'compare_known_entities';
  if (plan?.intent === 'current' || plan?.intent === 'news') return 'current_status';
  return 'direct_fact';
}

export function candidateTypeForPlan(plan) {
  const explicit = clean(plan?.candidateType || plan?.candidate_type, 40).toLowerCase();
  if (ALLOWED_CANDIDATE_TYPES.has(explicit)) return explicit;
  const q = clean(plan?.resolvedQuestion, 1200);
  if (plan?.intent === 'local' || STORE_INTENT_RE.test(q)) return 'store';
  if (plan?.intent === 'shopping' || plan?.intent === 'comparison') return 'product_model';
  return 'none';
}

export function needsCandidateDiscovery(plan) {
  const q = clean(plan?.resolvedQuestion, 1200);
  const mode = researchModeForPlan(plan);
  if (mode === 'discover_then_verify' || mode === 'local_discovery') return true;
  if (!['shopping', 'local', 'comparison'].includes(String(plan?.intent || ''))) return false;
  if (KNOWN_MODEL_RE.test(q)) return false;
  return GENERIC_DISCOVERY_RE.test(q) || (plan?.facets || []).some((f) => f?.stage === 'discovery' || DISCOVERY_HINT_RE.test(`${f?.id || ''} ${f?.question || ''}`));
}

function facetIsDiscovery(facet) {
  if (facet?.stage === 'discovery') return true;
  if (facet?.stage === 'verification') return false;
  const text = `${facet?.id || ''} ${facet?.question || ''} ${facet?.evidenceNeeded || ''}`;
  return DISCOVERY_HINT_RE.test(text) && !VERIFY_HINT_RE.test(text);
}

function candidateHint(candidateType) {
  if (candidateType === 'product_model') return '型番 機種';
  if (candidateType === 'store') return '店舗 店名';
  if (candidateType === 'place') return '場所 施設名';
  if (candidateType === 'company') return '会社名';
  if (candidateType === 'service') return 'サービス名';
  if (candidateType === 'person') return '人物名';
  if (candidateType === 'document') return '資料 文書名';
  return '';
}

function sourceRoleHint(role) {
  const value = clean(role, 40).toLowerCase();
  if (value === 'official_spec') return 'メーカー 公式 仕様';
  if (value === 'official_support') return '公式 サポート';
  if (value === 'seller') return '販売 価格 在庫';
  if (value === 'marketplace') return '販売 価格';
  if (value === 'map') return '公式 店舗 所在地';
  if (value === 'news') return '報道';
  if (value === 'independent_review') return 'レビュー 検証';
  if (value === 'primary') return '公式 一次情報';
  return '';
}

export function discoveryQueries(plan, limit = 2) {
  const facets = Array.isArray(plan?.facets) ? plan.facets : [];
  const explicit = facets.filter(facetIsDiscovery).sort((a, b) => (Number(b?.priority) || 0) - (Number(a?.priority) || 0));
  const selected = explicit.length ? explicit : facets.filter((f) => DISCOVERY_HINT_RE.test(`${f?.id || ''} ${f?.question || ''}`));
  const type = candidateTypeForPlan(plan);
  const hint = candidateHint(type);
  const queries = selected.map((f) => {
    const base = clean(f?.primaryQuery || '', 280);
    const alreadyTyped = type === 'product_model' ? /(型番|機種|モデル)/i.test(base)
      : type === 'store' ? /(店舗|店名|販売店|ショップ)/i.test(base)
        : false;
    return clean(`${base} ${alreadyTyped ? '' : hint}`, 320);
  }).filter(Boolean);
  if (queries.length) return unique(queries, limit);
  return unique([clean(`${plan?.resolvedQuestion || ''} ${hint}`, 320)], limit);
}

export function verificationFacets(plan) {
  return (Array.isArray(plan?.facets) ? plan.facets : []).filter((facet) => !facetIsDiscovery(facet));
}

function verificationConcept(facet) {
  const evidence = clean(facet?.evidenceNeeded || facet?.question || facet?.primaryQuery, 220);
  return evidence
    .replace(/(?:候補ごとの|候補の|具体的な候補|条件を満たす候補の存在|3万円以下|\d+(?:万|千)?円以下|中古ノートPC|中古PC|ノートPC|パソコン|スマホ|製品|商品)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildCandidateVerificationQueries(plan, candidates, limit = 6) {
  const entities = unique((candidates || []).map((x) => typeof x === 'string' ? x : x?.name), 4);
  if (!entities.length) return [];
  const facets = verificationFacets(plan).slice(0, 5);
  const out = [];
  for (const entity of entities) {
    for (const facet of facets) {
      const concept = verificationConcept(facet);
      const roleHint = sourceRoleHint(facet?.sourceRole);
      const query = clean(`${entity} ${concept} ${roleHint}`, 320);
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

export function normalizeCandidates(raw, evidenceText, limit = 4, candidateType = '') {
  const evidence = clean(evidenceText, 20000).toLowerCase();
  const requiredType = clean(candidateType, 40).toLowerCase();
  const values = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of values) {
    const name = clean(typeof item === 'string' ? item : item?.name, 100);
    const type = clean(typeof item === 'object' ? item?.type : '', 40).toLowerCase();
    if (name.length < 2) continue;
    if (requiredType && requiredType !== 'none' && type !== requiredType) continue;
    if (!evidence.includes(name.toLowerCase())) continue;
    if (out.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue;
    out.push({
      name,
      type: type || requiredType || 'unknown',
      evidence: clean(typeof item === 'object' ? item?.evidence : '', 240),
    });
    if (out.length >= limit) break;
  }
  return out;
}

export const __test = {
  facetIsDiscovery,
  clean,
  unique,
  KNOWN_MODEL_RE,
  researchModeForPlan,
  candidateTypeForPlan,
  sourceRoleHint,
  candidateHint,
};

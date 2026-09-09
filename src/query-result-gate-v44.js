const GENERIC_TERMS = new Set([
  '公式','最新','比較','おすすめ','評判','レビュー','情報','確認','目安','相場','価格','値段','販売','購入','選び方','問題','注意点','現在','2026',
  'official','latest','review','reviews','compare','comparison','price','buy','shopping','info','information',
]);

function clean(value, max = 2000) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalize(value) {
  return clean(value, 4000).toLowerCase().normalize('NFKC');
}

function queryTerms(query) {
  const raw = normalize(query);
  const split = raw
    .replace(/[「」『』【】()[\]{}<>!?？。、,:：;；/\\|]+/g, ' ')
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const term of split) {
    const compact = term.replace(/^(?:の|を|が|は|に|で|と|へ)+|(?:の|を|が|は|に|で|と|へ)+$/g, '');
    if (compact.length < 2 || GENERIC_TERMS.has(compact) || seen.has(compact)) continue;
    seen.add(compact);
    out.push(compact);
  }
  return out.slice(0, 16);
}

function isStrongTerm(term) {
  if (!term) return false;
  if (/[a-z]/i.test(term) && /\d/.test(term)) return true;
  if (/[a-z]/i.test(term) && term.length >= 4) return true;
  if (/\d/.test(term) && term.length >= 3) return true;
  return [...term].length >= 4;
}

export function queryResultEvidence(query, result) {
  const title = normalize(result?.title || '');
  const snippet = normalize(result?.snippet || result?.excerpt || '');
  const haystack = `${title} ${snippet}`;
  const terms = queryTerms(query);
  if (!haystack.trim() || !terms.length) return { relevant: false, matched: [], strongMatched: [], score: 0 };

  const matched = terms.filter((term) => haystack.includes(term));
  const strongMatched = matched.filter(isStrongTerm);
  const titleMatched = matched.filter((term) => title.includes(term));
  const score = strongMatched.length * 4 + titleMatched.length * 2 + matched.length;

  // One strong subject/entity term is enough. Otherwise require two distinct
  // meaningful query concepts; generic modifiers alone never establish relevance.
  const relevant = strongMatched.length >= 1 || matched.length >= 2;
  return { relevant, matched, strongMatched, score };
}

export function isQueryRelevantResult(query, result) {
  return queryResultEvidence(query, result).relevant;
}

export function filterQueryRelevantResults(query, results, limit = 20) {
  return (Array.isArray(results) ? results : [])
    .map((item) => ({ item, gate: queryResultEvidence(query, item) }))
    .filter((x) => x.gate.relevant)
    .sort((a, b) => b.gate.score - a.gate.score)
    .slice(0, Math.max(1, limit))
    .map((x) => ({ ...x.item, queryGateScore: x.gate.score, queryGateMatched: x.gate.matched.slice(0, 8) }));
}

export const __test = { queryTerms, isStrongTerm };

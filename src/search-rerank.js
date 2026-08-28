export const SEARCH_RERANK_MODEL = '@cf/baai/bge-reranker-base';

function extractRankedEntries(result) {
  const entries = result?.response || result?.results || result?.data || [];
  return Array.isArray(entries) ? entries : [];
}

function entryIndex(entry) {
  const value = entry?.index ?? entry?.id ?? entry?.context_index ?? entry?.contextIndex;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : -1;
}

function entryScore(entry) {
  const value = entry?.score ?? entry?.relevance_score ?? entry?.relevanceScore;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function rerankSearchResults(ai, query, results, limit = 3) {
  const input = Array.isArray(results) ? results.filter(Boolean).slice(0, 12) : [];
  const outputLimit = Math.max(1, Math.min(3, Number(limit) || 3));
  if (!ai || typeof ai.run !== 'function' || input.length < 2) return input.slice(0, outputLimit);

  try {
    const contexts = input.map((item) => ({
      text: `${String(item.title || '').slice(0, 220)}\n${String(item.snippet || '').slice(0, 700)}`,
    }));
    const response = await ai.run(SEARCH_RERANK_MODEL, {
      query: String(query || '').slice(0, 500),
      contexts,
      top_k: Math.min(input.length, Math.max(outputLimit, 5)),
    });
    const rankedEntries = extractRankedEntries(response);
    if (!rankedEntries.length) return input.slice(0, outputLimit);

    const used = new Set();
    const ranked = [];
    for (const entry of rankedEntries) {
      const index = entryIndex(entry);
      if (index < 0 || index >= input.length || used.has(index)) continue;
      const score = entryScore(entry);
      if (score !== null && score < 0.08) continue;
      used.add(index);
      ranked.push({ ...input[index], rerankScore: score });
      if (ranked.length >= outputLimit) break;
    }
    if (!ranked.length) return input.slice(0, outputLimit);
    return ranked;
  } catch {
    return input.slice(0, outputLimit);
  }
}

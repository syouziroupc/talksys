from pathlib import Path
import re

path = Path('src/search-v44.js')
text = path.read_text()

probe_import = "import { engineForIndex, fallbackEngine, searchProbe } from './search-probes-v44.js';\n"
extra_imports = """import { filterQueryRelevantResults, isQueryRelevantResult } from './query-result-gate-v44.js';
import {
  buildCandidateVerificationQueries,
  candidateEvidenceText,
  discoveryQueries,
  needsCandidateDiscovery,
  normalizeCandidates,
} from './research-sequence-v44.js';
"""
if "./query-result-gate-v44.js" not in text:
    text = text.replace(probe_import, probe_import + extra_imports)

text = text.replace(
    "export const SEARCH_V44_REVISION = 'deep-search-v44-question-first-evidence-loop';",
    "export const SEARCH_V44_REVISION = 'deep-search-v44-sequential-evidence-search';",
)

old_cross = """    const cross = await webSearch(list[0], {
      limit: 12,
      timeoutMs: options.timeoutMs,
      enrichPages: false,
    }).catch(() => []);
    merged = dedupeSearchResults([...cross, ...merged], 150);
    crossEngineUsed = true;
"""
new_cross = """    const cross = await webSearch(list[0], {
      limit: 12,
      timeoutMs: options.timeoutMs,
      enrichPages: false,
    }).catch(() => []);
    const gatedCross = filterQueryRelevantResults(list[0], cross, 12).map((item) => ({
      ...item,
      probeQuery: item?.probeQuery || list[0],
      probeEngine: item?.probeEngine || 'cross-engine',
    }));
    merged = dedupeSearchResults([...gatedCross, ...merged], 150);
    crossEngineUsed = true;
"""
assert old_cross in text, 'cross-engine block not found'
text = text.replace(old_cross, new_cross)

old_rank = """async function rankExpanded(ai, question, results, signal, limit = SEARCH_V44_SOURCE_LIMIT) {
  const unique = dedupeSearchResults(results, 120)
    .map((item) => ({ item, score: relevanceScore(question, item) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item)
    .slice(0, 72);
"""
new_rank = """async function rankExpanded(ai, question, results, signal, limit = SEARCH_V44_SOURCE_LIMIT) {
  const unique = dedupeSearchResults(results, 120)
    .filter((item) => isQueryRelevantResult(item?.probeQuery || question, item))
    .map((item) => ({ item, score: relevanceScore(question, item) + (Number(item?.queryGateScore) || 0) * 2 }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item)
    .slice(0, 72);
"""
assert old_rank in text, 'rank block not found'
text = text.replace(old_rank, new_rank)

coverage_marker = "async function assessCoverage(ai, plan, results, history, signal) {"
extract_fn = r'''async function extractSupportedCandidates(ai, plan, results, signal) {
  const evidence = candidateEvidenceText(results, 24);
  if (!evidence) return [];
  try {
    const result = await ai.run(PLANNER_MODEL, {
      messages: [
        {
          role: 'system',
          content: '検索結果から、次の検証検索に使う実在候補を抽出します。質問に直接関係する具体的な商品型番・サービス名・店舗名などだけを最大4件選んでください。候補名は必ず提示された検索結果のタイトルまたは本文に文字列として実在するものだけ。一般カテゴリ名、記事タイトル、検索サイト名、ログインページ名、推測した型番は禁止です。JSONだけ: {"candidates":[{"name":"検索結果に実在する正確な候補名","evidence":"どの結果で確認したか短く"}]}',
        },
        {
          role: 'user',
          content: `調査課題: ${plan.resolvedQuestion}\n意図: ${plan.intent}\n必須条件: ${(plan.mustInclude || []).join(' / ') || '(なし)'}\n\n検索結果:\n${evidence}`,
        },
      ],
      stream: false,
      max_completion_tokens: 420,
      temperature: 0.01,
      reasoning_effort: 'low',
    }, signal ? { signal } : undefined);
    const data = parseJsonObject(readModelText(result));
    return normalizeCandidates(data?.candidates, evidence, 4);
  } catch {
    return [];
  }
}

'''
if 'async function extractSupportedCandidates' not in text:
    assert coverage_marker in text, 'coverage marker not found'
    text = text.replace(coverage_marker, extract_fn + coverage_marker)

runner_pattern = r'''export async function runDeepSearchV44\(ai, text, history = \[\], signal, options = \{\}\) \{[\s\S]*?\n\}\n\nexport const __test'''
runner_replacement = r'''export async function runDeepSearchV44(ai, text, history = [], signal, options = {}) {
  const startedAt = Date.now();
  const timings = {};
  const probeDiagnostics = [];
  let retryCount = 0;
  let crossEngineCount = 0;
  const maxBudgetMs = Math.max(12000, Math.min(45000, Number(options.totalBudgetMs) || SEARCH_V44_TOTAL_BUDGET_MS));
  const queryTimeoutMs = Math.max(3500, Math.min(9000, Number(options.queryTimeoutMs) || SEARCH_V44_QUERY_TIMEOUT_MS));

  const planStarted = Date.now();
  const plan = await planDeepSearch(ai, text, history, signal);
  const focus = researchFocus(plan) || plan.resolvedQuestion;
  const sequentialDiscovery = needsCandidateDiscovery(plan);
  timings.plannerMs = Date.now() - planStarted;

  const plannedQueries = uniqueQueries(plan.queries, SEARCH_V44_MAX_QUERIES);
  let first = sequentialDiscovery ? discoveryQueries(plan, 2) : compileInitialQueries(plan, 6);
  if (!first.length) first = plannedQueries.slice(0, sequentialDiscovery ? 2 : 4);
  const allQueries = [...first];

  const round1Started = Date.now();
  const batch1 = await runQueryBatch(first, {
    timeoutMs: queryTimeoutMs,
    multiEngine: true,
    engineOffset: 0,
    retryBudget: 2,
  });
  let merged = batch1.results;
  probeDiagnostics.push(...batch1.diagnostics);
  retryCount += batch1.retries;
  if (batch1.crossEngineUsed) crossEngineCount += 1;
  merged = await enrichTopResults(merged, focus, ai, signal, queryTimeoutMs, 3);
  let ranked = await rankExpanded(ai, focus, merged, signal, SEARCH_V44_SOURCE_LIMIT);
  timings.round1Ms = Date.now() - round1Started;
  let rounds = 1;
  let candidates = [];

  if ((plan.intent === 'local' || LOCAL_RE.test(plan.resolvedQuestion)) && Date.now() - startedAt < maxBudgetMs - 3500) {
    const localQueries = uniqueQueries([
      plan.location ? `${plan.location} ${plan.resolvedQuestion}` : plan.resolvedQuestion,
      plan.location ? `${plan.location} 店舗` : '',
    ], 2);
    const localStarted = Date.now();
    const settled = await Promise.allSettled(localQueries.map((q) => searchOpenStreetMapLocal(q, { timeoutMs: Math.min(5000, queryTimeoutMs) })));
    merged = dedupeSearchResults([
      ...merged,
      ...settled.flatMap((x) => x.status === 'fulfilled' && Array.isArray(x.value) ? x.value : []),
    ], 160);
    ranked = await rankExpanded(ai, focus, merged, signal, SEARCH_V44_SOURCE_LIMIT);
    timings.localMs = Date.now() - localStarted;
  }

  // Candidate-discovery questions are sequential by nature. Discover actual names
  // first, then search those exact entities for the remaining evidence facets.
  if (sequentialDiscovery && ranked.length && Date.now() - startedAt < maxBudgetMs - 7000) {
    const candidateStarted = Date.now();
    candidates = await extractSupportedCandidates(ai, plan, ranked, signal);
    timings.candidateExtractionMs = Date.now() - candidateStarted;
    const verifyQueries = buildCandidateVerificationQueries(plan, candidates, 6)
      .filter((q) => !allQueries.some((used) => used.toLowerCase() === q.toLowerCase()));
    if (verifyQueries.length) {
      const verifyStarted = Date.now();
      const verifyBatch = await runQueryBatch(verifyQueries, {
        timeoutMs: queryTimeoutMs,
        multiEngine: false,
        engineOffset: 2,
        retryBudget: Math.max(0, SEARCH_V44_MAX_ENGINE_RETRIES - retryCount),
      });
      merged = dedupeSearchResults([...merged, ...verifyBatch.results], 170);
      probeDiagnostics.push(...verifyBatch.diagnostics);
      retryCount += verifyBatch.retries;
      if (verifyBatch.crossEngineUsed) crossEngineCount += 1;
      allQueries.push(...verifyQueries);
      ranked = await rankExpanded(ai, focus, merged, signal, SEARCH_V44_SOURCE_LIMIT);
      timings.round2Ms = Date.now() - verifyStarted;
      rounds = 2;
    }
  }

  const coverageStarted = Date.now();
  let coverage = await assessCoverage(ai, { ...plan, queries: allQueries, candidates }, ranked, history, signal);
  timings.coverageMs = Date.now() - coverageStarted;

  // One final adaptive round is reserved strictly for remaining evidence gaps.
  if (!coverage.sufficient && Date.now() - startedAt < maxBudgetMs - 4000) {
    const already = new Set(allQueries.map((q) => q.toLowerCase()));
    const gapLimit = rounds >= 2 ? SEARCH_V44_MAX_RECOVERY_QUERIES : 6;
    let gapQueries = uniqueQueries(
      [...(coverage.queries || []), ...compileFollowupQueries(plan, coverage, allQueries, gapLimit)],
      gapLimit,
    ).filter((q) => !already.has(q.toLowerCase()));

    // For discovery tasks, generic gap queries are inferior to candidate-specific
    // verification. If candidates exist, bind unresolved questions to those names.
    if (sequentialDiscovery && candidates.length) {
      const entityQueries = buildCandidateVerificationQueries(
        { ...plan, facets: (plan.facets || []).filter((f) => (coverage.missingFacets || []).includes(f.id)) },
        candidates,
        gapLimit,
      );
      gapQueries = uniqueQueries([...entityQueries, ...gapQueries], gapLimit).filter((q) => !already.has(q.toLowerCase()));
    }

    if (gapQueries.length) {
      const gapStarted = Date.now();
      const gapBatch = await runQueryBatch(gapQueries, {
        timeoutMs: queryTimeoutMs,
        multiEngine: ranked.length < 5,
        engineOffset: 4,
        retryBudget: Math.max(0, SEARCH_V44_MAX_ENGINE_RETRIES - retryCount),
      });
      merged = dedupeSearchResults([...merged, ...gapBatch.results], 180);
      probeDiagnostics.push(...gapBatch.diagnostics);
      retryCount += gapBatch.retries;
      if (gapBatch.crossEngineUsed) crossEngineCount += 1;
      allQueries.push(...gapQueries);
      ranked = await rankExpanded(ai, focus, merged, signal, SEARCH_V44_SOURCE_LIMIT);
      timings.round3Ms = Date.now() - gapStarted;
      rounds = Math.min(3, rounds + 1);
      coverage = await assessCoverage(ai, { ...plan, queries: allQueries, candidates }, ranked, history, signal);
    }
  }

  timings.totalMs = Date.now() - startedAt;
  const hostCount = new Set((ranked || []).map((x) => hostOf(x?.url || '')).filter(Boolean)).size;
  return {
    revision: SEARCH_V44_REVISION,
    plan: { ...plan, queries: uniqueQueries(allQueries, SEARCH_V44_MAX_TOTAL_QUERIES), candidates },
    rawResults: merged,
    results: ranked,
    rounds,
    coverage,
    evidenceUseful: hasUsefulSearchEvidence(ranked, 4),
    researchStateMachine: true,
    questionFirstPlanning: true,
    gapDrivenFollowups: true,
    sequentialDiscovery,
    candidateCount: candidates.length,
    candidateNames: candidates.map((x) => x.name),
    queryResultGate: true,
    authorityAfterRelevance: true,
    subrequestBudgetAware: true,
    externalSubrequestBaseTarget: SEARCH_V44_EXTERNAL_SUBREQUEST_BASE_TARGET,
    externalSubrequestWorstTarget: SEARCH_V44_EXTERNAL_SUBREQUEST_WORST_TARGET,
    retryCount,
    crossEngineCount,
    hostCount,
    probeFailures: probeDiagnostics.filter((x) => !x.ok).length,
    probeDiagnostics: probeDiagnostics.slice(0, 32),
    timings,
  };
}

export const __test'''
text, count = re.subn(runner_pattern, lambda _: runner_replacement, text, count=1)
assert count == 1, f'runner replacement count={count}'

text = text.replace(
    '  researchFocus,\n};',
    '  researchFocus,\n  extractSupportedCandidates,\n  needsCandidateDiscovery,\n  discoveryQueries,\n  buildCandidateVerificationQueries,\n};',
)

path.write_text(text)

worker_path = Path('src/worker-v44.js')
w = worker_path.read_text()
w = w.replace(
    "sourceQuality: 'question-first-gap-driven-resilient-multi-engine-v44',",
    "sourceQuality: 'sequential-candidate-verified-query-gated-v44',",
)
w = w.replace(
    "      researchFacetCount: Array.isArray(search.plan?.facets) ? search.plan.facets.length : 0,",
    "      researchFacetCount: Array.isArray(search.plan?.facets) ? search.plan.facets.length : 0,\n      sequentialDiscovery: search.sequentialDiscovery === true,\n      candidateCount: Number(search.candidateCount) || 0,\n      candidateNames: Array.isArray(search.candidateNames) ? search.candidateNames.slice(0, 6) : [],\n      queryResultGate: search.queryResultGate === true,\n      authorityAfterRelevance: search.authorityAfterRelevance === true,",
)
w = w.replace(
    "        searchResearchStateMachine: true,",
    "        searchResearchStateMachine: true,\n        searchSequentialDiscovery: true,\n        searchQueryResultGate: true,\n        searchAuthorityAfterRelevance: true,",
)
worker_path.write_text(w)

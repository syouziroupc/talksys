from pathlib import Path
import re

search_path = Path('src/search-v44.js')
text = search_path.read_text()

marker = "import { engineForIndex, fallbackEngine, searchProbe } from './search-probes-v44.js';\n"
addition = """import {
  compileFollowupQueries,
  compileInitialQueries,
  facetPlanQueries,
  heuristicResearchFacets,
  normalizeResearchFacets,
  researchFocus,
  RESEARCH_PLAN_V44_REVISION,
} from './research-plan-v44.js';
"""
if "./research-plan-v44.js" not in text:
    text = text.replace(marker, marker + addition)

text = text.replace(
    "export const SEARCH_V44_REVISION = 'deep-search-v44-resilient-multi-engine';",
    "export const SEARCH_V44_REVISION = 'deep-search-v44-question-first-evidence-loop';",
)

planner_pattern = r'''async function planDeepSearch\(ai, text, history, signal\) \{[\s\S]*?\n\}\n\nfunction hostOf'''
planner_replacement = r'''async function planDeepSearch(ai, text, history, signal) {
  const fallback = fallbackResolvedQuestion(text, history);
  const recent = contextHistory(history).map((x) => `${x.role}: ${clean(x.content, 900)}`).join('\n');
  const year = new Date().getFullYear();
  try {
    const result = await ai.run(PLANNER_MODEL, {
      messages: [
        {
          role: 'system',
          content: `あなたはTalkSysの調査設計者です。検索語を大量生成する役ではありません。まず「この質問に正しく答えるには、何が分かれば結論が決まるか」を分解してください。\n\n手順:\n1. 今回の発話を会話から自己完結した調査課題へ復元する。\n2. 結論を左右する独立した論点を3〜6個に分ける。論点は「候補発見」「価格」「仕様」「適合性」「現在性」「例外・反証」など、必要なものだけにする。\n3. 各論点について、必要な証拠、最適な情報源の種類、最初に打つ短い検索語を1本、必要なら予備検索語を最大2本だけ作る。\n4. 検索語は会話文をそのまま貼らず、固有名詞・条件・知りたい事実を中心にする。「公式」「比較」「最新」を機械的に付け足さない。情報源の性質に合う場合だけ使う。\n5. ユーザーが述べた地域、予算、型番、日時、用途、数量、除外条件を落とさない。assistantの過去発言は対象復元には使えるが外部事実の根拠にはしない。\n6. 価格・在庫・法律・制度・時刻・ニュース・現行仕様など変動情報は${year}年の現在性が確認できる論点を作る。\n7. 実在未確認の固有名詞を新しく作らない。検索本数に最低数はない。\n\nJSONだけを返す: {"resolved_question":"...","intent":"shopping|local|current|comparison|general|news|other","location":"...","must_include":["..."],"facets":[{"id":"短いID","question":"答えを決める小問","evidence_needed":"必要証拠","preferred_sources":["最適な情報源種別"],"primary_query":"最初の検索語","backup_queries":["予備1","予備2"],"priority":1-5}]}`,
        },
        { role: 'user', content: `直近の会話:\n${recent || '(なし)'}\n\n今回の発話:\n${clean(text, 1800)}` },
      ],
      stream: false,
      max_completion_tokens: 1250,
      temperature: 0.02,
      reasoning_effort: 'low',
    }, signal ? { signal } : undefined);
    const data = parseJsonObject(readModelText(result));
    if (data && typeof data === 'object') {
      const resolvedQuestion = clean(data.resolved_question || data.resolvedQuestion || fallback, 2200) || fallback;
      const inferredIntent = SHOPPING_RE.test(resolvedQuestion) ? 'shopping' : (LOCAL_RE.test(resolvedQuestion) ? 'local' : (CURRENT_OR_HIGH_STAKES_RE.test(resolvedQuestion) ? 'current' : 'general'));
      const intent = clean(data.intent || '', 40) || inferredIntent;
      const location = clean(data.location || '', 100);
      const mustInclude = Array.isArray(data.must_include || data.mustInclude)
        ? (data.must_include || data.mustInclude).map((x) => clean(x, 180)).filter(Boolean).slice(0, 10)
        : [];
      const facets = normalizeResearchFacets(data.facets, resolvedQuestion, intent);
      const queries = facetPlanQueries({ resolvedQuestion, intent, location, mustInclude, facets }, SEARCH_V44_MAX_QUERIES);
      if (facets.length && queries.length) {
        return {
          resolvedQuestion,
          intent,
          location,
          mustInclude,
          facets,
          queries,
          planned: true,
          plannerModel: PLANNER_MODEL,
          researchPlanRevision: RESEARCH_PLAN_V44_REVISION,
        };
      }
    }
  } catch {}
  const intent = SHOPPING_RE.test(fallback) ? 'shopping' : (LOCAL_RE.test(fallback) ? 'local' : (CURRENT_OR_HIGH_STAKES_RE.test(fallback) ? 'current' : 'general'));
  const facets = heuristicResearchFacets(fallback, intent, '');
  return {
    resolvedQuestion: fallback,
    intent,
    location: '',
    mustInclude: [],
    facets,
    queries: facetPlanQueries({ resolvedQuestion: fallback, intent, facets }, SEARCH_V44_MAX_QUERIES),
    planned: false,
    plannerModel: null,
    researchPlanRevision: RESEARCH_PLAN_V44_REVISION,
  };
}

function hostOf'''
text, count = re.subn(planner_pattern, lambda _: planner_replacement, text, count=1)
assert count == 1, f'planner replacement count={count}'

coverage_pattern = r'''async function assessCoverage\(ai, plan, results, history, signal\) \{[\s\S]*?\n\}\n\nfunction recoveryQueries'''
coverage_replacement = r'''async function assessCoverage(ai, plan, results, history, signal) {
  const facetLines = (plan?.facets || []).map((f) => `${f.id}: ${f.question} | 必要証拠=${f.evidenceNeeded} | 推奨=${(f.preferredSources || []).join(',')}`).join('\n');
  if (!results?.length) {
    return {
      sufficient: false,
      reason: 'no_results',
      missingFacets: (plan?.facets || []).map((f) => f.id),
      facetStatus: [],
      queries: compileFollowupQueries(plan, { sufficient: false, missingFacets: (plan?.facets || []).map((f) => f.id), queries: [] }, [], SEARCH_V44_MAX_RECOVERY_QUERIES),
    };
  }
  try {
    const result = await ai.run(PLANNER_MODEL, {
      messages: [
        {
          role: 'system',
          content: 'Web調査の証拠ギャップを監査します。検索件数やドメイン数ではなく、各論点について「結論を出すのに必要な証拠が得られたか」を判定してください。論点ごとに covered / partial / missing / conflict を付け、missingまたはconflictの論点だけ追加検索してください。partialでも結論を左右する情報が欠けていればmissing_facetsへ入れてください。すでに結論を決められるなら追加検索しません。追加検索語は不足証拠を直接取りに行く短い語にし、既存検索の言い換えは禁止です。JSONだけ: {"sufficient":true|false,"reason":"...","facet_status":[{"id":"...","status":"covered|partial|missing|conflict","reason":"..."}],"missing_facets":["id"],"queries":["...最大5"]}',
        },
        {
          role: 'user',
          content: `調査課題: ${plan.resolvedQuestion}\n意図: ${plan.intent}\n地域: ${plan.location || '(なし)'}\n必須条件: ${(plan.mustInclude || []).join(' / ') || '(なし)'}\n\n調査論点:\n${facetLines || '(なし)'}\n\n検索済み: ${(plan.queries || []).join(' / ')}\n\n上位根拠:\n${evidenceSummary(results)}`,
        },
      ],
      stream: false,
      max_completion_tokens: 650,
      temperature: 0.01,
      reasoning_effort: 'low',
    }, signal ? { signal } : undefined);
    const data = parseJsonObject(readModelText(result));
    if (data && typeof data === 'object') {
      const facetStatus = Array.isArray(data.facet_status || data.facetStatus)
        ? (data.facet_status || data.facetStatus).map((x) => ({ id: clean(x?.id, 40), status: clean(x?.status, 20), reason: clean(x?.reason, 220) })).filter((x) => x.id)
        : [];
      const missingFacets = Array.isArray(data.missing_facets || data.missingFacets)
        ? (data.missing_facets || data.missingFacets).map((x) => clean(x, 40)).filter(Boolean)
        : facetStatus.filter((x) => ['missing', 'conflict'].includes(x.status)).map((x) => x.id);
      return {
        sufficient: data.sufficient === true && missingFacets.length === 0,
        reason: clean(data.reason || '', 300),
        facetStatus,
        missingFacets,
        queries: uniqueQueries(Array.isArray(data.queries) ? data.queries : [], SEARCH_V44_MAX_RECOVERY_QUERIES),
      };
    }
  } catch {}
  const hosts = new Set((results || []).map((x) => hostOf(x?.url || '')).filter(Boolean));
  const sufficient = hasUsefulSearchEvidence(results, 7) && hosts.size >= 3;
  return {
    sufficient,
    reason: 'coverage_model_unavailable',
    facetStatus: [],
    missingFacets: sufficient ? [] : (plan?.facets || []).map((f) => f.id),
    queries: [],
  };
}

function recoveryQueries'''
text, count = re.subn(coverage_pattern, lambda _: coverage_replacement, text, count=1)
assert count == 1, f'coverage replacement count={count}'

recovery_pattern = r'''function recoveryQueries\(plan, history\) \{[\s\S]*?\n\}\n\nfunction shouldForceThirdRound'''
recovery_replacement = r'''function recoveryQueries(plan, history, coverage = {}) {
  const gaps = compileFollowupQueries(
    plan,
    {
      sufficient: false,
      missingFacets: coverage?.missingFacets?.length ? coverage.missingFacets : (plan?.facets || []).map((f) => f.id),
      queries: coverage?.queries || [],
    },
    plan?.queries || [],
    SEARCH_V44_MAX_RECOVERY_QUERIES,
  );
  return gaps.length ? gaps : deterministicQueries(plan.resolvedQuestion, history).slice(0, SEARCH_V44_MAX_RECOVERY_QUERIES);
}

function shouldForceThirdRound'''
text, count = re.subn(recovery_pattern, lambda _: recovery_replacement, text, count=1)
assert count == 1, f'recovery replacement count={count}'

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
  timings.plannerMs = Date.now() - planStarted;

  const plannedQueries = uniqueQueries(plan.queries, SEARCH_V44_MAX_QUERIES);
  let first = compileInitialQueries(plan, 6);
  if (!first.length) first = plannedQueries.slice(0, 4);
  const allQueries = [...first];

  const round1Started = Date.now();
  const batch1 = await runQueryBatch(first, {
    timeoutMs: queryTimeoutMs,
    multiEngine: true,
    engineOffset: 0,
    retryBudget: 3,
  });
  let merged = batch1.results;
  probeDiagnostics.push(...batch1.diagnostics);
  retryCount += batch1.retries;
  if (batch1.crossEngineUsed) crossEngineCount += 1;
  merged = await enrichTopResults(merged, focus, ai, signal, queryTimeoutMs, 3);
  timings.round1Ms = Date.now() - round1Started;
  let rounds = 1;

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
    timings.localMs = Date.now() - localStarted;
  }

  let ranked = await rankExpanded(ai, focus, merged, signal, SEARCH_V44_SOURCE_LIMIT);
  const coverage1Started = Date.now();
  let coverage = await assessCoverage(ai, { ...plan, queries: allQueries }, ranked, history, signal);
  timings.coverage1Ms = Date.now() - coverage1Started;

  if (!coverage.sufficient && Date.now() - startedAt < maxBudgetMs - 5000) {
    const second = compileFollowupQueries(plan, coverage, allQueries, 6);
    if (second.length) {
      const round2Started = Date.now();
      const batch2 = await runQueryBatch(second, {
        timeoutMs: queryTimeoutMs,
        multiEngine: false,
        engineOffset: 2,
        retryBudget: Math.max(0, SEARCH_V44_MAX_ENGINE_RETRIES - retryCount),
      });
      merged = dedupeSearchResults([...merged, ...batch2.results], 170);
      probeDiagnostics.push(...batch2.diagnostics);
      retryCount += batch2.retries;
      if (batch2.crossEngineUsed) crossEngineCount += 1;
      allQueries.push(...second);
      timings.round2Ms = Date.now() - round2Started;
      rounds = 2;
      ranked = await rankExpanded(ai, focus, merged, signal, SEARCH_V44_SOURCE_LIMIT);
      coverage = await assessCoverage(ai, { ...plan, queries: allQueries }, ranked, history, signal);
    }
  }

  if (!coverage.sufficient && Date.now() - startedAt < maxBudgetMs - 4000) {
    const already = new Set(allQueries.map((q) => q.toLowerCase()));
    const thirdQueries = uniqueQueries(
      [...(coverage.queries || []), ...recoveryQueries({ ...plan, queries: allQueries }, history, coverage)],
      SEARCH_V44_MAX_RECOVERY_QUERIES,
    ).filter((q) => !already.has(q.toLowerCase()));
    if (thirdQueries.length) {
      const round3Started = Date.now();
      const batch3 = await runQueryBatch(thirdQueries, {
        timeoutMs: queryTimeoutMs,
        multiEngine: ranked.length < 6,
        engineOffset: 4,
        retryBudget: Math.max(0, SEARCH_V44_MAX_ENGINE_RETRIES - retryCount),
      });
      merged = dedupeSearchResults([...merged, ...batch3.results], 180);
      probeDiagnostics.push(...batch3.diagnostics);
      retryCount += batch3.retries;
      if (batch3.crossEngineUsed) crossEngineCount += 1;
      allQueries.push(...thirdQueries);
      timings.round3Ms = Date.now() - round3Started;
      rounds = 3;
      ranked = await rankExpanded(ai, focus, merged, signal, SEARCH_V44_SOURCE_LIMIT);
      coverage = await assessCoverage(ai, { ...plan, queries: allQueries }, ranked, history, signal);
    }
  }

  timings.totalMs = Date.now() - startedAt;
  const hostCount = new Set((ranked || []).map((x) => hostOf(x?.url || '')).filter(Boolean)).size;
  return {
    revision: SEARCH_V44_REVISION,
    plan: { ...plan, queries: uniqueQueries(allQueries, SEARCH_V44_MAX_TOTAL_QUERIES) },
    rawResults: merged,
    results: ranked,
    rounds,
    coverage,
    evidenceUseful: hasUsefulSearchEvidence(ranked, 4),
    researchStateMachine: true,
    questionFirstPlanning: true,
    gapDrivenFollowups: true,
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
    '  hostOf,\n};',
    '  hostOf,\n  planDeepSearch,\n  assessCoverage,\n  compileInitialQueries,\n  compileFollowupQueries,\n  researchFocus,\n};',
)
search_path.write_text(text)

worker_path = Path('src/worker-v44.js')
w = worker_path.read_text()
w = w.replace(
    "sourceQuality: 'resilient-multi-engine-page-enriched-host-diverse-v44',",
    "sourceQuality: 'question-first-gap-driven-resilient-multi-engine-v44',",
)
w = w.replace(
    "      searchRevision: search.revision || SEARCH_V44_REVISION,",
    "      searchRevision: search.revision || SEARCH_V44_REVISION,\n      questionFirstPlanning: search.questionFirstPlanning === true,\n      gapDrivenFollowups: search.gapDrivenFollowups === true,\n      researchFacetCount: Array.isArray(search.plan?.facets) ? search.plan.facets.length : 0,",
)
w = w.replace(
    "        searchCoverageAudit: true,",
    "        searchCoverageAudit: true,\n        searchQuestionFirstPlanning: true,\n        searchGapDrivenFollowups: true,\n        searchResearchStateMachine: true,",
)
worker_path.write_text(w)

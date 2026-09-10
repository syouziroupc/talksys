from pathlib import Path

QWEN = "@cf/qwen/qwen3-30b-a3b-fp8"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"missing migration anchor: {label}")
    return text.replace(old, new, 1)


def replace_block(text: str, start: str, end: str, replacement: str, label: str) -> str:
    a = text.find(start)
    if a < 0:
        raise SystemExit(f"missing block start: {label}")
    b = text.find(end, a)
    if b < 0:
        raise SystemExit(f"missing block end: {label}")
    return text[:a] + replacement + text[b:]


# 1) Make the research/search director independent from the final answer model.
search_path = Path('src/search-v44.js')
search = search_path.read_text()
search = replace_once(
    search,
    "const PLANNER_MODEL = '@cf/zai-org/glm-5.3-flash';",
    f"const PLANNER_MODEL = '{QWEN}';",
    'planner model',
)
# Qwen Workers AI uses the standard max_tokens field. Keep its job terse and deterministic.
search = search.replace('max_completion_tokens: 1250,', 'max_tokens: 1250,')
search = search.replace('max_completion_tokens: 460,', 'max_tokens: 460,')
search = search.replace('max_completion_tokens: 650,', 'max_tokens: 650,')
search = search.replace("      reasoning_effort: 'low',\n", '')
search_path.write_text(search)


# 2) Provider-specific public-transport licences are not homogeneous, so require explicit opt-in.
api_path = Path('src/free-api-tools-v45.js')
api = api_path.read_text()
api = replace_once(
    api,
    "    notes: 'ユーザー登録・トークン必須。各データ提供者の個別利用条件にも従う。動的データは生成時刻を併記する。',\n  },\n  navitime_market:",
    "    notes: 'ユーザー登録・トークン必須。各データ提供者の個別利用条件にも従う。動的データは生成時刻を併記する。個別ライセンス確認後のみ有効化。',\n    adapterEnabled: false,\n  },\n  navitime_market:",
    'odpt registry opt-in',
)
api = replace_once(
    api,
    "async function runOdptStatus(env, signal, fetchImpl) {\n  const token = clean(env?.ODPT_API_TOKEN, 500);",
    "async function runOdptStatus(env, signal, fetchImpl) {\n  if (String(env?.ODPT_ENABLE || '') !== '1') return { ok: false, tool: 'odpt', reason: 'provider_specific_license_review_required' };\n  const token = clean(env?.ODPT_API_TOKEN, 500);",
    'odpt runtime opt-in',
)
api_path.write_text(api)


# 3) Wire structured APIs into the production worker.
worker_path = Path('src/worker-v44.js')
worker = worker_path.read_text()
worker = replace_once(
    worker,
    "import { persistTalkLog } from './log-v42.js';",
    "import { persistTalkLog } from './log-v42.js';\nimport {\n  apiEvidenceText,\n  FREE_API_REVISION,\n  publicApiRegistry,\n  runFreeApiTools,\n} from './free-api-tools-v45.js';",
    'API imports',
)
worker = replace_once(
    worker,
    "const REVISION = 'talksys-v44-default-exhaustive-search';",
    "const REVISION = 'talksys-v45-api-first-parallel-free-tools';\nconst SEARCH_DIRECTOR_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';",
    'worker revision',
)

specialized = '''function shouldPreserveSpecializedTurn(text, history = []) {
  const userContext = clean(`${userHistory(history).map((x) => x.content).join(' ')} ${text}`, 6500);
  // Weather and transit now go through the v45 API-first router. Keep only the
  // phone-specific legacy path that the base worker still handles specially.
  return PHONE_RE.test(userContext) && EXPLICIT_LOOKUP_RE.test(text);
}

'''
worker = replace_block(
    worker,
    'function shouldPreserveSpecializedTurn(text, history = []) {',
    'function fallbackResolvedQuestion',
    specialized,
    'specialized-turn routing',
)

worker = worker.replace(
    '今回のターンではWebを深掘り検索済みです。',
    '今回のターンでは構造化APIを優先し、必要に応じてWebも調査済みです。',
)
worker = worker.replace(
    '- 現在の価格、在庫、日時、時刻、法律、制度、人物、ニュース、現行仕様など変化し得る事実は取得根拠にある範囲だけ使う。',
    '- 天気、為替、地震、祝日、経路など構造化APIで取得できた項目はAPI根拠を優先する。Webは補足、例外、障害、未取得事項の確認に使う。\\n- API根拠にAttributionがある場合は、回答末尾に短く出典名を残す。\\n- 現在の価格、在庫、日時、時刻、法律、制度、人物、ニュース、現行仕様など変化し得る事実は取得根拠にある範囲だけ使う。',
)

new_deep_turn = r'''async function deepTurn(body, env, requestSignal) {
  const started = Date.now();
  const history = historyOf(body?.history);
  const text = clean(body?.text, 1800);

  const apiStarted = Date.now();
  const apiBundle = await runFreeApiTools(text, history, env, requestSignal);
  const apiMs = Date.now() - apiStarted;
  const apiOk = (apiBundle?.results || []).filter((x) => x?.ok);

  let webFallbackUsed = apiBundle?.sufficient !== true;
  let search;
  let searchMs = 0;
  if (webFallbackUsed) {
    const searchStarted = Date.now();
    search = await runDeepSearchV44(env.AI, text, history, requestSignal);
    searchMs = Date.now() - searchStarted;
  } else {
    search = {
      revision: SEARCH_V44_REVISION,
      evidenceUseful: true,
      results: [],
      rounds: 0,
      coverage: { sufficient: true, reason: 'structured free API evidence sufficient' },
      plan: { resolvedQuestion: text, queries: [], facets: [] },
      questionFirstPlanning: false,
      gapDrivenFollowups: false,
      sequentialDiscovery: false,
      researchMode: 'api_direct',
      candidateType: 'none',
      queryResultGate: true,
      authorityAfterRelevance: true,
      retryCount: 0,
      crossEngineCount: 0,
      hostCount: 0,
      probeFailures: 0,
      subrequestBudgetAware: true,
      timings: {},
    };
  }

  const apiResults = apiOk.map((x) => ({
    title: `Structured API: ${clean(x.tool, 120)}`,
    url: clean(x.sourceUrl, 700),
    excerpt: clean(`${x.attribution || ''} ${JSON.stringify(x.data ?? {})}`, 4200),
    snippet: clean(`${x.attribution || ''} ${JSON.stringify(x.data ?? {})}`, 4200),
    engine: `api:${clean(x.tool, 80)}`,
    structuredApi: true,
  }));
  search.results = [...apiResults, ...(search.results || [])].slice(0, SEARCH_V44_SOURCE_LIMIT);
  if (apiResults.length) search.evidenceUseful = true;

  const answer = await synthesizeGroundedAnswer(env, body, search);
  const sources = (search.results || []).slice(0, SEARCH_V44_SOURCE_LIMIT).map((x) => ({
    title: clean(x?.title, 220),
    url: clean(x?.url, 700),
    engine: clean(x?.engine, 80),
  }));
  const apiSources = apiOk.map((x) => ({
    tool: clean(x?.tool, 100),
    category: clean(x?.category, 80),
    sourceUrl: clean(x?.sourceUrl, 700),
    attribution: clean(x?.attribution, 220),
  }));
  return {
    ok: true,
    answer: answer.text,
    apiFirst: true,
    apiUsed: apiOk.length > 0,
    apiRevision: apiBundle?.revision || FREE_API_REVISION,
    apiIntents: Array.isArray(apiBundle?.intents) ? apiBundle.intents : [],
    apiSources,
    search: webFallbackUsed,
    route: 'api-first-v45',
    searchUseful: Boolean(search.evidenceUseful),
    resolvedQuestion: search.plan?.resolvedQuestion || text,
    queries: (search.plan?.queries || []).slice(0, SEARCH_V44_MAX_TOTAL_QUERIES),
    sources,
    searchPasses: Number(search.rounds) || 0,
    maxSearchPasses: SEARCH_V44_MAX_ROUNDS,
    searchCoverage: search.coverage || null,
    sourceQuality: apiOk.length ? 'structured-api-priority-plus-web-v45' : 'sequential-candidate-verified-query-gated-v44',
    searchMode: webFallbackUsed ? 'api-first-web-supplement' : 'structured-api-only',
    historyPolicy: 'assistant-context-not-evidence',
    subrequestBudgetAware: Boolean(search.subrequestBudgetAware),
    apiDiagnostics: {
      recognized: apiBundle?.recognized === true,
      sufficient: apiBundle?.sufficient === true,
      parallelApiExecution: apiBundle?.parallelApiExecution === true,
      apiCount: apiOk.length,
      apiFailureCount: Math.max(0, (apiBundle?.results || []).length - apiOk.length),
      webFallbackUsed,
      elapsedMs: apiMs,
      failures: (apiBundle?.results || []).filter((x) => !x?.ok).map((x) => ({ tool: clean(x?.tool, 80), reason: clean(x?.reason, 160) })).slice(0, 8),
    },
    searchDiagnostics: {
      searchRevision: search.revision || SEARCH_V44_REVISION,
      searchDirectorModel: SEARCH_DIRECTOR_MODEL,
      questionFirstPlanning: search.questionFirstPlanning === true,
      gapDrivenFollowups: search.gapDrivenFollowups === true,
      researchFacetCount: Array.isArray(search.plan?.facets) ? search.plan.facets.length : 0,
      sequentialDiscovery: search.sequentialDiscovery === true,
      researchMode: search.researchMode || '',
      candidateType: search.candidateType || '',
      candidateCount: Number(search.candidateCount) || 0,
      candidateNames: Array.isArray(search.candidateNames) ? search.candidateNames.slice(0, 6) : [],
      queryResultGate: search.queryResultGate === true,
      authorityAfterRelevance: search.authorityAfterRelevance === true,
      retryCount: Number(search.retryCount) || 0,
      crossEngineCount: Number(search.crossEngineCount) || 0,
      hostCount: Number(search.hostCount) || 0,
      probeFailures: Number(search.probeFailures) || 0,
      externalSubrequestBaseTarget: Number(search.externalSubrequestBaseTarget) || SEARCH_V44_EXTERNAL_SUBREQUEST_BASE_TARGET,
      externalSubrequestWorstTarget: Number(search.externalSubrequestWorstTarget) || SEARCH_V44_EXTERNAL_SUBREQUEST_WORST_TARGET,
      probes: Array.isArray(search.probeDiagnostics) ? search.probeDiagnostics.slice(0, 24) : [],
    },
    timings: { totalMs: Date.now() - started, apiMs, searchMs, glmMs: answer.ms, ...(search.timings || {}) },
    model: MODEL,
    planner: apiOk.length ? 'free-api-router-v45' : 'deep-search-v44',
    languageMode: 'ja-only',
  };
}

'''
worker = replace_block(
    worker,
    'async function deepTurn(body, env, requestSignal) {',
    'async function parseJsonClone',
    new_deep_turn,
    'deepTurn API-first integration',
)

worker = replace_once(
    worker,
    '        searchRevision: SEARCH_V44_REVISION,',
    "        searchRevision: SEARCH_V44_REVISION,\n        apiFirst: true,\n        apiParallel: true,\n        freeApiRevision: FREE_API_REVISION,\n        freeApiRegistry: publicApiRegistry(),\n        searchDirectorModel: SEARCH_DIRECTOR_MODEL,\n        openMeteoExcluded: true,",
    'health API flags',
)
worker_path.write_text(worker)

print('Applied v45 API-first router, Qwen Search Director, and terms-aware opt-in guards.')

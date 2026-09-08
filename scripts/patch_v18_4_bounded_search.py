from pathlib import Path
import re


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one match, got {count}: {old[:140]!r}')
    p.write_text(text.replace(old, new, 1))


def regex_replace_once(path, pattern, replacement, flags=0):
    p = Path(path)
    text = p.read_text()
    new, count = re.subn(pattern, lambda m: replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f'{path}: regex expected one match, got {count}: {pattern[:140]!r}')
    p.write_text(new)


# --- cloudflare-llm: bound each non-streaming model attempt, and do one grounded answer pass. ---
old_cascade = '''export async function runNonStreamingCascade(ai, models, messages, options = {}) {\n  let lastError = null;\n  for (const model of [...new Set(models.filter(Boolean))]) {\n    try {\n      const result = await openModel(ai, model, messages, { ...options, stream: false });\n      const text = readFinal(result);\n      if (text) return { text, model };\n    } catch (error) {\n      lastError = error;\n    }\n  }\n  if (lastError) throw lastError;\n  return { text: '', model: null };\n}\n'''
new_cascade = '''function timedSignal(parentSignal, timeoutMs) {\n  const ms = Math.max(0, Number(timeoutMs) || 0);\n  if (!(ms > 0) || typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return parentSignal;\n  const timeoutSignal = AbortSignal.timeout(ms);\n  if (!parentSignal) return timeoutSignal;\n  if (typeof AbortSignal.any === 'function') return AbortSignal.any([parentSignal, timeoutSignal]);\n  return parentSignal;\n}\n\nasync function awaitWithTimeout(promise, timeoutMs, label = 'operation') {\n  const ms = Math.max(0, Number(timeoutMs) || 0);\n  if (!(ms > 0)) return promise;\n  let timer;\n  try {\n    return await Promise.race([\n      promise,\n      new Promise((_, reject) => {\n        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);\n      }),\n    ]);\n  } finally {\n    if (timer) clearTimeout(timer);\n  }\n}\n\nexport async function runNonStreamingCascade(ai, models, messages, options = {}) {\n  let lastError = null;\n  const perModelTimeoutMs = Math.max(0, Math.min(12000, Number(options.perModelTimeoutMs) || 0));\n  for (const model of [...new Set(models.filter(Boolean))]) {\n    try {\n      const modelSignal = timedSignal(options.signal, perModelTimeoutMs);\n      const result = await awaitWithTimeout(\n        openModel(ai, model, messages, { ...options, signal: modelSignal, stream: false }),\n        perModelTimeoutMs ? perModelTimeoutMs + 150 : 0,\n        `Workers AI ${model}`,\n      );\n      const text = readFinal(result);\n      if (text) return { text, model };\n      lastError = new Error(`Workers AI returned an empty response for ${model}`);\n    } catch (error) {\n      lastError = error;\n    }\n  }\n  if (lastError) throw lastError;\n  return { text: '', model: null };\n}\n'''
replace_once('src/cloudflare-llm.js', old_cascade, new_cascade)

new_answer = '''export async function answerWithCloudflareWebSearch(ai, question, history, systemPrompt, options = {}) {\n  const totalStarted = Date.now();\n  const signal = options.signal;\n  const deepSearch = await runDeepSearch(ai, question, history, signal, { timeoutMs: 4400 });\n  const ranked = deepSearch.results || [];\n  const resolvedQuestion = deepSearch.plan?.resolvedQuestion || question;\n  const searchContext = formatSearchContext(ranked);\n  const evidence = searchContext || '今回の取得では直接のWeb根拠が取れなかった。現在価格・在庫・営業時間など変化する具体的事実は作らない。ただし質問への一般的な判断や購入チャネルの比較は必ず続けること。';\n  const messages = buildGroundedMessages(question, history, systemPrompt, resolvedQuestion, evidence);\n\n  const answerStarted = Date.now();\n  let answer;\n  try {\n    // Use one reliable high-capacity grounded attempt first. A slower model is only a bounded fallback.\n    answer = await runNonStreamingCascade(ai, [GROUNDING_FALLBACK_MODEL, GROUNDING_CONVERSATION_MODEL], messages, {\n      signal,\n      maxTokens: 680,\n      temperature: 0.08,\n      perModelTimeoutMs: 3800,\n      sessionAffinity: options.sessionAffinity,\n    });\n  } catch {\n    answer = { text: '', model: null };\n  }\n  const answerMs = Date.now() - answerStarted;\n\n  let repaired = false;\n  if (isEvasiveGroundedAnswer(answer.text)) {\n    const rescue = deterministicRescue(resolvedQuestion || question, ranked);\n    if (rescue) {\n      answer = { text: rescue, model: answer.model || GROUNDING_FALLBACK_MODEL };\n      repaired = true;\n    }\n  }\n\n  return {\n    text: String(answer.text || '').trim() || '確認できた範囲から、まず実用的な選択肢を絞って答えます。',\n    provider: 'cloudflare-workers-ai-bounded-contextual-search-v18',\n    nativeSearch: false,\n    model: answer.model,\n    resolvedQuestion,\n    queries: deepSearch.plan?.queries || [question],\n    planned: Boolean(deepSearch.plan?.planned),\n    recovered: Boolean(deepSearch.recovered),\n    rounds: Number(deepSearch.rounds) || 1,\n    coverage: deepSearch.coverage || null,\n    evidenceUseful: Boolean(deepSearch.evidenceUseful),\n    answerRepaired: repaired,\n    sources: ranked.slice(0, 12),\n    timings: {\n      ...(deepSearch.timings || {}),\n      answerMs,\n      beforeAuditMs: Date.now() - totalStarted,\n    },\n  };\n}\n'''
regex_replace_once(
    'src/cloudflare-llm.js',
    r"export async function answerWithCloudflareWebSearch\(ai, question, history, systemPrompt, options = \{\}\) \{[\s\S]*?\n\}\n\nexport \{ readFinal, readDelta, streamResult \};",
    new_answer + "\nexport { readFinal, readDelta, streamResult };",
)

# --- reranker: never let an optional semantic reranker block a search turn. ---
replace_once(
    'src/search-rerank.js',
    'export async function rerankSearchResults(ai, query, results, limit = 3) {\n',
    'export async function rerankSearchResults(ai, query, results, limit = 3, options = {}) {\n',
)
replace_once(
    'src/search-rerank.js',
    '''    const response = await ai.run(SEARCH_RERANK_MODEL, {\n      query: String(query || '').slice(0, 700),\n      contexts,\n      top_k: Math.min(input.length, Math.max(outputLimit, 8)),\n    });\n''',
    '''    const timeoutMs = Math.max(500, Math.min(4000, Number(options.timeoutMs) || 1800));\n    const timeoutSignal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : null;\n    const signal = options.signal && timeoutSignal && typeof AbortSignal.any === 'function'\n      ? AbortSignal.any([options.signal, timeoutSignal])\n      : (options.signal || timeoutSignal);\n    const response = await ai.run(SEARCH_RERANK_MODEL, {\n      query: String(query || '').slice(0, 700),\n      contexts,\n      top_k: Math.min(input.length, Math.max(outputLimit, 8)),\n    }, signal ? { signal } : undefined);\n''',
)

# --- orchestrator: high-model planning and deterministic retrieval start concurrently. ---
replace_once(
    'src/search-orchestrator.js',
    '''export const SEARCH_FILLER_MODEL = LIVE_VOICE_MODEL;\nexport const SEARCH_MAX_QUERIES = 8;\nexport const SEARCH_MAX_ROUNDS = 2;\nexport const SEARCH_FILLER_MIN_DELAY_MS = 650;\n''',
    '''export const SEARCH_FILLER_MODEL = LIVE_VOICE_MODEL;\nexport const SEARCH_MAX_QUERIES = 8;\nexport const SEARCH_MAX_ROUNDS = 2;\nexport const SEARCH_FILLER_MIN_DELAY_MS = 650;\nexport const SEARCH_TOTAL_BUDGET_MS = 17000;\nexport const SEARCH_PLANNER_BUDGET_MS = 2800;\nexport const SEARCH_FETCH_BUDGET_MS = 4400;\nexport const SEARCH_COVERAGE_BUDGET_MS = 2200;\n''',
)
replace_once(
    'src/search-orchestrator.js',
    '  const models = [...new Set([GROUNDING_VOICE_MODEL, GROUNDING_FALLBACK_MODEL].filter(Boolean))];\n',
    '  const models = [...new Set([GROUNDING_FALLBACK_MODEL, GROUNDING_VOICE_MODEL].filter(Boolean))];\n',
)
# Replace the second occurrence (coverage) too.
replace_once(
    'src/search-orchestrator.js',
    '  const models = [...new Set([GROUNDING_VOICE_MODEL, GROUNDING_FALLBACK_MODEL].filter(Boolean))];\n',
    '  const models = [...new Set([GROUNDING_FALLBACK_MODEL, GROUNDING_VOICE_MODEL].filter(Boolean))];\n',
)

helper_anchor = '''function shouldForceSecondPass(plan, resolvedQuestion) {\n  if (plan?.intent === 'local_purchase' || plan?.intent === 'shopping' || plan?.intent === 'current_fact' || plan?.intent === 'news') return true;\n  return HIGH_VERIFICATION_RE.test(String(resolvedQuestion || ''));\n}\n\n'''
helper_new = '''function shouldForceSecondPass(plan, resolvedQuestion) {\n  if (plan?.intent === 'local_purchase' || plan?.intent === 'shopping' || plan?.intent === 'current_fact' || plan?.intent === 'news') return true;\n  return HIGH_VERIFICATION_RE.test(String(resolvedQuestion || ''));\n}\n\nfunction remainingBudget(startedAt, totalMs = SEARCH_TOTAL_BUDGET_MS) {\n  return Math.max(0, totalMs - (Date.now() - startedAt));\n}\n\nfunction phaseSignal(parentSignal, timeoutMs) {\n  const ms = Math.max(1, Number(timeoutMs) || 1);\n  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return parentSignal;\n  const timeoutSignal = AbortSignal.timeout(ms);\n  if (!parentSignal) return timeoutSignal;\n  if (typeof AbortSignal.any === 'function') return AbortSignal.any([parentSignal, timeoutSignal]);\n  return parentSignal;\n}\n\nfunction fallbackPlan(transcript, history) {\n  const resolvedQuestion = heuristicContextQuery(transcript, history) || cleanQuery(transcript);\n  return {\n    resolvedQuestion,\n    queries: uniqueQueries([resolvedQuestion, ...buildDeterministicSearchQueries(resolvedQuestion, history)], SEARCH_MAX_QUERIES),\n    intent: HIGH_VERIFICATION_RE.test(resolvedQuestion) ? 'current_fact' : 'general_fact',\n    location: '',\n    mustInclude: [],\n    plannerModel: null,\n    planned: false,\n  };\n}\n\n'''
replace_once('src/search-orchestrator.js', helper_anchor, helper_new)

new_deep = '''export async function runDeepSearch(ai, transcript, history, signal, options = {}) {\n  const startedAt = Date.now();\n  const timings = {};\n  const configuredFetch = Number(options.timeoutMs) || SEARCH_FETCH_BUDGET_MS;\n  const fetchTimeoutMs = Math.max(2800, Math.min(SEARCH_FETCH_BUDGET_MS, configuredFetch));\n\n  const seedQuestion = heuristicContextQuery(transcript, history) || cleanQuery(transcript);\n  const seedQueries = uniqueQueries([\n    seedQuestion,\n    ...buildDeterministicSearchQueries(seedQuestion || transcript, history),\n  ], 4);\n  if (!seedQueries.length) seedQueries.push(cleanQuery(transcript));\n\n  const plannerPromise = (async () => {\n    const t = Date.now();\n    try {\n      const budget = Math.min(SEARCH_PLANNER_BUDGET_MS, Math.max(500, remainingBudget(startedAt)));\n      return await planSearchQueries(ai, transcript, history, phaseSignal(signal, budget));\n    } catch {\n      return fallbackPlan(transcript, history);\n    } finally {\n      timings.plannerMs = Date.now() - t;\n    }\n  })();\n\n  const firstSearchPromise = (async () => {\n    const t = Date.now();\n    try {\n      return await Promise.all(seedQueries.map((query, index) => searchOne(query, fetchTimeoutMs, index < 2)));\n    } finally {\n      timings.firstSearchMs = Date.now() - t;\n    }\n  })();\n\n  // High-model query planning never blocks the first deterministic retrieval pass.\n  const [planRaw, firstBatches] = await Promise.all([plannerPromise, firstSearchPromise]);\n  const plan = planRaw || fallbackPlan(transcript, history);\n  const allQueries = uniqueQueries([...seedQueries, ...(plan.queries || []), plan.resolvedQuestion], SEARCH_MAX_QUERIES);\n  plan.queries = allQueries;\n\n  let merged = dedupeResults(firstBatches.flat(), 64);\n  const seedKeys = new Set(seedQueries.map((item) => cleanQuery(item).toLowerCase()));\n  const supplementalQueries = allQueries.filter((item) => !seedKeys.has(cleanQuery(item).toLowerCase())).slice(0, 4);\n  const localPurchase = looksLocalPurchase(plan.resolvedQuestion || transcript, plan);\n  const localQueries = localPurchase ? uniqueQueries([\n    ...buildDeterministicSearchQueries(plan.resolvedQuestion || transcript, history),\n    plan.location ? `${plan.location} パソコン 店舗` : '',\n  ], 2) : [];\n\n  const supplementalStarted = Date.now();\n  const [supplementalBatches, localBatches] = await Promise.all([\n    supplementalQueries.length && remainingBudget(startedAt) > 2500\n      ? Promise.all(supplementalQueries.map((query, index) => searchOne(query, fetchTimeoutMs, index < 2)))\n      : Promise.resolve([]),\n    localQueries.length\n      ? Promise.all(localQueries.map((query) => searchOpenStreetMapLocal(query, { timeoutMs: Math.min(fetchTimeoutMs, 3500) }).catch(() => [])))\n      : Promise.resolve([]),\n  ]);\n  timings.supplementalSearchMs = Date.now() - supplementalStarted;\n  merged = dedupeResults([...merged, ...supplementalBatches.flat(), ...localBatches.flat()], 84);\n\n  const rankQuestion = plan.resolvedQuestion || transcript;\n  const rerankStarted = Date.now();\n  let prelim = await rerankSearchResults(ai, rankQuestion, merged, 12, {\n    signal: phaseSignal(signal, Math.min(1800, Math.max(500, remainingBudget(startedAt)))),\n    timeoutMs: 1800,\n  });\n  timings.firstRerankMs = Date.now() - rerankStarted;\n\n  const coverageStarted = Date.now();\n  let coverage;\n  if (remainingBudget(startedAt) > 800) {\n    try {\n      const coverageBudget = Math.min(SEARCH_COVERAGE_BUDGET_MS, Math.max(700, remainingBudget(startedAt)));\n      coverage = await assessCoverage(ai, plan, prelim, phaseSignal(signal, coverageBudget));\n    } catch {\n      coverage = { sufficient: hasUsefulSearchEvidence(prelim, 6), reason: 'coverage_budget_fallback', queries: [] };\n    }\n  } else {\n    coverage = { sufficient: hasUsefulSearchEvidence(prelim, 6), reason: 'coverage_skipped_for_budget', queries: [] };\n  }\n  timings.coverageMs = Date.now() - coverageStarted;\n\n  let recovered = false;\n  let rounds = 1;\n  const needsRecovery = !coverage.sufficient\n    || (shouldForceSecondPass(plan, rankQuestion) && !hasUsefulSearchEvidence(prelim, 6));\n\n  if (SEARCH_MAX_ROUNDS > 1 && needsRecovery && remainingBudget(startedAt) > 3600) {\n    const retryQueries = uniqueQueries([\n      ...(coverage.queries || []),\n      ...deterministicRecoveryQueries(plan, transcript, history),\n    ], 3).filter((query) => !allQueries.some((old) => old.toLowerCase() === query.toLowerCase()));\n\n    if (retryQueries.length) {\n      const retryStarted = Date.now();\n      const retryTimeout = Math.min(fetchTimeoutMs, Math.max(2600, remainingBudget(startedAt) - 800));\n      const retryBatches = await Promise.all(retryQueries.map((query) => searchOne(query, retryTimeout, false)));\n      timings.recoverySearchMs = Date.now() - retryStarted;\n      merged = dedupeResults([...merged, ...retryBatches.flat()], 88);\n      recovered = retryBatches.some((batch) => batch.length > 0);\n      plan.queries = uniqueQueries([...(plan.queries || []), ...retryQueries], 12);\n      rounds = 2;\n    }\n  }\n\n  const finalRerankStarted = Date.now();\n  const results = await rerankSearchResults(ai, rankQuestion, merged, 12, {\n    signal: phaseSignal(signal, Math.min(1600, Math.max(400, remainingBudget(startedAt)))),\n    timeoutMs: 1600,\n  });\n  timings.finalRerankMs = Date.now() - finalRerankStarted;\n  timings.totalDeepSearchMs = Date.now() - startedAt;\n\n  return {\n    plan,\n    rawResults: merged,\n    results,\n    recovered,\n    rounds,\n    coverage,\n    evidenceUseful: hasUsefulSearchEvidence(results, 4),\n    timings,\n  };\n}\n'''
regex_replace_once(
    'src/search-orchestrator.js',
    r"export async function runDeepSearch\(ai, transcript, history, signal, options = \{\}\) \{[\s\S]*?\n\}\n\nfunction sanitizeProgressTopic",
    new_deep + "\nfunction sanitizeProgressTopic",
)

# --- answer audit: one bounded audit, then deterministic guard; never a second slow audit. ---
replace_once(
    'src/search-answer-v18.js',
    '  const models = [GROUNDING_FALLBACK_MODEL, GROUNDING_CONVERSATION_MODEL, QUALITY_CONVERSATION_MODEL];\n',
    '  const models = [GROUNDING_FALLBACK_MODEL];\n',
)
replace_once(
    'src/search-answer-v18.js',
    '''    maxTokens: 900,\n    temperature: 0.01,\n    sessionAffinity: options.sessionAffinity,\n''',
    '''    maxTokens: 760,\n    temperature: 0.01,\n    perModelTimeoutMs: 2500,\n    sessionAffinity: options.sessionAffinity,\n''',
)

new_verified = '''export async function answerWithVerifiedWebSearch(ai, question, history, systemPrompt, options = {}) {\n  const totalStarted = Date.now();\n  const base = await answerWithCloudflareWebSearch(ai, question, history, systemPrompt, options);\n  let text = String(base.text || '').trim();\n  let audit = { ok: false, answer: '', unsupported: [], reason: 'not_run' };\n\n  const auditStarted = Date.now();\n  try {\n    audit = await auditAnswer(ai, question, base.resolvedQuestion || question, text, base.sources || [], options);\n    if (audit.answer) text = audit.answer;\n  } catch {\n    audit = { ok: false, answer: '', unsupported: [], reason: 'audit_budget_or_model_failure' };\n  }\n  const auditMs = Date.now() - auditStarted;\n\n  // Mechanical evidence guard is the final authority. Do not spend another model round auditing an audit.\n  const unsupported = unsupportedNamedCandidates(text, base.sources || []);\n  if (!text || BAD_SEARCH_BOILERPLATE_RE.test(text) || unsupported.length) {\n    const rescue = sourceTitleRescue(base.resolvedQuestion || question, base.sources || []);\n    if (rescue) text = rescue;\n  }\n\n  return {\n    ...base,\n    text: text || '確認できた情報を整理して、分かった範囲から答えます。',\n    provider: 'cloudflare-workers-ai-bounded-verified-search-v18',\n    auditPassed: unsupported.length === 0 && audit.ok === true,\n    auditReason: audit.reason,\n    unsupportedRemoved: [...new Set([...(audit.unsupported || []), ...unsupported])].slice(0, 12),\n    timings: {\n      ...(base.timings || {}),\n      auditMs,\n      totalSearchAnswerMs: Date.now() - totalStarted,\n    },\n  };\n}\n'''
regex_replace_once(
    'src/search-answer-v18.js',
    r"export async function answerWithVerifiedWebSearch\(ai, question, history, systemPrompt, options = \{\}\) \{[\s\S]*?\n\}\n\nexport \{ parseAuditJson",
    new_verified + "\nexport { parseAuditJson",
)

# --- worker: v18.4, second non-spam progress update, timing telemetry. ---
replace_once('src/worker-v14.js', "const VOICE_REVISION = 'cloudflare-live-v18.3';\n", "const VOICE_REVISION = 'cloudflare-live-v18.4';\n")
replace_once(
    'src/worker-v14.js',
    "import { generateSearchFiller, SEARCH_FILLER_MODEL, shouldDeepSearch } from './search-orchestrator.js';\n",
    "import {\n  generateSearchFiller,\n  SEARCH_FILLER_MODEL,\n  SEARCH_TOTAL_BUDGET_MS,\n  SEARCH_PLANNER_BUDGET_MS,\n  SEARCH_FETCH_BUDGET_MS,\n  SEARCH_COVERAGE_BUDGET_MS,\n  shouldDeepSearch,\n} from './search-orchestrator.js';\n",
)

old_search_promise = '''      const searchPromise = answerWithVerifiedWebSearch(\n        self.env.AI,\n        transcript,\n        [],\n        GROUNDED_SYSTEM_PROMPT,\n        {\n          signal: context.signal,\n          sessionAffinity: sessionAffinity(context),\n        },\n      );\n      const fillerPromise = generateSearchFiller(self.env.AI, transcript, [], context.signal);\n\n      const first = await Promise.race([\n        searchPromise.then((result) => ({ type: 'result', result })),\n        fillerPromise.then((text) => ({ type: 'filler', text })).catch(() => ({ type: 'filler', text: '' })),\n      ]);\n'''
new_search_promise = '''      let searchSettled = false;\n      let secondProgressTimer = null;\n      const searchPromise = answerWithVerifiedWebSearch(\n        self.env.AI,\n        transcript,\n        [],\n        GROUNDED_SYSTEM_PROMPT,\n        {\n          signal: context.signal,\n          sessionAffinity: sessionAffinity(context),\n        },\n      ).finally(() => {\n        searchSettled = true;\n        if (secondProgressTimer) clearTimeout(secondProgressTimer);\n      });\n      const fillerPromise = generateSearchFiller(self.env.AI, transcript, [], context.signal);\n      secondProgressTimer = setTimeout(() => {\n        if (searchSettled || context.signal?.aborted) return;\n        try {\n          context.connection.send(JSON.stringify({\n            type: 'search_status',\n            phase: 'searching',\n            searched: true,\n            waitPhrase: '候補を絞って情報を照合しています。もう少しお待ちください。',\n          }));\n        } catch {}\n      }, 8000);\n\n      const first = await Promise.race([\n        searchPromise.then((result) => ({ type: 'result', result })),\n        fillerPromise.then((text) => ({ type: 'filler', text })).catch(() => ({ type: 'filler', text: '' })),\n      ]);\n'''
replace_once('src/worker-v14.js', old_search_promise, new_search_promise)
replace_once(
    'src/worker-v14.js',
    '''          auditPassed: Boolean(result.auditPassed),\n          sources: Array.isArray(result.sources) ? result.sources.slice(0, 12).map((item) => ({ title: item.title, url: item.url })) : [],\n''',
    '''          auditPassed: Boolean(result.auditPassed),\n          timings: result.timings || null,\n          sources: Array.isArray(result.sources) ? result.sources.slice(0, 12).map((item) => ({ title: item.title, url: item.url })) : [],\n''',
)
replace_once(
    'src/worker-v14.js',
    "        webSearch: 'contextual-8-query+two-pass+google+duckduckgo+bing+bing-rss+wikipedia+google-news+page-evidence+reranker+answer-audit',\n",
    "        webSearch: 'bounded-parallel-8-query+conditional-recovery+google+duckduckgo+bing+bing-rss+wikipedia+google-news+page-evidence+reranker+answer-audit',\n",
)
replace_once(
    'src/worker-v14.js',
    '''        searchMaxQueries: 8,\n        searchMaxRounds: 2,\n        searchWaitSpeech: true,\n''',
    '''        searchMaxQueries: 8,\n        searchMaxRounds: 2,\n        searchDeepResearchBudgetMs: SEARCH_TOTAL_BUDGET_MS,\n        searchPlannerBudgetMs: SEARCH_PLANNER_BUDGET_MS,\n        searchFetchBudgetMs: SEARCH_FETCH_BUDGET_MS,\n        searchCoverageBudgetMs: SEARCH_COVERAGE_BUDGET_MS,\n        searchAnswerModelBudgetMs: 3800,\n        searchAuditBudgetMs: 2500,\n        searchSecondProgressSpeechMs: 8000,\n        searchWaitSpeech: true,\n''',
)

# --- contract revisions and new source assertions. ---
for path in ['tests/voice-llm-contract.test.mjs', 'tests/gemini-live-contract.test.mjs']:
    p = Path(path)
    text = p.read_text().replace('cloudflare-live-v18\\.3', 'cloudflare-live-v18\\.4')
    p.write_text(text)

Path('tests/search-budget-regression.test.mjs').write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runNonStreamingCascade } from '../src/cloudflare-llm.js';
import {
  SEARCH_TOTAL_BUDGET_MS,
  SEARCH_PLANNER_BUDGET_MS,
  SEARCH_FETCH_BUDGET_MS,
  SEARCH_COVERAGE_BUDGET_MS,
} from '../src/search-orchestrator.js';

const orchestrator = await readFile(new URL('../src/search-orchestrator.js', import.meta.url), 'utf8');
const worker = await readFile(new URL('../src/worker-v14.js', import.meta.url), 'utf8');
const audit = await readFile(new URL('../src/search-answer-v18.js', import.meta.url), 'utf8');

test('precision search has explicit bounded phase budgets while normal chat remains separate', () => {
  assert.equal(SEARCH_TOTAL_BUDGET_MS, 17000);
  assert.equal(SEARCH_PLANNER_BUDGET_MS, 2800);
  assert.equal(SEARCH_FETCH_BUDGET_MS, 4400);
  assert.equal(SEARCH_COVERAGE_BUDGET_MS, 2200);
  assert.match(orchestrator, /High-model query planning never blocks the first deterministic retrieval pass/);
  assert.match(orchestrator, /Promise\.all\(\[plannerPromise, firstSearchPromise\]\)/);
  assert.match(worker, /normalConversationLiveOnly: true/);
  assert.match(worker, /searchPrecisionOnly: true/);
  assert.match(worker, /searchSecondProgressSpeechMs: 8000/);
});

test('a hanging non-streaming model cannot block the whole cascade', async () => {
  const started = Date.now();
  const ai = {
    run(model) {
      if (model === 'slow') return new Promise(() => {});
      return Promise.resolve({ choices: [{ message: { content: 'fallback ok' } }] });
    },
  };
  const result = await runNonStreamingCascade(ai, ['slow', 'fast'], [{ role: 'user', content: 'test' }], {
    perModelTimeoutMs: 40,
  });
  assert.equal(result.text, 'fallback ok');
  assert.equal(result.model, 'fast');
  assert.ok(Date.now() - started < 500);
});

test('answer audit is single-pass and mechanical guard replaces recursive re-auditing', () => {
  assert.match(audit, /Mechanical evidence guard is the final authority/);
  assert.match(audit, /perModelTimeoutMs: 2500/);
  assert.doesNotMatch(audit, /const second = await auditAnswer/);
});
''')

print('v18.4 bounded precision search patch applied')

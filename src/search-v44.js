import { relevanceScore, webSearch } from './web-search.js';
import { rerankSearchResults } from './search-rerank.js';
import {
  buildDeterministicSearchQueries,
  dedupeSearchResults,
  hasUsefulSearchEvidence,
  searchOpenStreetMapLocal,
} from './search-fallbacks.js';
import { engineForIndex, fallbackEngine, searchProbe } from './search-probes-v44.js';
import {
  compileFollowupQueries,
  compileInitialQueries,
  facetPlanQueries,
  heuristicResearchFacets,
  normalizeResearchFacets,
  researchFocus,
  RESEARCH_PLAN_V44_REVISION,
} from './research-plan-v44.js';

export const SEARCH_V44_REVISION = 'deep-search-v44-question-first-evidence-loop';
export const SEARCH_V44_MAX_QUERIES = 14;
export const SEARCH_V44_MAX_RECOVERY_QUERIES = 5;
export const SEARCH_V44_MAX_TOTAL_QUERIES = SEARCH_V44_MAX_QUERIES + SEARCH_V44_MAX_RECOVERY_QUERIES;
export const SEARCH_V44_MAX_ROUNDS = 3;
export const SEARCH_V44_SOURCE_LIMIT = 18;
export const SEARCH_V44_TOTAL_BUDGET_MS = 30000;
export const SEARCH_V44_QUERY_TIMEOUT_MS = 6200;
export const SEARCH_V44_PROBE_CONCURRENCY = 4;
export const SEARCH_V44_MAX_ENGINE_RETRIES = 5;
export const SEARCH_V44_MAX_PER_HOST = 2;
// Baseline external fetch target: 14 distributed probes + one 6-source cross-check +
// 3 page reads + up to 2 local lookups + 5 recovery probes = about 30.
// Failed probes may consume up to 5 extra retries, leaving headroom below Workers Free's
// 50 external-subrequest limit even before accounting for unusual redirect chains.
export const SEARCH_V44_EXTERNAL_SUBREQUEST_BASE_TARGET = 30;
export const SEARCH_V44_EXTERNAL_SUBREQUEST_WORST_TARGET = 35;

const PLANNER_MODEL = '@cf/zai-org/glm-5.3-flash';
const CURRENT_OR_HIGH_STAKES_RE = /(最新|現在|今日|明日|今|価格|値段|在庫|営業時間|法律|制度|規制|ニュース|発売|販売|予定|日程|時刻|時刻表|天気|株価|為替|相場|選挙|首相|大統領|CEO|仕様|バージョン|アップデート)/i;
const LOCAL_RE = /(?:都|道|府|県|市|区|町|村).*(?:店|店舗|販売店|病院|ホテル|飲食|行き方|アクセス|近く|周辺)|(?:店|店舗|販売店|病院|ホテル|飲食|近く|周辺).*(?:都|道|府|県|市|区|町|村)/i;
const SHOPPING_RE = /(買|購入|おすすめ|比較|価格|値段|在庫|販売店|店舗|通販|中古|新品|製品|商品)/i;

function clean(value, max = 4000) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function readModelText(result) {
  if (typeof result === 'string') return clean(result, 12000);
  if (!result) return '';
  for (const value of [result.response, result.result, result.text, result.output_text]) {
    if (typeof value === 'string' && value.trim()) return clean(value, 12000);
  }
  const content = result.choices?.[0]?.message?.content;
  if (typeof content === 'string') return clean(content, 12000);
  if (Array.isArray(content)) return clean(content.map((x) => typeof x === 'string' ? x : (x?.text || x?.content || '')).join(' '), 12000);
  return clean(result.choices?.[0]?.text || '', 12000);
}

function userHistory(history, limit = 10) {
  return Array.isArray(history)
    ? history.filter((x) => x && x.role === 'user' && clean(x.content)).slice(-limit)
    : [];
}

function contextHistory(history, limit = 12) {
  return Array.isArray(history)
    ? history.filter((x) => x && (x.role === 'user' || x.role === 'assistant') && clean(x.content)).slice(-limit)
    : [];
}

function fallbackResolvedQuestion(text, history) {
  const current = clean(text, 1800);
  if (!current) return '';
  if (current.length >= 42) return current;
  const users = userHistory(history, 6).map((x) => clean(x.content, 700)).filter(Boolean);
  if (!users.length) return current;
  return clean(`${users.slice(-4).join(' ')} ${current}`, 2200);
}

function uniqueQueries(values, limit = SEARCH_V44_MAX_QUERIES) {
  const seen = new Set();
  const out = [];
  for (const raw of values || []) {
    const q = clean(typeof raw === 'string' ? raw : raw?.q, 320);
    if (q.length < 2) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length >= limit) break;
  }
  return out;
}

function parseJsonObject(text) {
  const raw = String(text || '').trim();
  const candidate = raw.match(/\{[\s\S]*\}/)?.[0] || raw;
  try { return JSON.parse(candidate); } catch { return null; }
}

function deterministicQueries(resolved, history) {
  const base = buildDeterministicSearchQueries(resolved, history) || [];
  const year = new Date().getFullYear();
  const extra = [resolved, `${resolved} 公式`, `${resolved} 一次情報`, `${resolved} 比較`, `${resolved} ${year}`];
  if (SHOPPING_RE.test(resolved)) extra.push(`${resolved} 販売 価格`, `${resolved} 評判 比較`);
  if (CURRENT_OR_HIGH_STAKES_RE.test(resolved)) extra.push(`${resolved} 最新 公式 ${year}`);
  return uniqueQueries([...base, ...extra], SEARCH_V44_MAX_QUERIES);
}

async function planDeepSearch(ai, text, history, signal) {
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

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function diversifyHosts(results, limit = SEARCH_V44_SOURCE_LIMIT, maxPerHost = SEARCH_V44_MAX_PER_HOST) {
  const items = Array.isArray(results) ? results.filter(Boolean) : [];
  const out = [];
  const deferred = [];
  const counts = new Map();
  for (const item of items) {
    const host = hostOf(item?.url || '') || `unknown:${out.length + deferred.length}`;
    const count = counts.get(host) || 0;
    if (count < maxPerHost) {
      counts.set(host, count + 1);
      out.push(item);
    } else {
      deferred.push(item);
    }
    if (out.length >= limit) return out.slice(0, limit);
  }
  for (const item of deferred) {
    out.push(item);
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

function summarizeProbe(probe) {
  return {
    engine: probe?.engine || '',
    query: probe?.query || '',
    ok: probe?.ok === true,
    count: Array.isArray(probe?.results) ? probe.results.length : 0,
    error: clean(probe?.error || '', 120),
    elapsedMs: Number(probe?.elapsedMs) || 0,
  };
}

async function runDistributedProbes(queries, options = {}) {
  const list = uniqueQueries(queries, SEARCH_V44_MAX_QUERIES);
  const timeoutMs = options.timeoutMs;
  const engineOffset = Math.max(0, Number(options.engineOffset) || 0);
  const retryBudget = Math.max(0, Math.min(SEARCH_V44_MAX_ENGINE_RETRIES, Number(options.retryBudget ?? SEARCH_V44_MAX_ENGINE_RETRIES)));
  const results = [];
  const diagnostics = [];
  const failed = [];

  for (let offset = 0; offset < list.length; offset += SEARCH_V44_PROBE_CONCURRENCY) {
    const batch = list.slice(offset, offset + SEARCH_V44_PROBE_CONCURRENCY);
    const settled = await Promise.all(batch.map((q, i) => {
      const absoluteIndex = offset + i;
      const engine = engineForIndex(absoluteIndex, engineOffset);
      return searchProbe(engine, q, { timeoutMs, limit: 10 });
    }));
    for (const probe of settled) {
      diagnostics.push(summarizeProbe(probe));
      if (probe?.ok && Array.isArray(probe.results) && probe.results.length) results.push(...probe.results);
      else failed.push(probe);
    }
  }

  let retries = 0;
  for (const failedProbe of failed) {
    if (retries >= retryBudget) break;
    const engine = fallbackEngine(failedProbe?.engine || 'bing-rss');
    const retry = await searchProbe(engine, failedProbe?.query || '', { timeoutMs, limit: 10 });
    diagnostics.push({ ...summarizeProbe(retry), retryOf: failedProbe?.engine || '' });
    if (retry?.ok && Array.isArray(retry.results)) results.push(...retry.results);
    retries += 1;
  }

  return {
    results: dedupeSearchResults(results, 140),
    diagnostics,
    retries,
    failures: diagnostics.filter((x) => !x.ok).length,
  };
}

async function runQueryBatch(queries, options = {}) {
  const list = uniqueQueries(queries, SEARCH_V44_MAX_QUERIES);
  if (!list.length) return { results: [], diagnostics: [], retries: 0, crossEngineUsed: false };

  const distributed = await runDistributedProbes(list, options);
  let merged = distributed.results;
  let crossEngineUsed = false;

  if (options.multiEngine === true || merged.length < 6) {
    const cross = await webSearch(list[0], {
      limit: 12,
      timeoutMs: options.timeoutMs,
      enrichPages: false,
    }).catch(() => []);
    merged = dedupeSearchResults([...cross, ...merged], 150);
    crossEngineUsed = true;
  }

  return {
    results: merged,
    diagnostics: distributed.diagnostics,
    retries: distributed.retries,
    failures: distributed.failures,
    crossEngineUsed,
  };
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function stripHtml(value) {
  return decodeEntities(String(value || ''))
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractPageExcerpt(html) {
  const source = String(html || '');
  const meta = source.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/i)
    || source.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description)["']/i);
  const paragraphs = [];
  for (const match of source.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = stripHtml(match[1]);
    if (text.length < 35) continue;
    paragraphs.push(text);
    if (paragraphs.join(' ').length >= 3500) break;
  }
  return [meta ? decodeEntities(meta[1]) : '', ...paragraphs].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 4200);
}

async function enrichOne(item, timeoutMs) {
  if (!/^https?:\/\//i.test(item?.url || '')) return item;
  try {
    const response = await fetch(item.url, {
      redirect: 'follow',
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'ja,en;q=0.7',
        'user-agent': 'TalkSys/44 (+https://talksys.syouziroupc.workers.dev)',
      },
      signal: AbortSignal.timeout(Math.min(4200, timeoutMs)),
    });
    if (!response.ok) return { ...item, pageFetch: `http_${response.status}` };
    const type = response.headers.get('content-type') || '';
    if (!/(?:text|html)/i.test(type)) return { ...item, pageFetch: 'unsupported_content_type' };
    const html = (await response.text()).slice(0, 500000);
    const excerpt = extractPageExcerpt(html);
    return excerpt
      ? { ...item, excerpt, pageFetch: 'ok', engine: item.engine ? `${item.engine}+page` : 'page-direct-v44' }
      : { ...item, pageFetch: 'empty_excerpt' };
  } catch (error) {
    return { ...item, pageFetch: clean(error?.name || error?.message || error, 100) || 'page_fetch_failed' };
  }
}

async function enrichTopResults(results, question, ai, signal, timeoutMs, count = 3) {
  if (!Array.isArray(results) || !results.length || count <= 0) return results || [];
  const candidates = await rerankSearchResults(ai, question, results, Math.min(6, Math.max(count, 4)), { signal, timeoutMs: 2200 });
  const targets = diversifyHosts(candidates, count, 1).slice(0, count);
  const enriched = await Promise.all(targets.map((item) => enrichOne(item, timeoutMs)));
  const byUrl = new Map(enriched.map((item) => [item.url, item]));
  return (results || []).map((item) => byUrl.get(item.url) || item);
}

async function rankExpanded(ai, question, results, signal, limit = SEARCH_V44_SOURCE_LIMIT) {
  const unique = dedupeSearchResults(results, 120)
    .map((item) => ({ item, score: relevanceScore(question, item) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item)
    .slice(0, 72);
  if (unique.length <= 6) return diversifyHosts(unique, limit);

  const modelRanked = [];
  for (let offset = 0; offset < unique.length && modelRanked.length < Math.min(limit, 12); offset += 24) {
    const chunk = unique.slice(offset, offset + 24);
    const ranked = await rerankSearchResults(ai, question, chunk, 6, { signal, timeoutMs: 2500 });
    modelRanked.push(...ranked);
  }
  const selectedUrls = new Set(modelRanked.map((x) => x.url));
  const supplements = unique.filter((x) => !selectedUrls.has(x.url));
  return diversifyHosts(dedupeSearchResults([...modelRanked, ...supplements], 72), limit);
}

function evidenceSummary(results, limit = SEARCH_V44_SOURCE_LIMIT) {
  return (results || []).slice(0, limit).map((item, index) => {
    const host = hostOf(item?.url || '');
    return `[${index + 1}] ${clean(item?.title, 220)}\n${host}\n${clean(item?.excerpt || item?.snippet, 1200)}`;
  }).join('\n\n');
}

async function assessCoverage(ai, plan, results, history, signal) {
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

function recoveryQueries(plan, history, coverage = {}) {
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

function shouldForceThirdRound(plan) {
  return ['shopping', 'local', 'current', 'comparison', 'news'].includes(String(plan?.intent || ''))
    || CURRENT_OR_HIGH_STAKES_RE.test(plan?.resolvedQuestion || '');
}

export async function runDeepSearchV44(ai, text, history = [], signal, options = {}) {
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

export const __test = {
  clean,
  fallbackResolvedQuestion,
  uniqueQueries,
  deterministicQueries,
  shouldForceThirdRound,
  extractPageExcerpt,
  diversifyHosts,
  hostOf,
  planDeepSearch,
  assessCoverage,
  compileInitialQueries,
  compileFollowupQueries,
  researchFocus,
};

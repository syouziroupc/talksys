import { relevanceScore, webSearch } from './web-search.js';
import { rerankSearchResults } from './search-rerank.js';
import {
  buildDeterministicSearchQueries,
  dedupeSearchResults,
  hasUsefulSearchEvidence,
  searchOpenStreetMapLocal,
} from './search-fallbacks.js';
import { engineForIndex, fallbackEngine, searchProbe } from './search-probes-v44.js';
import { filterQueryRelevantResults, isQueryRelevantResult } from './query-result-gate-v44.js';
import {
  buildCandidateVerificationQueries,
  candidateEvidenceText,
  candidateTypeForPlan,
  discoveryQueries,
  needsCandidateDiscovery,
  normalizeCandidates,
  researchModeForPlan,
} from './research-sequence-v44.js';
import {
  compileFollowupQueries,
  compileInitialQueries,
  facetPlanQueries,
  heuristicResearchFacets,
  normalizeResearchFacets,
  researchFocus,
  RESEARCH_PLAN_V44_REVISION,
} from './research-plan-v44.js';

export const SEARCH_V44_REVISION = 'deep-search-v44-sequential-evidence-search';
export const SEARCH_V44_MAX_QUERIES = 14;
export const SEARCH_V44_MAX_RECOVERY_QUERIES = 5;
export const SEARCH_V44_MAX_TOTAL_QUERIES = SEARCH_V44_MAX_QUERIES + SEARCH_V44_MAX_RECOVERY_QUERIES;
export const SEARCH_V44_MAX_ROUNDS = 3;
export const SEARCH_V44_SOURCE_LIMIT = 18;
export const SEARCH_V44_TOTAL_BUDGET_MS = 30000;
export const SEARCH_V44_QUERY_TIMEOUT_MS = 6200;
export const SEARCH_V44_PROBE_CONCURRENCY = 4;
export const SEARCH_V44_MAX_ENGINE_RETRIES = 3;
export const SEARCH_V44_MAX_PER_HOST = 2;
// Baseline external fetch target: 14 distributed probes + one 6-source cross-check +
// 3 page reads + up to 2 local lookups + 5 recovery probes = about 30.
// Failed probes may consume up to 5 extra retries, leaving headroom below Workers Free's
// 50 external-subrequest limit even before accounting for unusual redirect chains.
export const SEARCH_V44_EXTERNAL_SUBREQUEST_BASE_TARGET = 30;
export const SEARCH_V44_EXTERNAL_SUBREQUEST_WORST_TARGET = 35;

const PLANNER_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';

const SEARCH_DIRECTOR_TOOL_NAME = 'submit_research_plan';
const SEARCH_DIRECTOR_TOOL = {
  name: SEARCH_DIRECTOR_TOOL_NAME,
  description: 'Return the structured research plan that TalkSys should execute. Do not answer the user.',
  parameters: {
    type: 'object',
    properties: {
      resolved_question: { type: 'string' },
      intent: { type: 'string', enum: ['shopping', 'local', 'current', 'comparison', 'general', 'news', 'other'] },
      research_mode: { type: 'string', enum: ['direct_fact', 'discover_then_verify', 'compare_known_entities', 'local_discovery', 'current_status'] },
      candidate_type: { type: 'string', enum: ['product_model', 'store', 'place', 'company', 'service', 'person', 'document', 'none'] },
      location: { type: 'string' },
      must_include: { type: 'array', items: { type: 'string' }, maxItems: 10 },
      facets: {
        type: 'array', minItems: 1, maxItems: 6,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            stage: { type: 'string', enum: ['discovery', 'verification', 'context'] },
            question: { type: 'string' },
            evidence_needed: { type: 'string' },
            source_role: { type: 'string', enum: ['primary', 'official_spec', 'official_support', 'seller', 'marketplace', 'map', 'news', 'independent_review', 'reference', 'mixed'] },
            preferred_sources: { type: 'array', items: { type: 'string' }, maxItems: 5 },
            primary_query: { type: 'string' },
            backup_queries: { type: 'array', items: { type: 'string' }, maxItems: 2 },
            priority: { type: 'integer', minimum: 1, maximum: 5 },
          },
          required: ['id', 'stage', 'question', 'evidence_needed', 'source_role', 'primary_query', 'priority'],
        },
      },
    },
    required: ['resolved_question', 'intent', 'research_mode', 'candidate_type', 'facets'],
  },
};
const CURRENT_OR_HIGH_STAKES_RE = /(最新|現在|今日|明日|今|価格|値段|在庫|営業時間|法律|制度|規制|ニュース|発売|販売|予定|日程|時刻|時刻表|天気|株価|為替|相場|選挙|首相|大統領|CEO|仕様|バージョン|アップデート)/i;
const LOCAL_RE = /(?:都|道|府|県|市|区|町|村).*(?:店|店舗|販売店|病院|ホテル|飲食|行き方|アクセス|近く|周辺)|(?:店|店舗|販売店|病院|ホテル|飲食|近く|周辺).*(?:都|道|府|県|市|区|町|村)/i;
const SHOPPING_RE = /(買|購入|おすすめ|比較|価格|値段|在庫|販売店|店舗|通販|中古|新品|製品|商品)/i;
const LOW_VALUE_RESEARCH_HOST_RE = /(?:^|\.)(?:gamewith\.jp)$/i;

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


function readToolArguments(result, expectedName = SEARCH_DIRECTOR_TOOL_NAME) {
  const calls = [
    ...(Array.isArray(result?.tool_calls) ? result.tool_calls : []),
    ...(Array.isArray(result?.choices?.[0]?.message?.tool_calls) ? result.choices[0].message.tool_calls : []),
  ];
  for (const call of calls) {
    const name = clean(call?.name || call?.function?.name, 80);
    if (name !== expectedName) continue;
    const raw = call?.arguments ?? call?.function?.arguments;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    if (typeof raw === 'string' && raw.trim()) {
      const parsed = parseJsonObject(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  }
  return null;
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
  let plannerError = '';
  try {
    const result = await ai.run(PLANNER_MODEL, {
      messages: [
        {
          role: 'system',
          content: `あなたはTalkSysの調査設計者です。検索語を大量生成する役ではありません。まず「この質問に正しく答えるには、何が分かれば結論が決まるか」と「どの順序で調べる必要があるか」を設計してください。\n\n手順:\n1. 今回の発話を会話から自己完結した調査課題へ復元する。\n2. 調査モードを決める。direct_fact=既知対象の事実確認、discover_then_verify=未知候補を見つけてから候補別検証、compare_known_entities=既知対象比較、local_discovery=店舗/場所発見後に営業等検証、current_status=最新状態確認。\n3. 候補探索が必要なら candidate_type を product_model|store|place|company|service|person|document のどれかに固定する。不要なら none。商品選定では販売店ではなく product_model、近隣店舗探索では store を選ぶ。\n4. 結論を左右する独立した論点を3〜6個に分ける。各論点に stage=discovery|verification と source_role を付ける。source_role は primary|official_spec|official_support|seller|marketplace|map|news|independent_review|reference|mixed。\n5. discoveryは候補そのものを実在確認する検索、verificationは発見した候補の価格・仕様・適合性・弱点等を確認する検索にする。候補が未知なのにverificationを先に一般論で大量検索しない。\n6. 各論点について必要証拠、最適情報源、最初の短い検索語を1本、必要なら予備検索語を最大2本だけ作る。検索語は固有名詞・条件・知りたい事実を中心にし、「公式」「比較」「最新」を機械的に付け足さない。\n7. ユーザーが述べた地域、予算、型番、日時、用途、数量、除外条件を落とさない。assistantの過去発言は対象復元には使えるが外部事実の根拠にはしない。\n8. 価格・在庫・法律・制度・時刻・ニュース・現行仕様など変動情報は${year}年の現在性を確認する。実在未確認の固有名詞を作らない。検索本数に最低数はない。\n\nsubmit_research_plan ツールを必ず1回呼び出す。ツール呼び出しが利用できない場合だけJSON本文を返す: {"resolved_question":"...","intent":"shopping|local|current|comparison|general|news|other","research_mode":"direct_fact|discover_then_verify|compare_known_entities|local_discovery|current_status","candidate_type":"product_model|store|place|company|service|person|document|none","location":"...","must_include":["..."],"facets":[{"id":"短いID","stage":"discovery|verification","question":"答えを決める小問","evidence_needed":"必要証拠","source_role":"primary|official_spec|official_support|seller|marketplace|map|news|independent_review|reference|mixed","preferred_sources":["最適な情報源種別"],"primary_query":"最初の検索語","backup_queries":["予備1","予備2"],"priority":1-5}]}`,
        },
        { role: 'user', content: `直近の会話:\n${recent || '(なし)'}\n\n今回の発話:\n${clean(text, 1800)}` },
      ],
      tools: [SEARCH_DIRECTOR_TOOL],
      stream: false,
      max_tokens: 1250,
      temperature: 0.02,
    }, signal ? { signal } : undefined);
    const toolData = readToolArguments(result);
    const textData = toolData ? null : parseJsonObject(readModelText(result));
    const data = toolData || textData;
    const plannerTransport = toolData ? 'tool_call' : (textData ? 'text_json' : 'none');
    if (data && typeof data === 'object') {
      const resolvedQuestion = clean(data.resolved_question || data.resolvedQuestion || fallback, 2200) || fallback;
      const inferredIntent = SHOPPING_RE.test(resolvedQuestion) ? 'shopping' : (LOCAL_RE.test(resolvedQuestion) ? 'local' : (CURRENT_OR_HIGH_STAKES_RE.test(resolvedQuestion) ? 'current' : 'general'));
      const intent = clean(data.intent || '', 40) || inferredIntent;
      const location = clean(data.location || '', 100);
      const mustInclude = Array.isArray(data.must_include || data.mustInclude)
        ? (data.must_include || data.mustInclude).map((x) => clean(x, 180)).filter(Boolean).slice(0, 10)
        : [];
      const facets = normalizeResearchFacets(data.facets, resolvedQuestion, intent);
      const strategySeed = {
        resolvedQuestion,
        intent,
        location,
        mustInclude,
        facets,
        researchMode: clean(data.research_mode || data.researchMode || '', 40),
        candidateType: clean(data.candidate_type || data.candidateType || '', 40),
      };
      const researchMode = researchModeForPlan(strategySeed);
      const candidateType = candidateTypeForPlan(strategySeed);
      const queries = facetPlanQueries({ ...strategySeed, researchMode, candidateType }, SEARCH_V44_MAX_QUERIES);
      if (facets.length && queries.length) {
        return {
          resolvedQuestion,
          intent,
          researchMode,
          candidateType,
          location,
          mustInclude,
          facets,
          queries,
          planned: true,
          plannerModel: PLANNER_MODEL,
          plannerTransport,
          plannerError: '',
          researchPlanRevision: RESEARCH_PLAN_V44_REVISION,
        };
      }
    }
    plannerError = 'invalid_planner_output';
  } catch (error) {
    plannerError = clean(error?.message || error?.name || error, 180) || 'planner_failed';
  }
  const intent = SHOPPING_RE.test(fallback) ? 'shopping' : (LOCAL_RE.test(fallback) ? 'local' : (CURRENT_OR_HIGH_STAKES_RE.test(fallback) ? 'current' : 'general'));
  const facets = heuristicResearchFacets(fallback, intent, '');
  const seed = { resolvedQuestion: fallback, intent, location: '', mustInclude: [], facets };
  const researchMode = researchModeForPlan(seed);
  const candidateType = candidateTypeForPlan(seed);
  return {
    ...seed,
    researchMode,
    candidateType,
    queries: facetPlanQueries({ ...seed, researchMode, candidateType }, SEARCH_V44_MAX_QUERIES),
    planned: false,
    plannerModel: null,
    plannerTransport: 'heuristic',
    plannerError: plannerError || 'planner_unavailable',
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
    const gatedCross = filterQueryRelevantResults(list[0], cross, 12).map((item) => ({
      ...item,
      probeQuery: item?.probeQuery || list[0],
      probeEngine: item?.probeEngine || 'cross-engine',
    }));
    merged = dedupeSearchResults([...gatedCross, ...merged], 150);
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
    .filter((item) => isQueryRelevantResult(item?.probeQuery || question, item))
    .filter((item) => !LOW_VALUE_RESEARCH_HOST_RE.test(hostOf(item?.url || '')))
    .map((item) => ({ item, score: relevanceScore(question, item) + (Number(item?.queryGateScore) || 0) * 2 }))
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

function heuristicCandidatesFromResults(plan, results, limit = 4) {
  const candidateType = candidateTypeForPlan(plan);
  const out = [];
  const seen = new Set();
  const push = (name, evidence) => {
    const value = clean(name, 120).replace(/^[\s「『【\[]+|[\s」』】\]]+$/g, '').trim();
    if (!value || seen.has(value.toLowerCase())) return;
    seen.add(value.toLowerCase());
    out.push({ name: value, type: candidateType, evidence: clean(evidence, 220) });
  };
  for (const item of results || []) {
    const title = clean(`${item?.title || ''} ${item?.excerpt || item?.snippet || ''}`, 1500);
    if (!title) continue;
    if (candidateType === 'product_model') {
      const patterns = [
        /CF-[A-Z]{1,4}\d{1,4}[A-Z0-9-]*/gi,
        /ThinkPad\s+(?:X|T|L|E|P)\d{3,4}(?:\s+Gen\s+\d+)?/gi,
        /Latitude\s+\d{4}/gi,
        /(?:EliteBook|ProBook)\s+\d{3,4}\s+G\d+/gi,
        /LIFEBOOK\s+[A-Z]\d{3,4}[A-Z0-9-]*/gi,
        /dynabook\s+[A-Z]\d{2,4}[A-Z0-9-]*/gi,
        /VAIO\s+[A-Z]{1,3}\d{2,4}[A-Z0-9-]*/gi,
        /iPhone\s+(?:SE(?:\s*\d)?|\d{1,2})(?:\s+(?:Pro|Plus|mini|Max))?/gi,
        /Pixel\s+\d+[a-z]?(?:\s+Pro)?/gi,
        /Galaxy\s+[A-Z]\d{2,3}[A-Z0-9-]*/gi,
        /AQUOS\s+(?:sense|wish|R)\d+[A-Z0-9-]*/gi,
      ];
      for (const re of patterns) {
        for (const m of title.matchAll(re)) push(m[0], item?.title || title);
      }
    } else if (candidateType === 'store') {
      const patterns = [
        /パソコン工房[^|｜–—]{0,30}?店/g,
        /(?:PC\s*DEPOT|ピーシーデポ)[^|｜–—]{0,30}?店/gi,
        /じゃんぱら[^|｜–—]{0,30}?店/g,
        /ハードオフ[^|｜–—]{0,30}?店/g,
        /ソフマップ[^|｜–—]{0,30}?店/g,
      ];
      for (const re of patterns) {
        for (const m of title.matchAll(re)) push(m[0], item?.title || title);
      }
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

async function extractSupportedCandidates(ai, plan, results, signal) {
  const evidence = candidateEvidenceText(results, 24);
  if (!evidence) return [];
  const candidateType = candidateTypeForPlan(plan);
  const researchMode = researchModeForPlan(plan);
  const typeRule = candidateType === 'product_model'
    ? 'product_model=具体的な製品名・機種名・型番のみ。販売店、メーカー企業名だけ、記事媒体名は禁止。例: ThinkPad X280, CF-SV8, iPhone 13。'
    : candidateType === 'store'
      ? 'store=実在する販売店・店舗名のみ。商品型番や記事媒体名は禁止。'
      : candidateType === 'place'
        ? 'place=実在する施設・場所名のみ。'
        : `${candidateType}=その種類の固有名詞だけを返す。`;
  try {
    const result = await ai.run(PLANNER_MODEL, {
      messages: [
        {
          role: 'system',
          content: `検索結果から、次の検証検索に使う実在候補を抽出します。要求された候補タイプは ${candidateType} です。${typeRule} 候補名は提示された検索結果のタイトルまたは本文に文字列として実在し、今回のユーザー条件に関係するものだけ。一般カテゴリ名、記事タイトル、検索サイト名、ログインページ名、推測した名前は禁止。条件に合う候補が証拠中に無ければ空配列にしてください。JSONだけ: {"candidates":[{"name":"検索結果に実在する正確な候補名","type":"${candidateType}","evidence":"どの結果で確認したか短く"}]}`,
        },
        {
          role: 'user',
          content: `調査課題: ${plan.resolvedQuestion}\n調査モード: ${researchMode}\n候補タイプ: ${candidateType}\n意図: ${plan.intent}\n必須条件: ${(plan.mustInclude || []).join(' / ') || '(なし)'}\n\n検索結果:\n${evidence}`,
        },
      ],
      stream: false,
      max_tokens: 460,
      temperature: 0.01,
    }, signal ? { signal } : undefined);
    const data = parseJsonObject(readModelText(result));
    const typed = normalizeCandidates(data?.candidates, evidence, 4, candidateType);
    return typed.length ? typed : heuristicCandidatesFromResults(plan, results, 4);
  } catch {
    return heuristicCandidatesFromResults(plan, results, 4);
  }
}

async function assessCoverage(ai, plan, results, history, signal) {
  const facetLines = (plan?.facets || []).map((f) => `${f.id}: stage=${f.stage || 'verification'} | ${f.question} | 必要証拠=${f.evidenceNeeded} | source_role=${f.sourceRole || 'reference'} | 推奨=${(f.preferredSources || []).join(',')}`).join('\n');
  if (!results?.length) {
    return {
      sufficient: false,
      reason: 'no_results',
      missingFacets: (plan?.facets || []).map((f) => f.id),
      facetStatus: [],
      queries: compileFollowupQueries(plan, { sufficient: false, missingFacets: (plan?.facets || []).map((f) => f.id), queries: [] }, [], SEARCH_V44_MAX_RECOVERY_QUERIES),
    };
  }
  const coverageSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(2600)]) : AbortSignal.timeout(2600);
  try {
    const result = await ai.run(PLANNER_MODEL, {
      messages: [
        {
          role: 'system',
          content: 'Web調査の証拠ギャップを監査します。検索件数やドメイン数ではなく、各論点について「結論を出すのに必要な証拠が、要求されたsource_roleの種類の情報源から得られたか」を判定してください。仕様を一般ブログだけでcoveredにせず、official_specならメーカー公式仕様相当、価格ならseller、所在地ならmap/公式店舗情報を優先してください。論点ごとに covered / partial / missing / conflict を付け、missingまたはconflictの論点だけ追加検索してください。partialでも結論を左右する情報が欠けていればmissing_facetsへ入れてください。すでに結論を決められるなら追加検索しません。追加検索語は不足証拠とsource_roleを直接取りに行く短い語にし、既存検索の言い換えは禁止です。JSONだけ: {"sufficient":true|false,"reason":"...","facet_status":[{"id":"...","status":"covered|partial|missing|conflict","reason":"..."}],"missing_facets":["id"],"queries":["...最大5"]}',
        },
        {
          role: 'user',
          content: `調査課題: ${plan.resolvedQuestion}\n意図: ${plan.intent}\n地域: ${plan.location || '(なし)'}\n必須条件: ${(plan.mustInclude || []).join(' / ') || '(なし)'}\n\n調査論点:\n${facetLines || '(なし)'}\n\n検索済み: ${(plan.queries || []).join(' / ')}\n\n上位根拠:\n${evidenceSummary(results)}`,
        },
      ],
      stream: false,
      max_tokens: 650,
      temperature: 0.01,
    }, { signal: coverageSignal });
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
  const sufficient = hasUsefulSearchEvidence(results, 4) && hosts.size >= 2;
  return {
    sufficient,
    reason: sufficient ? 'deterministic_evidence_coverage' : 'deterministic_evidence_gap',
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
    plannerPlanned: plan.planned === true,
    plannerTransport: plan.plannerTransport || (plan.planned ? 'unknown' : 'heuristic'),
    plannerError: clean(plan.plannerError || '', 180),
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
    researchMode: researchModeForPlan(plan),
    candidateType: candidateTypeForPlan(plan),
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

export const __test = {
  clean,
  fallbackResolvedQuestion,
  uniqueQueries,
  deterministicQueries,
  shouldForceThirdRound,
  extractPageExcerpt,
  diversifyHosts,
  hostOf,
  readToolArguments,
  planDeepSearch,
  assessCoverage,
  compileInitialQueries,
  compileFollowupQueries,
  researchFocus,
  extractSupportedCandidates,
  needsCandidateDiscovery,
  discoveryQueries,
  buildCandidateVerificationQueries,
};

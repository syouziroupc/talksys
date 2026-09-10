import {
  dedupeSearchResults,
  hasUsefulSearchEvidence,
  searchBingRss,
  searchOpenStreetMapLocal,
} from './search-fallbacks.js';
import { fetchDirectPrimarySources } from './direct-primary-v45.js';

export const SEARCH_V44_REVISION = 'deep-search-v45-single-provider-staged-evidence';
export const SEARCH_V44_MAX_QUERIES = 6;
export const SEARCH_V44_MAX_RECOVERY_QUERIES = 2;
export const SEARCH_V44_MAX_TOTAL_QUERIES = 8;
export const SEARCH_V44_MAX_ROUNDS = 2;
export const SEARCH_V44_SOURCE_LIMIT = 10;
export const SEARCH_V44_PROBE_CONCURRENCY = 2;
export const SEARCH_V44_MAX_ENGINE_RETRIES = 0;
export const SEARCH_V44_MAX_PER_HOST = 2;
export const SEARCH_V44_EXTERNAL_SUBREQUEST_BASE_TARGET = 10;
export const SEARCH_V44_EXTERNAL_SUBREQUEST_WORST_TARGET = 14;
export const SEARCH_V45_TOTAL_BUDGET_MS = 6500;
export const SEARCH_V45_QUERY_TIMEOUT_MS = 1900;
export const SEARCH_V45_DIRECTOR_TIMEOUT_MS = 2200;
export const SEARCH_V45_PROVIDER = 'bing-rss-keyless-single-index';

const DIRECTOR_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';
const DIRECTOR_TOOL = {
  name: 'submit_research_plan',
  description: 'Return a compact research plan. Do not answer the user.',
  parameters: {
    type: 'object',
    properties: {
      resolved_question: { type: 'string' },
      intent: { type: 'string', enum: ['shopping','local','current','comparison','general','news','other'] },
      research_mode: { type: 'string', enum: ['direct_fact','discover_then_verify','compare_known_entities','local_discovery','current_status'] },
      candidate_type: { type: 'string', enum: ['product_model','store','place','company','service','person','document','none'] },
      facets: {
        type: 'array', minItems: 1, maxItems: 4,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            stage: { type: 'string', enum: ['discovery','verification','context'] },
            source_role: { type: 'string', enum: ['primary','official_spec','official_support','seller','marketplace','map','news','independent_review','reference','mixed'] },
            primary_query: { type: 'string' },
          },
          required: ['id','stage','source_role','primary_query'],
        },
      },
    },
    required: ['resolved_question','intent','research_mode','candidate_type','facets'],
  },
};

const SHOPPING_RE = /(買|購入|おすすめ|比較|価格|値段|在庫|販売|中古|新品|商品|製品|パソコン|PC|スマホ)/i;
const LOCAL_RE = /(?:都|道|府|県|市|区|町|村).*(?:店|店舗|販売店|病院|ホテル|飲食|近く|周辺)|(?:店|店舗|販売店|近く|周辺).*(?:都|道|府|県|市|区|町|村)/i;
const CURRENT_RE = /(最新|現在|今日|明日|今|価格|値段|在庫|営業時間|法律|制度|規制|ニュース|発売|販売|予定|日程|時刻|天気|株価|為替|BIOS|UEFI|ファームウェア|ドライバ|バージョン)/i;
const MODEL_RE = /(?:CF-[A-Z0-9-]{3,}|ThinkPad\s+[A-Z]\d{3,4}|Latitude\s+\d{4}|EliteBook\s+\d{3,4}|ProBook\s+\d{3,4}|LIFEBOOK\s+[A-Z0-9-]{3,}|dynabook\s+[A-Z0-9-]{3,}|VAIO\s+[A-Z0-9-]{3,}|iPhone\s+(?:SE|\d{1,2})|Pixel\s+\d+|Galaxy\s+[A-Z]\d{2,3}|AQUOS\s+(?:sense|wish|R)\d+|X79A-[A-Z0-9-]+)/i;
const LOW_VALUE_HOST_RE = /(?:^|\.)(?:gamewith\.jp|accounts\.google\.com)$/i;

function clean(value, max = 3000) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalize(value) {
  return clean(value, 5000).normalize('NFKC').toLowerCase()
    .replace(/ノート\s*pc/gi, 'ノートパソコン')
    .replace(/中古\s*pc/gi, '中古パソコン');
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function userHistory(history, limit = 6) {
  return Array.isArray(history) ? history.filter(x => x?.role === 'user' && clean(x?.content)).slice(-limit) : [];
}

function resolvedQuestion(text, history) {
  const current = clean(text, 1800);
  if (current.length >= 36) return current;
  const prior = userHistory(history, 4).map(x => clean(x.content, 500));
  return prior.length ? clean(`${prior.join(' ')} ${current}`, 2200) : current;
}

function unique(values, limit = SEARCH_V44_MAX_QUERIES) {
  const out = [], seen = new Set();
  for (const raw of values || []) {
    const value = clean(typeof raw === 'string' ? raw : raw?.query, 220);
    if (value.length < 2) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key); out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function inferIntent(value) {
  if (LOCAL_RE.test(value)) return 'local';
  // Shopping remains the domain even when the requested operation is comparison.
  // This keeps deterministic fallback correct when the AI director times out.
  if (SHOPPING_RE.test(value)) return 'shopping';
  if (/比較|どっち|違い/.test(value)) return 'comparison';
  if (/ニュース/.test(value)) return 'news';
  if (CURRENT_RE.test(value)) return 'current';
  return 'general';
}

export function needsSearchDirector(text) {
  const value = clean(text, 1800);
  if (!value) return false;
  const genericShopping = SHOPPING_RE.test(value) && /(おすすめ|選ん|選ぶ|どれ|何がいい|候補|比較)/.test(value) && !MODEL_RE.test(value);
  const multiConstraint = (value.match(/(?:以下|以上|以内|用途|予算|かつ|なおかつ|ただし|除外|比較|条件)/g) || []).length >= 2;
  const multiEntityComparison = /比較|どっち/.test(value) && (value.match(/[A-Za-z]{2,}[A-Za-z0-9-]*\d+[A-Za-z0-9-]*/g) || []).length >= 2;
  return genericShopping || multiConstraint || multiEntityComparison;
}

function officialDomainHint(value) {
  const v = normalize(value);
  if (/\bmsi\b|x79a-/.test(v)) return 'msi.com';
  if (/panasonic|cf-/.test(v)) return 'panasonic.jp';
  if (/thinkpad|lenovo/.test(v)) return 'lenovo.com';
  if (/latitude|\bdell\b/.test(v)) return 'dell.com';
  if (/elitebook|probook|\bhp\b/.test(v)) return 'hp.com';
  if (/iphone|\bapple\b/.test(v)) return 'apple.com';
  if (/pixel/.test(v)) return 'google.com';
  if (/galaxy/.test(v)) return 'samsung.com';
  return '';
}

function compactSubject(value) {
  return clean(value, 220)
    .replace(/[？?！!。]+$/g, '')
    .replace(/(?:教えて|調べて|検索して|確認して|探して|お願いします?|ください)$/g, '')
    .trim();
}

function budgetToken(value) {
  const man = value.match(/(\d+(?:\.\d+)?)\s*万円\s*(?:以下|以内)?/);
  if (man) return `${man[1]}万円以下`;
  const yen = value.match(/([\d,]{4,})\s*円\s*(?:以下|以内)?/);
  return yen ? `${yen[1]}円以下` : '';
}

function simplePlan(text, history) {
  const resolved = resolvedQuestion(text, history);
  const intent = inferIntent(resolved);
  const known = MODEL_RE.exec(resolved)?.[0] || '';
  const domain = officialDomainHint(resolved);
  const budget = budgetToken(resolved);
  const queries = [];
  let researchMode = 'direct_fact';
  let candidateType = 'none';
  if (intent === 'shopping' && !known) {
    researchMode = 'discover_then_verify'; candidateType = 'product_model';
    if (/ノート|パソコン|PC/i.test(resolved)) {
      queries.push(`${budget ? `${budget} ` : ''}中古 ノートパソコン 型番`);
      queries.push(`${budget ? `${budget} ` : ''}中古 ノートパソコン 販売`);
    } else {
      queries.push(compactSubject(resolved));
    }
  } else if (intent === 'local') {
    researchMode = 'local_discovery'; candidateType = 'store';
    queries.push(compactSubject(resolved));
  } else {
    const subject = compactSubject(resolved);
    if (domain && known && /(BIOS|UEFI|ファームウェア|ドライバ|仕様|サポート)/i.test(resolved)) {
      const kind = /BIOS|UEFI/i.test(resolved) ? 'BIOS' : /ドライバ/i.test(resolved) ? 'ドライバ' : /仕様/i.test(resolved) ? '仕様' : 'サポート';
      queries.push(`${known} ${kind} site:${domain}`);
      queries.push(`${known} ${kind}`);
    } else {
      queries.push(subject);
    }
  }
  return {
    resolvedQuestion: resolved,
    intent,
    researchMode,
    candidateType,
    facets: queries.slice(0, 2).map((q, i) => ({ id: `f${i+1}`, stage: researchMode === 'discover_then_verify' ? 'discovery' : 'verification', sourceRole: domain ? 'official_support' : (intent === 'shopping' ? 'seller' : 'primary'), primaryQuery: q })),
    queries: unique(queries, 3),
    planned: false,
    plannerModel: null,
    plannerTransport: 'deterministic-simple',
    plannerError: '',
  };
}

function parseJsonObject(text) {
  const raw = String(text || '').trim();
  const candidate = raw.match(/\{[\s\S]*\}/)?.[0] || raw;
  try { return JSON.parse(candidate); } catch { return null; }
}

function readToolArguments(result) {
  const calls = [
    ...(Array.isArray(result?.tool_calls) ? result.tool_calls : []),
    ...(Array.isArray(result?.choices?.[0]?.message?.tool_calls) ? result.choices[0].message.tool_calls : []),
  ];
  for (const call of calls) {
    if (clean(call?.name || call?.function?.name, 80) !== DIRECTOR_TOOL.name) continue;
    const raw = call?.arguments ?? call?.function?.arguments;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    if (typeof raw === 'string') return parseJsonObject(raw);
  }
  return null;
}

async function directorPlan(ai, text, history, signal) {
  const fallback = simplePlan(text, history);
  if (!needsSearchDirector(text)) return fallback;
  const context = userHistory(history, 5).map(x => `user: ${clean(x.content, 500)}`).join('\n');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_V45_DIRECTOR_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const result = await ai.run(DIRECTOR_MODEL, {
      messages: [
        { role: 'system', content: 'TalkSysの調査Directorです。複雑な質問だけを、最大4論点の短い調査計画へ分解してください。未知の商品候補はdiscoveryを先にし、候補発見後の仕様・価格はverificationに分けます。検索語は短く、ユーザーが言っていない条件を追加しません。submit_research_planを1回だけ呼び出してください。' },
        { role: 'user', content: `直近のユーザー文脈:\n${context || '(なし)'}\n今回:${clean(text, 1800)}` },
      ],
      tools: [DIRECTOR_TOOL],
      stream: false,
      max_tokens: 700,
      temperature: 0.01,
    }, { signal: combined });
    const data = readToolArguments(result);
    if (!data || !Array.isArray(data.facets) || !data.facets.length) throw new Error('director_invalid_plan');
    const facets = data.facets.slice(0, 4).map((f, i) => ({
      id: clean(f?.id || `f${i+1}`, 40),
      stage: ['discovery','verification','context'].includes(f?.stage) ? f.stage : 'verification',
      sourceRole: clean(f?.source_role || 'reference', 40),
      primaryQuery: clean(f?.primary_query, 220),
    })).filter(f => f.primaryQuery);
    if (!facets.length) throw new Error('director_empty_queries');
    return {
      resolvedQuestion: clean(data.resolved_question || fallback.resolvedQuestion, 2200),
      intent: clean(data.intent || fallback.intent, 40),
      researchMode: clean(data.research_mode || fallback.researchMode, 50),
      candidateType: clean(data.candidate_type || fallback.candidateType, 50),
      facets,
      queries: unique(facets.map(f => f.primaryQuery), 4),
      planned: true,
      plannerModel: DIRECTOR_MODEL,
      plannerTransport: 'tool_call',
      plannerError: '',
    };
  } catch (error) {
    return { ...fallback, plannerTransport: 'deterministic-fallback', plannerError: clean(error?.name || error?.message || error, 120) || 'director_failed' };
  } finally {
    clearTimeout(timeout);
  }
}

function queryTerms(query) {
  const generic = new Set(['公式','最新','おすすめ','比較','価格','値段','販売','購入','中古','新品','情報','確認','site']);
  const raw = normalize(query).replace(/site:[^\s]+/g, ' ');
  const pieces = raw.replace(/[「」『』【】()[\]{}<>!?？。、,:：;；/\\|]+/g, ' ').split(/\s+/).filter(Boolean);
  const out = [];
  for (const piece of pieces) {
    if (piece.length >= 2 && !generic.has(piece)) out.push(piece);
    for (const p of piece.match(/[a-z]+[-]?[a-z0-9-]*\d+[a-z0-9-]*|[\p{Script=Han}]{2,}|[\p{Script=Katakana}ー]{3,}/giu) || []) {
      if (p.length >= 2 && !generic.has(p)) out.push(p.toLowerCase());
    }
  }
  return [...new Set(out)].slice(0, 12);
}

export function stageEvidence(query, result, stage = 'verification', sourceRole = 'reference') {
  const title = normalize(result?.title || '');
  const snippet = normalize(result?.snippet || result?.excerpt || '');
  const hay = `${title} ${snippet}`;
  const host = hostOf(result?.url || '');
  if (!hay.trim() || LOW_VALUE_HOST_RE.test(host)) return { relevant: false, score: 0, matched: [] };
  const terms = queryTerms(query);
  const matched = terms.filter(t => hay.includes(t));
  const model = MODEL_RE.exec(`${result?.title || ''} ${result?.snippet || ''}`)?.[0] || '';
  const requestedSite = String(query).match(/site:([^\s]+)/i)?.[1]?.toLowerCase() || '';
  const expectedOfficialHost = ['official_spec','official_support'].includes(sourceRole) ? officialDomainHint(query) : '';
  const expectedHost = requestedSite || expectedOfficialHost;
  const siteMatch = expectedHost && (host === expectedHost || host.endsWith(`.${expectedHost}`));
  let score = matched.length * 2 + (model ? 5 : 0) + (siteMatch ? 6 : 0);
  if (/official|公式|support|サポート/i.test(`${title} ${host}`)) score += 2;
  let relevant;
  if (stage === 'discovery') {
    // Discovery optimizes recall: one concrete model or one meaningful category hit is enough.
    relevant = Boolean(model) || matched.length >= 1 || siteMatch;
  } else {
    // Verification optimizes precision: exact model/site, or two independent query concepts.
    relevant = Boolean(siteMatch) || Boolean(model && terms.some(t => normalize(model).includes(t) || hay.includes(t))) || matched.length >= 2;
  }
  if (['official_spec','official_support'].includes(sourceRole) && expectedHost) relevant = relevant && Boolean(siteMatch);
  return { relevant, score, matched, model };
}

function filterStage(query, raw, stage, sourceRole, limit = 10) {
  return (raw || []).map(item => ({ item, gate: stageEvidence(query, item, stage, sourceRole) }))
    .filter(x => x.gate.relevant)
    .sort((a,b) => b.gate.score - a.gate.score)
    .slice(0, limit)
    .map(x => ({ ...x.item, probeEngine: SEARCH_V45_PROVIDER, probeQuery: query, queryGateScore: x.gate.score, queryGateMatched: x.gate.matched }));
}

async function searchOne(facet, deadline) {
  const remaining = deadline - Date.now();
  if (remaining < 350) return { results: [], diag: { engine: SEARCH_V45_PROVIDER, query: facet.primaryQuery, ok: false, count: 0, error: 'budget_exhausted', elapsedMs: 0 } };
  const timeoutMs = Math.max(500, Math.min(SEARCH_V45_QUERY_TIMEOUT_MS, remaining - 100));
  const started = Date.now();
  try {
    const raw = await searchBingRss(facet.primaryQuery, { limit: 12, timeoutMs });
    const results = filterStage(facet.primaryQuery, raw, facet.stage, facet.sourceRole, 10);
    return { results, diag: { engine: SEARCH_V45_PROVIDER, query: facet.primaryQuery, stage: facet.stage, sourceRole: facet.sourceRole, ok: results.length > 0, rawCount: raw.length, count: results.length, error: results.length ? '' : (raw.length ? 'stage_gate_rejected' : 'empty_results'), elapsedMs: Date.now()-started } };
  } catch (error) {
    return { results: [], diag: { engine: SEARCH_V45_PROVIDER, query: facet.primaryQuery, stage: facet.stage, sourceRole: facet.sourceRole, ok: false, count: 0, error: clean(error?.name || error?.message || error, 100), elapsedMs: Date.now()-started } };
  }
}

function extractCandidates(results, limit = 4) {
  const out = [], seen = new Set();
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
  for (const item of results || []) {
    const text = `${item?.title || ''} ${item?.snippet || item?.excerpt || ''}`;
    for (const re of patterns) for (const match of text.matchAll(re)) {
      const name = clean(match[0], 100); const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key); out.push({ name, type: 'product_model', evidence: clean(item?.title, 180) });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function verificationFacets(candidates, plan) {
  const out = [];
  for (const c of candidates.slice(0, 2)) {
    const domain = officialDomainHint(c.name);
    out.push({ id: `spec-${c.name}`, stage: 'verification', sourceRole: domain ? 'official_spec' : 'reference', primaryQuery: domain ? `${c.name} 仕様 site:${domain}` : `${c.name} 仕様` });
    if (plan.intent === 'shopping') out.push({ id: `price-${c.name}`, stage: 'verification', sourceRole: 'seller', primaryQuery: `${c.name} 中古 価格` });
  }
  return out.slice(0, 4);
}

async function enrichTop(results, deadline, limit = 2) {
  const targets = (results || []).slice(0, limit);
  if (!targets.length || deadline - Date.now() < 900) return results || [];
  const enriched = await Promise.all(targets.map(async item => {
    const remaining = deadline - Date.now();
    if (remaining < 400 || !/^https?:\/\//.test(item?.url || '')) return item;
    try {
      const r = await fetch(item.url, { redirect:'follow', headers:{ accept:'text/html,application/xhtml+xml', 'user-agent':'TalkSys/45 (+https://talksys.syouziroupc.workers.dev)', 'accept-language':'ja,en;q=0.7' }, signal: AbortSignal.timeout(Math.max(300, Math.min(1200, remaining-100))) });
      if (!r.ok || !/(?:text|html)/i.test(r.headers.get('content-type') || '')) return item;
      const html = (await r.text()).slice(0, 240000);
      const text = html.replace(/<script\b[\s\S]*?<\/script>/gi,' ').replace(/<style\b[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&amp;/g,' ').replace(/\s+/g,' ').trim().slice(0,2400);
      return text.length > 80 ? { ...item, excerpt: text, engine: `${item.engine || 'bing-rss'}+page` } : item;
    } catch { return item; }
  }));
  const map = new Map(enriched.map(x => [x.url, x]));
  return (results || []).map(x => map.get(x.url) || x);
}

function diversify(results, limit = SEARCH_V44_SOURCE_LIMIT) {
  const out = [], deferred = [], count = new Map();
  for (const item of dedupeSearchResults(results || [], 80)) {
    const h = hostOf(item?.url || '') || 'unknown'; const n = count.get(h) || 0;
    if (n < SEARCH_V44_MAX_PER_HOST) { count.set(h,n+1); out.push(item); } else deferred.push(item);
    if (out.length >= limit) return out.slice(0,limit);
  }
  return [...out, ...deferred].slice(0,limit);
}

export async function runDeepSearchV44(ai, text, history = [], signal, options = {}) {
  const startedAt = Date.now();
  const maxBudgetMs = Math.max(3500, Math.min(8000, Number(options.totalBudgetMs) || SEARCH_V45_TOTAL_BUDGET_MS));
  const deadline = startedAt + maxBudgetMs;
  const timings = {};
  const diagnostics = [];

  const p0 = Date.now();
  const plan = await directorPlan(ai, text, history, signal);
  timings.plannerMs = Date.now() - p0;

  let firstFacets = (plan.facets || []).filter(f => f.primaryQuery);
  if (plan.researchMode === 'discover_then_verify') firstFacets = firstFacets.filter(f => f.stage === 'discovery').slice(0,2);
  if (!firstFacets.length) firstFacets = (plan.queries || []).slice(0,2).map((q,i) => ({ id:`q${i+1}`, stage:'verification', sourceRole:'reference', primaryQuery:q }));
  firstFacets = firstFacets.slice(0,2);

  const r1 = Date.now();
  // A known manufacturer/model should not depend on a search index to discover
  // its own official page. Direct primary-source resolution runs beside the
  // single search index and never counts as a second search engine.
  const [first, directPrimary] = await Promise.all([
    Promise.all(firstFacets.map(f => searchOne(f, deadline))),
    fetchDirectPrimarySources(plan.resolvedQuestion, deadline),
  ]);
  diagnostics.push(...first.map(x => x.diag));
  let merged = [...(directPrimary.results || []), ...first.flatMap(x => x.results)];
  let candidates = plan.candidateType === 'product_model' ? extractCandidates(merged,4) : [];
  timings.round1Ms = Date.now() - r1;
  let rounds = 1;
  const allQueries = firstFacets.map(f => f.primaryQuery);

  if (plan.researchMode === 'local_discovery' && deadline - Date.now() > 1200) {
    const q = clean(plan.resolvedQuestion, 220);
    const t = Date.now();
    try {
      const local = await searchOpenStreetMapLocal(q, { timeoutMs: Math.min(1400, Math.max(500, deadline-Date.now()-100)) });
      merged.push(...local.map(x => ({ ...x, probeQuery:q, probeEngine:'openstreetmap-direct' })));
    } catch {}
    timings.localMs = Date.now()-t;
  }

  if (plan.researchMode === 'discover_then_verify' && candidates.length && deadline - Date.now() > 1000) {
    const vf = verificationFacets(candidates, plan).slice(0,2);
    const t = Date.now();
    const second = await Promise.all(vf.map(f => searchOne(f, deadline)));
    diagnostics.push(...second.map(x => x.diag));
    merged.push(...second.flatMap(x => x.results));
    allQueries.push(...vf.map(f => f.primaryQuery));
    timings.round2Ms = Date.now()-t;
    rounds = 2;
  }

  let ranked = diversify(merged, SEARCH_V44_SOURCE_LIMIT);
  ranked = await enrichTop(ranked, deadline, 2);
  const hostCount = new Set(ranked.map(x => hostOf(x?.url)).filter(Boolean)).size;
  const baseEvidenceUseful = ranked.length >= 2 || (ranked.length === 1 && ranked[0].queryGateScore >= 6);
  const requiresCurrentFirmwareVersion = /(最新|現在).*(BIOS|UEFI|ファームウェア)|(?:BIOS|UEFI|ファームウェア).*(最新|現在)/i.test(plan.resolvedQuestion);
  const hasCurrentFirmwareVersionEvidence = ranked.some((item) => {
    const body = `${item?.title || ''} ${item?.excerpt || item?.snippet || ''}`;
    const official = item?.primarySource === true || ['official_spec','official_support'].includes(item?.sourceRole);
    return official && /(?:version|ver\.?|バージョン|BIOS)\s*[:：v]?\s*[a-z]?\d+(?:[.\-][a-z0-9]+)+/i.test(body);
  });
  const evidenceUseful = baseEvidenceUseful && (!requiresCurrentFirmwareVersion || hasCurrentFirmwareVersionEvidence);
  const sufficient = plan.researchMode === 'discover_then_verify'
    ? Boolean(candidates.length && evidenceUseful)
    : evidenceUseful;
  timings.totalMs = Date.now()-startedAt;

  return {
    revision: SEARCH_V44_REVISION,
    plannerPlanned: plan.planned === true,
    plannerTransport: plan.plannerTransport,
    plannerError: plan.plannerError || '',
    plan: { ...plan, queries: unique(allQueries, SEARCH_V44_MAX_TOTAL_QUERIES), candidates },
    rawResults: dedupeSearchResults(merged, 40),
    results: ranked,
    rounds,
    coverage: { sufficient, reason: sufficient ? 'staged_evidence_sufficient' : (ranked.length ? 'partial_evidence' : 'no_results'), missingFacets: sufficient ? [] : (plan.facets || []).map(f => f.id) },
    evidenceUseful,
    researchStateMachine: true,
    questionFirstPlanning: true,
    gapDrivenFollowups: false,
    sequentialDiscovery: plan.researchMode === 'discover_then_verify',
    researchMode: plan.researchMode,
    candidateType: plan.candidateType,
    candidateCount: candidates.length,
    candidateNames: candidates.map(x => x.name),
    queryResultGate: true,
    stageAwareGate: true,
    authorityAfterRelevance: true,
    singleSearchProvider: true,
    searchProvider: SEARCH_V45_PROVIDER,
    searchEngineRotation: false,
    subrequestBudgetAware: true,
    externalSubrequestBaseTarget: SEARCH_V44_EXTERNAL_SUBREQUEST_BASE_TARGET,
    externalSubrequestWorstTarget: SEARCH_V44_EXTERNAL_SUBREQUEST_WORST_TARGET,
    retryCount: 0,
    crossEngineCount: 0,
    hostCount,
    probeFailures: diagnostics.filter(x => !x.ok).length,
    probeDiagnostics: diagnostics,
    directPrimarySourceCount: (directPrimary.results || []).length,
    directPrimaryDiagnostics: directPrimary.diagnostics || [],
    directPrimaryTargets: (directPrimary.targets || []).map(x => ({ resolver: x.resolver, role: x.role, url: x.url, model: x.model })),
    requiresCurrentFirmwareVersion,
    hasCurrentFirmwareVersionEvidence,
    timings,
  };
}

export const __test = { inferIntent, simplePlan, officialDomainHint, queryTerms, extractCandidates };

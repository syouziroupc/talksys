import baseWorker from './worker-v43-finalcandidate.js';
import { runDeepSearchV44, SEARCH_V44_MAX_QUERIES, SEARCH_V44_MAX_ROUNDS, SEARCH_V44_SOURCE_LIMIT } from './search-v44.js';
import { persistTalkLog } from './log-v42.js';

const REVISION = 'talksys-v44-default-exhaustive-search';
const MODEL = '@cf/zai-org/glm-5.3-flash';

const TRIVIAL_RE = /^(?:もしもし|おはよう(?:ございます)?|こんにちは|こんばんは|ありがとう(?:ございます)?|ありがと|どうも|はい|うん|ううん|へえ|なるほど|そうなんだ|了解|わかった|分かった|OK|オーケー|じゃあね|またね)[。！!？?…\s]*$/i;
const FEELING_ONLY_RE = /^(?:今日は|今日も|今は|なんか|ちょっと|かなり|すごく|めっちゃ|もう)?\s*(?:疲れた|つかれた|眠い|ねむい|腹減った|お腹すいた|暇|しんどい|つらい|嬉しい|うれしい|悲しい|かなしい|楽しい|たのしい|元気)[。！!？?…〜ー\s]*$/i;
const MEMORY_ONLY_RE = /^(?:さっき|先ほど|前に|前の話|今の話|この会話).{0,30}(?:何|なんて|どう|覚えて|言った|話した|答えた)[。！!？?…\s]*$/i;
const CAPABILITY_RE = /(?:検索|調べ).{0,20}(?:できる|出来る|使える|あるの|あるだろ|できない|出来ない)|(?:できる|出来る|使える).{0,20}(?:検索|調べ)/i;
const WEATHER_RE = /(天気|天候|気温|降水|雨|晴|曇|雪|予報)/i;
const TRANSIT_RE = /(電車|鉄道|乗換|乗り換え|経路|行き方|何に乗|何を乗|所要時間|運賃|時刻表|次の電車|何時発)/i;
const PC_RE = /(パソコン|\bPC\b|ＰＣ|ノートパソコン|ノートPC|デスクトップ|Windows|MacBook|Chromebook)/i;
const PHONE_RE = /(スマホ|スマートフォン|携帯|Android|アンドロイド|iPhone|Xperia|Pixel|Galaxy|AQUOS|arrows|OPPO|Xiaomi|Redmi|motorola)/i;
const EXPLICIT_LOOKUP_RE = /(検索|調べ|探して|探せ|見つけ|在庫|実売|価格|値段|相場|いくら|どこで買|販売店|店舗|通販|具体的|おすすめ|最新|現在)/i;

function clean(value, max = 9000) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-talksys-revision': REVISION,
    },
  });
}

function wrap(response) {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  headers.set('x-talksys-revision', REVISION);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function historyOf(value) {
  return Array.isArray(value)
    ? value.slice(-18).map((x) => ({ role: x?.role === 'assistant' ? 'assistant' : 'user', content: clean(x?.content, 2000) })).filter((x) => x.content)
    : [];
}

function userHistory(value) {
  return historyOf(value).filter((x) => x.role === 'user');
}

function schedule(ctx, env, input) {
  const promise = persistTalkLog(env, { ...input, revision: REVISION });
  if (ctx?.waitUntil) ctx.waitUntil(promise);
  else promise.catch(() => {});
}

function readModelText(result) {
  if (typeof result === 'string') return clean(result, 9000);
  if (!result) return '';
  for (const value of [result.response, result.result, result.text, result.output_text]) {
    if (typeof value === 'string' && value.trim()) return clean(value, 9000);
  }
  const content = result.choices?.[0]?.message?.content;
  if (typeof content === 'string') return clean(content, 9000);
  if (Array.isArray(content)) return clean(content.map((x) => typeof x === 'string' ? x : (x?.text || x?.content || '')).join(' '), 9000);
  return clean(result.choices?.[0]?.text || '', 9000);
}

export function shouldSearchByDefault(text) {
  const value = clean(text, 1800);
  if (!value) return false;
  if (TRIVIAL_RE.test(value) || FEELING_ONLY_RE.test(value) || MEMORY_ONLY_RE.test(value) || CAPABILITY_RE.test(value)) return false;
  return true;
}

function shouldPreserveSpecializedTurn(text, history = []) {
  const userContext = clean(`${userHistory(history).map((x) => x.content).join(' ')} ${text}`, 6500);
  if (WEATHER_RE.test(userContext) || TRANSIT_RE.test(userContext)) return true;
  if (PC_RE.test(userContext) && EXPLICIT_LOOKUP_RE.test(text)) return true;
  if (PHONE_RE.test(userContext) && EXPLICIT_LOOKUP_RE.test(text)) return true;
  return false;
}

function fallbackResolvedQuestion(text, history = []) {
  const value = clean(text, 1800);
  if (value.length >= 42) return value;
  const users = userHistory(history).map((x) => clean(x.content, 700)).slice(-4);
  return clean(`${users.join(' ')} ${value}`, 2200) || value;
}

function deepPlan(text, history = []) {
  const resolvedQuestion = fallbackResolvedQuestion(text, history);
  return {
    ok: true,
    search: true,
    topic: clean(resolvedQuestion, 90),
    resolvedQuestion,
    searchInstruction: 'Web検索を既定で全面利用する。複数の検索語、一次情報、独立した別ソース、ページ本文、比較・反証を使い、根拠が不足すれば検索語を変えて最大3ラウンドまで追加調査する。現在性がある情報は新しい一次情報を優先する。',
    ack: '詳しく調べます。少し時間かかります。',
    planner: 'deep-search-v44',
    plannerMs: 0,
    searchMode: 'exhaustive-default',
  };
}

function evidenceBlock(search) {
  return (search?.results || []).slice(0, SEARCH_V44_SOURCE_LIMIT).map((x, i) => {
    return `[${i + 1}] ${clean(x?.title, 220)}\n${clean(x?.url, 700)}\n${clean(x?.excerpt || x?.snippet, 1600)}`;
  }).join('\n\n');
}

const GROUNDED_PROMPT = `あなたはTalkSysの日本語電話相談AIです。今回のターンではWebを深掘り検索済みです。\n\n絶対ルール:\n- まず利用者の質問へ直接答える。検索手順の説明から始めない。\n- 現在の価格、在庫、日時、時刻、法律、制度、人物、ニュース、現行仕様など変化し得る事実は取得根拠にある範囲だけ使う。\n- 重要な具体的事実は、可能なら公式・一次情報と独立した別ソースの一致を優先する。根拠が食い違う場合は断定しない。\n- assistantの過去発言は会話対象の復元には使えるが、外部事実の証拠にはしない。\n- 安定した一般知識、論理、利用者自身が述べた条件は補助的に使ってよい。\n- 根拠が一部足りなくても回答全体を拒否しない。確認できたことと未確認部分を分けて、役立つ結論まで進める。\n- 「自分で検索してください」「ホームページを確認してください」と調査を利用者へ押し戻さない。\n- 根拠にない店名、価格、住所、型番、数値を新しく作らない。\n- 電話で聞きやすい自然な日本語で、通常3〜6文。URLや検索回数は読み上げない。`;

async function synthesizeGroundedAnswer(env, body, search) {
  const hist = historyOf(body?.history).slice(-10);
  const resolved = clean(search?.plan?.resolvedQuestion || body?.text, 2200);
  const evidence = evidenceBlock(search);
  const coverage = search?.coverage || {};
  const prompt = `利用者の質問: ${clean(body?.text, 1800)}\n解決した調査課題: ${resolved}\n検索の十分性: ${coverage.sufficient === true ? '十分と判定' : '不足の可能性あり'} ${clean(coverage.reason, 260)}\n\n取得根拠:\n${evidence || '(直接使えるWeb根拠は取得できなかった)'}\n\n上のルールに従って利用者へ直接答えてください。`;
  const started = Date.now();
  const result = await env.AI.run(MODEL, {
    messages: [{ role: 'system', content: GROUNDED_PROMPT }, ...hist, { role: 'user', content: prompt }],
    stream: false,
    modalities: ['text'],
    max_completion_tokens: 620,
    temperature: 0.05,
    reasoning_effort: 'low',
  });
  const text = readModelText(result);
  if (!text) throw new Error('empty grounded answer');
  return { text, ms: Date.now() - started };
}

async function deepTurn(body, env, requestSignal) {
  const started = Date.now();
  const history = historyOf(body?.history);
  const text = clean(body?.text, 1800);
  const searchStarted = Date.now();
  const search = await runDeepSearchV44(env.AI, text, history, requestSignal);
  const searchMs = Date.now() - searchStarted;
  const answer = await synthesizeGroundedAnswer(env, body, search);
  const sources = (search.results || []).slice(0, SEARCH_V44_SOURCE_LIMIT).map((x) => ({
    title: clean(x?.title, 220),
    url: clean(x?.url, 700),
    engine: clean(x?.engine, 80),
  }));
  return {
    ok: true,
    answer: answer.text,
    search: true,
    route: 'deep-search-v44',
    searchUseful: Boolean(search.evidenceUseful),
    resolvedQuestion: search.plan?.resolvedQuestion || text,
    queries: (search.plan?.queries || []).slice(0, 24),
    sources,
    searchPasses: Number(search.rounds) || 1,
    maxSearchPasses: SEARCH_V44_MAX_ROUNDS,
    searchCoverage: search.coverage || null,
    sourceQuality: 'multi-engine-page-enriched-coverage-audited-v44',
    searchMode: 'exhaustive-default',
    historyPolicy: 'assistant-context-not-evidence',
    timings: { totalMs: Date.now() - started, searchMs, glmMs: answer.ms, ...(search.timings || {}) },
    model: MODEL,
    planner: 'deep-search-v44',
    languageMode: 'ja-only',
  };
}

async function parseJsonClone(response) {
  try {
    if (!(response.headers.get('content-type') || '').includes('application/json')) return null;
    return await response.clone().json();
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/voice-health') {
      const response = await baseWorker.fetch(request, env, ctx);
      const data = await parseJsonClone(response);
      if (!data) return wrap(response);
      return json({
        ...data,
        revision: REVISION,
        voiceRevision: REVISION,
        webSearch: true,
        webSearchPolicy: 'default-exhaustive-multi-round-v44',
        searchDefault: 'all-substantive-turns',
        searchMaxQueries: SEARCH_V44_MAX_QUERIES,
        searchMaxRounds: SEARCH_V44_MAX_ROUNDS,
        searchSourceLimit: SEARCH_V44_SOURCE_LIMIT,
        searchPageEnrichment: true,
        searchCoverageAudit: true,
        searchIndependentSources: true,
        specializedSearchRoutesPreserved: true,
      }, response.status);
    }

    if (request.method === 'POST' && url.pathname === '/api/plan') {
      let body;
      try { body = await request.clone().json(); } catch { return json({ ok: false, error: 'invalid json' }, 400); }
      const text = clean(body?.text, 1800);
      const history = historyOf(body?.history);
      if (!text) return json({ ok: false, error: 'text required' }, 400);

      const baseResponse = await baseWorker.fetch(request.clone(), env, ctx);
      const baseData = await parseJsonClone(baseResponse);
      if (baseData?.search === true) return wrap(baseResponse);
      if (!shouldSearchByDefault(text)) return wrap(baseResponse);

      const data = deepPlan(text, history);
      schedule(ctx, env, { request, body, result: data, event: 'plan', status: 200 });
      return json(data);
    }

    if (request.method === 'POST' && url.pathname === '/api/turn') {
      let body;
      try { body = await request.clone().json(); } catch { return json({ ok: false, error: 'invalid json' }, 400); }
      const text = clean(body?.text, 1800);
      const history = historyOf(body?.history);
      if (!text) return json({ ok: false, error: 'text required' }, 400);

      const planner = clean(body?.searchPlan?.planner, 100);
      if (planner && planner !== 'deep-search-v44') return wrap(await baseWorker.fetch(request, env, ctx));
      if (shouldPreserveSpecializedTurn(text, history)) return wrap(await baseWorker.fetch(request, env, ctx));
      if (!planner && !shouldSearchByDefault(text)) return wrap(await baseWorker.fetch(request, env, ctx));

      try {
        const data = await deepTurn(body, env, request.signal);
        schedule(ctx, env, { request, body, result: data, event: 'turn', status: 200 });
        return json(data);
      } catch (error) {
        const fallback = await baseWorker.fetch(request.clone(), env, ctx);
        const fallbackData = await parseJsonClone(fallback);
        if (fallbackData?.ok) {
          const data = {
            ...fallbackData,
            search: true,
            searchUseful: false,
            searchFallback: true,
            route: `deep-search-v44-fallback-${clean(fallbackData.route || 'base', 100)}`,
            deepSearchError: clean(error?.message || error, 280),
          };
          schedule(ctx, env, { request, body, result: data, event: 'turn-search-fallback', status: fallback.status });
          return json(data, fallback.status);
        }
        return wrap(fallback);
      }
    }

    return wrap(await baseWorker.fetch(request, env, ctx));
  },
};

export const __test = {
  shouldSearchByDefault,
  shouldPreserveSpecializedTurn,
  fallbackResolvedQuestion,
  deepPlan,
};

import {
  runDeepSearchV44,
  SEARCH_V44_EXTERNAL_SUBREQUEST_BASE_TARGET,
  SEARCH_V44_EXTERNAL_SUBREQUEST_WORST_TARGET,
  SEARCH_V44_MAX_ENGINE_RETRIES,
  SEARCH_V44_MAX_PER_HOST,
  SEARCH_V44_MAX_QUERIES,
  SEARCH_V44_MAX_RECOVERY_QUERIES,
  SEARCH_V44_MAX_ROUNDS,
  SEARCH_V44_MAX_TOTAL_QUERIES,
  SEARCH_V44_PROBE_CONCURRENCY,
  SEARCH_V44_REVISION,
  SEARCH_V44_SOURCE_LIMIT,
  SEARCH_V45_TOTAL_BUDGET_MS,
  SEARCH_V45_DIRECTOR_TIMEOUT_MS,
  SEARCH_V45_PROVIDER,
} from './search-v45.js';
import { persistTalkLog } from './log-v42.js';
import {
  detectApiIntents,
  FREE_API_REVISION,
  publicApiRegistry,
  runFreeApiTools,
} from './free-api-tools-v45.js';
import {
  detectKnowledgeApiIntents,
  mergeApiBundles,
  publicKnowledgeApiRegistry,
  runKnowledgeApiTools,
} from './free-api-knowledge-v45.js';

const REVISION = 'talksys-v45-api-first-single-search-provider';
const SEARCH_DIRECTOR_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';
const MODEL = '@cf/zai-org/glm-5.3-flash';
const MODEL_TIMEOUT_MS = 12000;

const TRIVIAL_RE = /^(?:もしもし|おはよう(?:ございます)?|こんにちは|こんばんは|ありがとう(?:ございます)?|ありがと|どうも|はい|うん|ううん|へえ|なるほど|そうなんだ|了解|わかった|分かった|OK|オーケー|じゃあね|またね)[。！!？?…\s]*$/i;
const FEELING_ONLY_RE = /^(?:今日は|今日も|今は|なんか|ちょっと|かなり|すごく|めっちゃ|もう)?\s*(?:疲れた|つかれた|眠い|ねむい|腹減った|お腹すいた|暇|しんどい|つらい|嬉しい|うれしい|悲しい|かなしい|楽しい|たのしい|元気|だるい)[。！!？?…〜ー\s]*$/i;
const MEMORY_ONLY_RE = /^(?:さっき|先ほど|前に|前の話|今の話|この会話|今まで).{0,40}(?:何|なんて|どう|覚えて|言った|話した|答えた).{0,40}[。！!？?…\s]*$/i;
const SUBJECTIVE_RE = /(バナナ.{0,12}おやつ.{0,8}入る|どう思う|どうおもう|どっちが好み|好き(?:です|なの|か)?|嫌い(?:です|なの|か)?)/i;
const CAPABILITY_RE = /(?:検索|調べ).{0,20}(?:できる|出来る|使える|あるの|あるだろ|できない|出来ない)|(?:できる|出来る|使える).{0,20}(?:検索|調べ)/i;
const NO_EXTERNAL_RE = /(?:(?:web|ウェブ)?\s*検索(?:は|を)?\s*(?:使わない(?:で)?|しない(?:で)?|禁止|なし)|外部(?:アクセス|接続|検索)(?:は|を)?\s*(?:禁止|しない(?:で)?|使わない(?:で)?)|調べ(?:ないで|なくていい))/i;
const EXPLICIT_LOOKUP_RE = /(検索|調べ|探して|探せ|見つけ|確認して|在庫|実売|価格|値段|相場|いくら|どこで買|販売店|店舗|通販|おすすめ|何がいい|どれがいい|買い替え)/i;
const DYNAMIC_FACT_RE = /(最新|現在|今(?:の|この|すぐ|何時|いくら)|今日|明日|昨日|価格|値段|相場|在庫|発売|販売中|BIOS|UEFI|ファームウェア|ドライバ|法律|法令|制度|社長|CEO|首相|大統領|ニュース|運行|遅延|運休|時刻表|天気|天候|為替|地震|祝日|中古(?:PC|パソコン|ノート|スマホ)|営業時間|バージョン)/i;
const NON_API_FACT_RE = /(BIOS|UEFI|ファームウェア|ドライバ|Windows|macOS|Linux|古物|法律|法令|社長|CEO|首相|大統領|ニュース|中古(?:PC|パソコン)|スマホ|型番|仕様|公式配布|配布元)/i;

function clean(value, max = 9000) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function canonicalizeInput(value, max = 9000) {
  return clean(String(value ?? '').normalize('NFKC'), max)
    .replace(/べっぷ(?=市|の|[、,。\s]|$)/gi, '別府')
    .replace(/きょう/gi, '今日')
    .replace(/あした/gi, '明日')
    .replace(/あさって/gi, '明後日')
    .replace(/[‐‑‒–—―]/g, '-');
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
    ? value.slice(-18).map((x) => ({
        role: x?.role === 'assistant' ? 'assistant' : 'user',
        content: canonicalizeInput(x?.content, 2000),
      })).filter((x) => x.content)
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

function formatNumber(value) {
  if (!Number.isFinite(value)) return '';
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 1e8) / 1e8);
}

function isLeapYear(year) {
  return year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
}

function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if ([4, 6, 9, 11].includes(month)) return 30;
  return 31;
}

export function localDeterministicAnswer(text) {
  const value = canonicalizeInput(text, 1800);

  let m = value.match(/2進数\s*([01]+).*?(?:10進数|十進数)/i);
  if (m) {
    const n = Number.parseInt(m[1], 2);
    return { kind: 'binary', answer: `2進数${m[1]}は10進数で${n}です。` };
  }

  m = value.match(/([\d,]+(?:\.\d+)?)\s*円(?:を|の)?\s*(\d+(?:\.\d+)?)\s*%\s*引き/i);
  if (m) {
    const price = Number(m[1].replace(/,/g, ''));
    const pct = Number(m[2]);
    if (Number.isFinite(price) && Number.isFinite(pct) && pct >= 0 && pct <= 100) {
      const result = price * (1 - pct / 100);
      return { kind: 'discount', answer: `${m[1]}円の${formatNumber(pct)}%引きは${Math.round(result).toLocaleString('ja-JP')}円です。` };
    }
  }

  m = value.match(/華氏\s*(-?\d+(?:\.\d+)?)\s*度.*?(?:摂氏|何度)/i);
  if (m) {
    const f = Number(m[1]);
    const c = (f - 32) * 5 / 9;
    return { kind: 'temperature', answer: `華氏${formatNumber(f)}度は摂氏${formatNumber(c)}度です。` };
  }

  m = value.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日.*?(?:存在|ある|実在)/);
  if (m) {
    const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
    const exists = month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
    return {
      kind: 'date',
      answer: exists
        ? `${year}年${month}月${day}日は存在します。`
        : `${year}年${month}月${day}日は存在しません。${month === 2 && day === 29 ? `${year}年は${isLeapYear(year) ? 'うるう年です' : 'うるう年ではありません'}。` : ''}`,
    };
  }

  m = value.match(/(-?\d+(?:\.\d+)?)\s*(÷|\/|×|\*|\+|-)\s*(-?\d+(?:\.\d+)?)/);
  if (m) {
    const a = Number(m[1]), b = Number(m[3]), op = m[2];
    if (op === '÷' || op === '/') {
      if (b === 0) return { kind: 'arithmetic', answer: '0で割ることはできません。' };
      return { kind: 'arithmetic', answer: `${m[1]}${op}${m[3]}は${formatNumber(a / b)}です。` };
    }
    if (op === '×' || op === '*') return { kind: 'arithmetic', answer: `${m[1]}${op}${m[3]}は${formatNumber(a * b)}です。` };
    if (op === '+') return { kind: 'arithmetic', answer: `${m[1]}+${m[3]}は${formatNumber(a + b)}です。` };
    if (op === '-') return { kind: 'arithmetic', answer: `${m[1]}-${m[3]}は${formatNumber(a - b)}です。` };
  }

  return null;
}

function ambiguousLocation(text) {
  const value = canonicalizeInput(text, 1800);
  if (!/中央区/.test(value)) return false;
  return !/(東京都|東京23区|大阪市|大阪府|札幌市|札幌|神戸市|神戸|福岡市|福岡県|千葉市|さいたま市|相模原市|新潟市|浜松市|熊本市)/.test(value);
}

export function classifyTurn(text, history = []) {
  const value = canonicalizeInput(text, 1800);
  const hist = historyOf(history);
  const noExternal = NO_EXTERNAL_RE.test(value);
  const deterministic = localDeterministicAnswer(value);
  if (deterministic) return { mode: 'deterministic', webSearch: false, noExternal, deterministic, reason: 'local_deterministic' };
  if (/^[+-]?\d+(?:\.\d+)?$/.test(value)) return { mode: 'clarify', webSearch: false, noExternal, reason: 'bare_number' };
  if (ambiguousLocation(value)) return { mode: 'clarify', webSearch: false, noExternal, reason: 'ambiguous_location' };
  if (noExternal) return { mode: 'casual', webSearch: false, noExternal: true, reason: 'user_disabled_external_lookup' };
  if (TRIVIAL_RE.test(value) || FEELING_ONLY_RE.test(value) || MEMORY_ONLY_RE.test(value) || SUBJECTIVE_RE.test(value) || CAPABILITY_RE.test(value)) {
    return { mode: 'casual', webSearch: false, noExternal: false, reason: 'conversation_local' };
  }
  const apiIntents = [...new Set([...detectApiIntents(value, hist), ...detectKnowledgeApiIntents(value, hist)])];
  if (apiIntents.length) return { mode: 'external', webSearch: false, noExternal: false, apiIntents, reason: 'structured_api_intent' };
  if (EXPLICIT_LOOKUP_RE.test(value) || DYNAMIC_FACT_RE.test(value)) {
    return { mode: 'external', webSearch: true, noExternal: false, apiIntents: [], reason: 'current_or_explicit_lookup' };
  }
  return { mode: 'casual', webSearch: false, noExternal: false, reason: 'stable_or_conversational' };
}

export function shouldSearchByDefault(text, history = []) {
  const decision = classifyTurn(text, history);
  return decision.mode === 'external' && decision.webSearch === true;
}

function shouldPreserveSpecializedTurn() {
  return false;
}

function fallbackResolvedQuestion(text, history = []) {
  const value = canonicalizeInput(text, 1800);
  if (value.length >= 42) return value;
  const users = userHistory(history).map((x) => canonicalizeInput(x.content, 700)).slice(-4);
  return clean(`${users.join(' ')} ${value}`, 2200) || value;
}

function structuredCoverageIsWholeQuestion(text, bundle) {
  if (bundle?.sufficient !== true) return false;
  const value = canonicalizeInput(text, 2200);
  const clauses = value
    .split(/(?:と[、,]?(?=[A-Za-z0-9一-龠ぁ-んァ-ヶ])|そして|それから|加えて|。|；|;)/)
    .map((x) => clean(x, 1000))
    .filter((x) => x.length >= 2);
  const recognized = (clause) => [
    ...detectApiIntents(clause, []),
    ...detectKnowledgeApiIntents(clause, []),
  ].length > 0;
  if (clauses.length > 1) return clauses.every(recognized);
  if (!recognized(value)) return false;
  return !NON_API_FACT_RE.test(value);
}

function localPlan(text, decision, history = []) {
  return {
    ok: true,
    search: false,
    externalLookup: false,
    topic: clean(text, 90),
    resolvedQuestion: fallbackResolvedQuestion(text, history),
    searchInstruction: '',
    ack: '',
    planner: 'unified-router-v45',
    plannerMs: 0,
    searchMode: decision.mode,
    routeReason: decision.reason,
  };
}

function deepPlan(text, history = [], decision = { webSearch: true }) {
  const resolvedQuestion = fallbackResolvedQuestion(text, history);
  return {
    ok: true,
    search: decision.webSearch === true,
    externalLookup: true,
    topic: clean(resolvedQuestion, 90),
    resolvedQuestion,
    searchInstruction: '構造化APIを先に使い、Webが必要な場合だけ複数検索語・一次情報・独立ソースで検証する。根拠が足りない場合だけ追加検索する。',
    ack: '確認します。',
    planner: 'unified-router-v45',
    plannerMs: 0,
    searchMode: decision.webSearch ? 'web-research' : 'structured-api-first',
    routeReason: decision.reason,
  };
}

function evidenceBlock(search) {
  return (search?.results || []).slice(0, SEARCH_V44_SOURCE_LIMIT).map((x, i) => {
    return `[${i + 1}] ${clean(x?.title, 220)}\n${clean(x?.url, 700)}\n${clean(x?.excerpt || x?.snippet, 1600)}`;
  }).join('\n\n');
}

const CASUAL_PROMPT = `あなたはTalkSysの日本語電話相談AIです。
- 今回は外部検索結果を使っていない。安定した一般知識、論理、会話履歴だけで答える。
- 現在の価格、在庫、時刻、ニュース、現行制度など変化し得る事実を、確認したふりをして断定しない。
- 利用者が検索禁止・外部アクセス禁止を指定した場合は必ず守る。
- まず質問へ直接答える。通常2〜4文。不要な前置き、URL、Markdownは避ける。
- 会話履歴の内容は会話対象の復元に使ってよい。
- 分からない対象を勝手に具体化しない。`;

const GROUNDED_PROMPT = `あなたはTalkSysの日本語電話相談AIです。今回のターンでは構造化APIを優先し、必要な場合だけWebも調査済みです。
絶対ルール:
- まず利用者の質問へ直接答える。検索手順の説明から始めない。
- 構造化APIで取得できた項目はAPI根拠を優先する。
- 現在の価格、在庫、日時、時刻、法律、制度、人物、ニュース、現行仕様など変化し得る事実は取得根拠にある範囲だけ使う。
- assistantの過去発言は外部事実の証拠にしない。
- 根拠が一部足りなくても、確認できたことと未確認部分を分ける。
- 「もう一度聞いて」「後で確認」「自分で検索して」と調査を利用者へ押し戻さない。
- 根拠にない店名、価格、住所、型番、数値を作らない。
- 電話で聞きやすい自然な日本語で通常3〜6文。URLや検索回数は読み上げない。`;

export async function boundedPromise(promise, timeoutMs, label = 'operation') {
  const ms = Math.max(1, Number(timeoutMs) || 1);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runModel(env, messages, max = 520, temperature = 0.08, timeoutMs = MODEL_TIMEOUT_MS) {
  const started = Date.now();
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(new Error('model_timeout')), timeoutMs);
  try {
    const result = await boundedPromise(env.AI.run(MODEL, {
      messages,
      stream: false,
      modalities: ['text'],
      max_completion_tokens: max,
      temperature,
      reasoning_effort: 'low',
    }, { signal: controller.signal }), timeoutMs + 250, 'model');
    const text = readModelText(result);
    if (!text) throw new Error('empty model answer');
    return { text, ms: Date.now() - started };
  } finally {
    clearTimeout(abortTimer);
  }
}

async function casualTurn(body, env, { fallbackError = '' } = {}) {
  const started = Date.now();
  const text = canonicalizeInput(body?.text, 1800);
  const history = historyOf(body?.history).slice(-10);
  const extra = fallbackError
    ? '\n外部調査処理は失敗した。現在情報を捏造せず、安定した一般知識で役立つ範囲だけ答え、再試行を利用者へ要求しない。'
    : '';
  try {
    const answer = await runModel(env, [
      { role: 'system', content: CASUAL_PROMPT + extra },
      ...history,
      { role: 'user', content: text },
    ], 420, 0.16);
    return {
      ok: true,
      answer: answer.text,
      search: Boolean(fallbackError),
      searchUseful: false,
      searchFallback: Boolean(fallbackError),
      route: fallbackError ? 'research-fallback-local-v45' : 'local-conversation-v45',
      resolvedQuestion: fallbackResolvedQuestion(text, history),
      queries: [],
      sources: [],
      timings: { totalMs: Date.now() - started, glmMs: answer.ms },
      model: MODEL,
      planner: 'unified-router-v45',
      languageMode: 'ja-only',
      ...(fallbackError ? { deepSearchError: clean(fallbackError, 280) } : {}),
    };
  } catch (error) {
    return {
      ok: true,
      answer: fallbackError
        ? '外部情報の取得と回答生成の両方に失敗したため、現在情報は断定しません。'
        : '回答生成に失敗しました。検索は行っていません。',
      search: Boolean(fallbackError),
      searchUseful: false,
      searchFallback: Boolean(fallbackError),
      route: 'local-mechanical-fallback-v45',
      resolvedQuestion: text,
      queries: [],
      sources: [],
      timings: { totalMs: Date.now() - started, glmMs: 0 },
      model: 'mechanical-guard',
      planner: 'unified-router-v45',
      languageMode: 'ja-only',
      localError: clean(error?.message || error, 220),
    };
  }
}

function deterministicTurn(body, decision) {
  const answer = decision.deterministic?.answer || '';
  return {
    ok: true,
    answer,
    search: false,
    searchUseful: false,
    route: 'deterministic-v45',
    resolvedQuestion: canonicalizeInput(body?.text, 1800),
    queries: [],
    sources: [],
    timings: { totalMs: 0, glmMs: 0 },
    model: 'local-deterministic',
    planner: 'unified-router-v45',
    languageMode: 'ja-only',
    deterministicKind: decision.deterministic?.kind || '',
  };
}

function clarificationTurn(body, decision) {
  const text = canonicalizeInput(body?.text, 1800);
  const answer = decision.reason === 'bare_number'
    ? `「${text}」だけでは何について知りたいのか特定できません。単位や対象を一言足してください。`
    : '「中央区」は複数の都市にあります。東京都中央区、大阪市中央区など、どの中央区か教えてください。';
  return {
    ok: true,
    answer,
    search: false,
    searchUseful: false,
    route: 'clarification-v45',
    clarificationRequired: true,
    resolvedQuestion: text,
    queries: [],
    sources: [],
    timings: { totalMs: 0, glmMs: 0 },
    model: 'local-clarifier',
    planner: 'unified-router-v45',
    languageMode: 'ja-only',
  };
}

function evidenceNumber(value, maximumFractionDigits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return clean(value, 80);
  return new Intl.NumberFormat('ja-JP', { maximumFractionDigits }).format(n);
}

export function mechanicalGroundedAnswer(apiResults = [], search = {}, question = '') {
  const ok = (apiResults || []).filter((x) => x?.ok);
  for (const item of ok) {
    const data = item?.data || {};
    if (item.tool === 'world_bank_wdi' && data.latest) {
      const x = data.latest;
      const labels = {
        'NY.GDP.PCAP.CD': '一人当たりGDP',
        'NY.GDP.MKTP.CD': 'GDP',
        'SP.POP.TOTL': '人口',
        'SL.UEM.TOTL.ZS': '失業率',
        'FP.CPI.TOTL.ZG': 'インフレ率',
        'SP.DYN.LE00.IN': '平均寿命',
        'SP.DYN.TFRT.IN': '合計特殊出生率',
      };
      const units = {
        'NY.GDP.PCAP.CD': '米ドル',
        'NY.GDP.MKTP.CD': '米ドル',
        'SP.POP.TOTL': '人',
        'SL.UEM.TOTL.ZS': '%',
        'FP.CPI.TOTL.ZG': '%',
        'SP.DYN.LE00.IN': '年',
      };
      const label = labels[x.indicatorCode] || clean(x.indicator, 100) || '値';
      const unit = clean(x.unit, 40) || units[x.indicatorCode] || '';
      return `${clean(x.year, 20)}年の${clean(x.country, 100) || clean(x.countryCode, 20)}の${label}は${evidenceNumber(x.value)}${unit}です。${clean(item.attribution, 180) || 'World Bank Open Data'}`;
    }
    if (item.tool === 'frankfurter' && Number.isFinite(Number(data.converted))) {
      return `${clean(data.date, 30)}のレートでは、${evidenceNumber(data.amount, 4)} ${clean(data.base, 10)}は${evidenceNumber(data.converted, 4)} ${clean(data.quote, 10)}です。1 ${clean(data.base, 10)}=${evidenceNumber(data.rate, 6)} ${clean(data.quote, 10)}です。${clean(item.attribution, 180)}`;
    }
    if (item.tool === 'jma_weather' && Array.isArray(data.periods) && data.periods.length) {
      const first = data.periods[0] || {};
      const pop = Array.isArray(data.precipitation) ? data.precipitation.find((x) => clean(x?.probabilityPercent, 10)) : null;
      const temp = Array.isArray(data.temperatures) ? data.temperatures.find((x) => clean(x?.celsius, 10)) : null;
      const extras = [pop ? `降水確率${clean(pop.probabilityPercent, 10)}%` : '', temp ? `気温${clean(temp.celsius, 10)}度` : ''].filter(Boolean).join('、');
      return `気象庁の取得データでは、${clean(data.targetArea, 100) || '対象地域'}の予報は「${clean(first.weather, 220)}」です。${extras ? `${extras}です。` : ''}${clean(item.attribution, 180)}`;
    }
    if (item.tool === 'nager_holidays' && Array.isArray(data.holidays) && data.holidays.length) {
      const named = data.holidays.find((x) => clean(question, 800).includes(clean(x?.localName, 120))) || data.holidays[0];
      return `${clean(named.localName || named.name, 160)}は${clean(named.date, 30)}です。${clean(item.attribution, 180)}`;
    }
    if (item.tool === 'crossref' && Array.isArray(data.works) && data.works.length) {
      const work = data.works[0];
      return `Crossrefで確認できた先頭の文献は「${clean(work.title, 400)}」です。${work.doi ? `DOIは${clean(work.doi, 180)}です。` : ''}${clean(item.attribution, 180)}`;
    }
  }
  if (ok.length) {
    const item = ok[0];
    return `構造化APIから根拠は取得できました。取得値は ${clean(JSON.stringify(item.data ?? {}), 1200)}。${clean(item.attribution, 180)}`;
  }
  const web = (search?.results || []).filter((x) => !x?.structuredApi).slice(0, 3);
  if (web.length) {
    const facts = web.map((x) => `${clean(x?.title, 180)}: ${clean(x?.excerpt || x?.snippet, 420)}`).filter(Boolean).join(' / ');
    return `回答生成がタイムアウトしたため、取得済みのWeb根拠だけを返します。${facts}`;
  }
  return '外部情報を取得できなかったため、現在情報は断定しません。';
}

function researchFailureTurn(body, error) {
  const text = canonicalizeInput(body?.text, 1800);
  return {
    ok: true,
    answer: '外部情報を取得できなかったため、現在情報は断定しません。',
    search: true,
    searchUseful: false,
    searchFallback: true,
    route: 'research-failure-v45',
    resolvedQuestion: text,
    queries: [],
    sources: [],
    timings: { totalMs: 0, glmMs: 0 },
    model: 'mechanical-guard',
    planner: 'unified-router-v45',
    languageMode: 'ja-only',
    researchError: clean(error?.message || error, 280),
  };
}

async function synthesizeGroundedAnswer(env, body, search) {
  const hist = historyOf(body?.history).slice(-10);
  const resolved = clean(search?.plan?.resolvedQuestion || body?.text, 2200);
  const evidence = evidenceBlock(search);
  const coverage = search?.coverage || {};
  const prompt = `利用者の質問: ${canonicalizeInput(body?.text, 1800)}
解決した調査課題: ${resolved}
検索の十分性: ${coverage.sufficient === true ? '十分と判定' : '不足の可能性あり'} ${clean(coverage.reason, 260)}

取得根拠:
${evidence || '(直接使える根拠は取得できなかった)'}

上のルールに従って利用者へ直接答えてください。`;
  return runModel(env, [{ role: 'system', content: GROUNDED_PROMPT }, ...hist, { role: 'user', content: prompt }], 620, 0.05);
}

async function deepTurn(body, env, requestSignal, decision) {
  const started = Date.now();
  const history = historyOf(body?.history);
  const text = canonicalizeInput(body?.text, 1800);
  const normalizedBody = { ...body, text, history };

  const apiStarted = Date.now();
  const [coreApiBundle, knowledgeApiBundle] = await Promise.all([
    runFreeApiTools(text, history, env, requestSignal),
    runKnowledgeApiTools(text, history, requestSignal),
  ]);
  const apiBundle = mergeApiBundles(coreApiBundle, knowledgeApiBundle);
  const apiMs = Date.now() - apiStarted;
  const apiOk = (apiBundle?.results || []).filter((x) => x?.ok);

  const structuredEnough = apiBundle?.sufficient === true && structuredCoverageIsWholeQuestion(text, apiBundle);
  let webFallbackUsed = decision.webSearch === true || !structuredEnough;
  let search;
  let searchMs = 0;

  let webResearchError = '';
  if (webFallbackUsed) {
    const searchStarted = Date.now();
    try {
      search = await runDeepSearchV44(env.AI, text, history, requestSignal);
    } catch (error) {
      webResearchError = clean(error?.message || error, 240);
      // Retrieval failure is evidence absence, not an application exception.
      search = {
        revision: SEARCH_V44_REVISION,
        evidenceUseful: apiOk.length > 0,
        results: [],
        rounds: 0,
        coverage: {
          sufficient: apiOk.length > 0,
          reason: apiOk.length ? 'structured API evidence retained after web research failure' : 'web_retrieval_failed_no_evidence',
        },
        plan: { resolvedQuestion: text, queries: [], facets: [] },
        researchMode: apiOk.length ? 'api_retained_after_web_failure' : 'stable_only_after_web_failure',
        candidateType: 'none',
        queryResultGate: true,
        authorityAfterRelevance: true,
        subrequestBudgetAware: true,
      };
    }
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

  let answer;
  let answerSynthesisFallback = false;
  let answerSynthesisError = '';
  if (!apiOk.length && !search.evidenceUseful) {
    answerSynthesisFallback = true;
    answerSynthesisError = 'external_evidence_unavailable_stable_only';
    try {
      answer = await runModel(env, [
        { role: 'system', content: CASUAL_PROMPT + '\n今回の外部取得では十分な根拠が得られなかった。検索機能が無効・禁止・使えないとは絶対に説明しない。質問のうち、時間で変化しない一般的な判断基準・仕組み・注意点だけを具体的に答える。現在の価格、在庫、最新版、時刻、現行制度などは断定しない。現在情報が必要な部分は「今回の取得では確認できなかった」とだけ述べる。' },
        ...historyOf(normalizedBody?.history).slice(-8),
        { role: 'user', content: text },
      ], 420, 0.12, 6500);
      answer.text = clean(answer?.text, 9000)
        .replace(/外部検索を使わない設定(?:のため|なので)?[、,]?/g, '今回の外部取得では十分な根拠を確認できなかったため、')
        .replace(/検索機能(?:が|は)(?:無効|禁止|使えない)[^。]*。?/g, '今回の外部取得では十分な根拠を確認できませんでした。');
    } catch (error) {
      answerSynthesisError = clean(error?.message || error, 240);
      answer = { text: '外部の現在情報は確認できませんでした。一般論として回答できる部分も生成できなかったため、推測はしません。', ms: 0 };
    }
  } else {
    try {
      answer = await synthesizeGroundedAnswer(env, normalizedBody, search);
    } catch (error) {
      answerSynthesisFallback = true;
      answerSynthesisError = clean(error?.message || error, 240);
      answer = { text: mechanicalGroundedAnswer(apiOk, search, text), ms: 0 };
    }
  }
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
    answerSynthesisFallback,
    answerSynthesisError,
    webResearchError,
    search: webFallbackUsed,
    route: 'api-first-v45',
    searchUseful: Boolean(search.evidenceUseful),
    resolvedQuestion: search.plan?.resolvedQuestion || text,
    queries: (search.plan?.queries || []).slice(0, SEARCH_V44_MAX_TOTAL_QUERIES),
    sources,
    searchPasses: Number(search.rounds) || 0,
    maxSearchPasses: SEARCH_V44_MAX_ROUNDS,
    searchCoverage: search.coverage || null,
    sourceQuality: apiOk.length ? 'structured-api-priority-plus-web-v45' : 'single-provider-staged-evidence-v45',
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
      failures: (apiBundle?.results || []).filter((x) => !x?.ok).map((x) => ({
        tool: clean(x?.tool, 80),
        reason: clean(x?.reason, 160),
      })).slice(0, 8),
    },
    searchDiagnostics: {
      searchRevision: search.revision || SEARCH_V44_REVISION,
      searchDirectorModel: SEARCH_DIRECTOR_MODEL,
      plannerPlanned: search.plannerPlanned === true,
      plannerTransport: search.plannerTransport || '',
      plannerError: clean(search.plannerError || '', 180),
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
    planner: apiOk.length ? 'free-api-router-v45' : 'search-v45',
    languageMode: 'ja-only',
  };
}

async function fetchShell(request, env, ctx) {
  const { default: shellWorker } = await import('./worker.js');
  return shellWorker.fetch(request, env, ctx);
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
      const response = await fetchShell(request, env, ctx);
      const data = await parseJsonClone(response);
      if (!data) return wrap(response);
      return json({
        ...data,
        revision: REVISION,
        voiceRevision: REVISION,
        unifiedTurnRouter: true,
        legacyV43TurnDelegation: false,
        localDeterministic: true,
        modelTimeoutMs: MODEL_TIMEOUT_MS,
        modelTimeoutFallback: true,
        groundedEvidenceFallback: true,
        externalFailureUsesCasualModel: false,
        ambiguityGate: true,
        explicitNoExternalGuard: true,
        inputCanonicalization: 'NFKC+spoken-ja',
        webSearch: true,
        webSearchPolicy: 'intent-routed-api-first-v45',
        searchRevision: SEARCH_V44_REVISION,
        weatherDirect: 'jma-api-first-with-met-norway-fallback',
        apiFirst: true,
        apiParallel: true,
        freeApiRevision: FREE_API_REVISION,
        freeApiRegistry: { ...publicApiRegistry(), ...publicKnowledgeApiRegistry() },
        searchDirectorModel: SEARCH_DIRECTOR_MODEL,
        openMeteoExcluded: true,
        searchDefault: 'intent-routed-v45',
        searchMaxQueries: SEARCH_V44_MAX_QUERIES,
        searchMaxRecoveryQueries: SEARCH_V44_MAX_RECOVERY_QUERIES,
        searchMaxTotalQueries: SEARCH_V44_MAX_TOTAL_QUERIES,
        searchMaxRounds: SEARCH_V44_MAX_ROUNDS,
        searchSourceLimit: SEARCH_V44_SOURCE_LIMIT,
        searchQuestionFirstPlanning: true,
        searchGapDrivenFollowups: false,
        searchResearchStateMachine: true,
        searchSequentialDiscovery: true,
        searchQueryResultGate: true,
        searchAuthorityAfterRelevance: true,
        searchTypedResearchStrategy: true,
        searchSourceRoleAware: true,
        searchIndependentSources: true,
        searchEngineRotation: false,
        searchEngineRetry: false,
        searchMaxEngineRetries: SEARCH_V44_MAX_ENGINE_RETRIES,
        searchProvider: SEARCH_V45_PROVIDER,
        searchSingleProvider: true,
        searchStageAwareGate: true,
        searchTotalBudgetMs: SEARCH_V45_TOTAL_BUDGET_MS,
        searchDirectorTimeoutMs: SEARCH_V45_DIRECTOR_TIMEOUT_MS,
        searchHostDiversity: true,
        searchMaxPerHost: SEARCH_V44_MAX_PER_HOST,
        searchProbeConcurrency: SEARCH_V44_PROBE_CONCURRENCY,
        searchSubrequestBudgetAware: true,
        searchExternalSubrequestBaseTarget: SEARCH_V44_EXTERNAL_SUBREQUEST_BASE_TARGET,
        searchExternalSubrequestWorstTarget: SEARCH_V44_EXTERNAL_SUBREQUEST_WORST_TARGET,
        specializedSearchRoutesPreserved: false,
      }, response.status);
    }

    if (request.method === 'POST' && url.pathname === '/api/plan') {
      let body;
      try { body = await request.clone().json(); } catch { return json({ ok: false, error: 'invalid json' }, 400); }
      const text = canonicalizeInput(body?.text, 1800);
      const history = historyOf(body?.history);
      if (!text) return json({ ok: false, error: 'text required' }, 400);
      const decision = classifyTurn(text, history);
      const data = decision.mode === 'external' ? deepPlan(text, history, decision) : localPlan(text, decision, history);
      schedule(ctx, env, { request, body: { ...body, text }, result: data, event: 'plan', status: 200 });
      return json(data);
    }

    if (request.method === 'POST' && url.pathname === '/api/turn') {
      let body;
      try { body = await request.clone().json(); } catch { return json({ ok: false, error: 'invalid json' }, 400); }
      const text = canonicalizeInput(body?.text, 1800);
      const history = historyOf(body?.history);
      if (!text) return json({ ok: false, error: 'text required' }, 400);
      const normalizedBody = { ...body, text, history };
      const decision = classifyTurn(text, history);

      let data;
      if (decision.mode === 'deterministic') {
        data = deterministicTurn(normalizedBody, decision);
      } else if (decision.mode === 'clarify') {
        data = clarificationTurn(normalizedBody, decision);
      } else if (decision.mode === 'casual') {
        data = await casualTurn(normalizedBody, env);
      } else {
        try {
          data = await deepTurn(normalizedBody, env, request.signal, decision);
        } catch (error) {
          data = researchFailureTurn(normalizedBody, error);
        }
      }
      schedule(ctx, env, { request, body: normalizedBody, result: data, event: 'turn', status: 200 });
      return json(data);
    }

    return wrap(await fetchShell(request, env, ctx));
  },
};

export const __test = {
  canonicalizeInput,
  boundedPromise,
  mechanicalGroundedAnswer,
  classifyTurn,
  localDeterministicAnswer,
  shouldSearchByDefault,
  shouldPreserveSpecializedTurn,
  fallbackResolvedQuestion,
  structuredCoverageIsWholeQuestion,
  deepPlan,
};

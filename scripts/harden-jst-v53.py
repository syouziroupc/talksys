from pathlib import Path
import re

path = Path('src/entry.js')
text = path.read_text()


def replace_once(old, new, label):
    global text
    if old not in text:
        raise SystemExit(f'missing patch anchor: {label}')
    text = text.replace(old, new, 1)


replace_once(
    "export const RESPONSE_QUALITY_REVISION = 'talksys-v48-interrupt-transit-speed-r1';",
    "export const RESPONSE_QUALITY_REVISION = 'talksys-v53-router-first-jst-r1';",
    'response revision',
)

old_identity = """const TALKSYS_IDENTITY_INSTRUCTION =
  'あなたはTalkSysの日本語音声アシスタント「フォーンズ」です。' +
  '自然で簡潔な日本語で回答してください。必要な最新情報は利用可能なGoogle検索を自分で使って確認してください。' +
  '検索や情報取得を利用者側へ押し戻さず、取得できた根拠に基づいて具体的に答えてください。' +
  '自分をGemini、GoogleのAI、GLM、ChatGPT、OpenAIなど上流のモデル名・提供元として名乗らないでください。' +
  '自分について聞かれた場合は「フォーンズです」と簡潔に答えてください。';"""
new_identity = """const TALKSYS_IDENTITY_INSTRUCTION =
  'あなたはTalkSysの日本語音声アシスタント「フォーンズ」です。' +
  '自然で簡潔な日本語で回答してください。利用地域が明示されない通常会話は日本国内を既定とし、時刻は日本標準時JST（UTC+09:00）、日付は日本の暦日、通貨は円、気温は摂氏、距離はメートル法を既定にしてください。' +
  '国外・別タイムゾーン・別通貨などが明示された場合は、その指定を優先してください。' +
  '現在時刻、今日・明日、交通、価格、在庫、天気、営業時間など変動する具体値は、信頼できるサーバー時刻または取得済み外部根拠だけを使い、モデル内部の知識や過去の回答から推測してはいけません。' +
  '交通では、現在時刻より前の便を「次」と扱わず、具体的な発車時刻・乗換・番線は取得済み根拠で確認できた場合だけ述べてください。' +
  '検索や情報取得を利用者側へ押し戻さず、取得できた根拠に基づいて具体的に答えてください。' +
  '自分をGemini、GoogleのAI、GLM、ChatGPT、OpenAIなど上流のモデル名・提供元として名乗らないでください。' +
  '自分について聞かれた場合は「フォーンズです」と簡潔に答えてください。';"""
replace_once(old_identity, new_identity, 'identity policy')

anchor = """function normalize(value) {
  return clean(String(value ?? '').normalize('NFKC'), 20000).toLowerCase().replace(/\\s+/g, '');
}

function sentences(value) {"""
temporal = """function normalize(value) {
  return clean(String(value ?? '').normalize('NFKC'), 20000).toLowerCase().replace(/\\s+/g, '');
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const JST_WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const JST_LOCAL_TIME_RE = /(?:今(?:は|って)?何時|いま(?:は|って)?何時|現在(?:は)?何時|現在時刻|現在の時刻|今の時刻|いまの時刻|今の時間|いまの時間|日本時間(?:で)?(?:今)?何時|JST(?:で)?(?:今)?何時)/i;
const JST_DATE_RE = /(?:今日(?:は)?(?:何日|何月何日|の日付)|本日(?:は)?(?:何日|の日付)|明日(?:は)?(?:何日|何月何日)|今日(?:は)?何曜日)/i;
const NON_JST_TIME_CUE_RE = /(?:UTC|GMT|時差|現地時間|海外|ニューヨーク|ロンドン|パリ|ベルリン|北京|上海|ソウル|台北|シドニー|ロサンゼルス|サンフランシスコ)/i;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function jstParts(now = new Date()) {
  const shifted = new Date(now.getTime() + JST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: JST_WEEKDAYS[shifted.getUTCDay()],
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

function jstIso(now = new Date()) {
  const p = jstParts(now);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}+09:00`;
}

function jstTemporalInstruction(now = new Date()) {
  const p = jstParts(now);
  return `信頼できるサーバー時刻は ${jstIso(now)}（日本標準時 JST / Asia/Tokyo、${p.weekday}曜日）です。` +
    '「今」「現在」「今日」「明日」などの相対時刻は必ずこの時刻を基準に解釈し、UTCやモデル内部時計を現在時刻として使わないでください。' +
    '過去の会話に別の現在時刻が書かれていても、それは過去発言として扱い、このサーバー時刻で上書きしてください。';
}

function namedForeignTimeRequest(value) {
  const valueText = clean(String(value ?? '').normalize('NFKC'), 300);
  if (NON_JST_TIME_CUE_RE.test(valueText) && !/(?:日本|JST|日本時間|東京|大阪|別府|大分)/i.test(valueText)) return true;
  const m = valueText.match(/^(.{2,24}?)(?:は|の)(?:今|現在)(?:は|って)?何時/);
  if (!m) return false;
  return !/(?:日本|東京|大阪|別府|大分|ここ|こちら|現在地)/.test(m[1]);
}

function localJstTemporalAnswer(value, now = new Date()) {
  const valueText = clean(String(value ?? '').normalize('NFKC'), 600);
  if (!valueText || namedForeignTimeRequest(valueText)) return null;

  let match = valueText.match(/今から\\s*(\\d{1,4})\\s*分後/);
  if (match) {
    const minutes = Number(match[1]);
    const target = new Date(now.getTime() + minutes * 60_000);
    const p = jstParts(target);
    return {
      kind: 'jst-relative-time',
      answer: `日本時間では、今から${minutes}分後は${p.hour}時${pad2(p.minute)}分です。`,
      route: 'jst-clock-v53', search: false, timeZone: 'Asia/Tokyo', utcOffsetMinutes: 540,
      serverEpochMs: now.getTime(), jstIso: jstIso(now), targetJstIso: jstIso(target), relativeMinutes: minutes,
    };
  }

  match = valueText.match(/今から\\s*(\\d{1,3})\\s*時間後/);
  if (match) {
    const hours = Number(match[1]);
    const target = new Date(now.getTime() + hours * 3_600_000);
    const p = jstParts(target);
    return {
      kind: 'jst-relative-time',
      answer: `日本時間では、今から${hours}時間後は${p.hour}時${pad2(p.minute)}分です。`,
      route: 'jst-clock-v53', search: false, timeZone: 'Asia/Tokyo', utcOffsetMinutes: 540,
      serverEpochMs: now.getTime(), jstIso: jstIso(now), targetJstIso: jstIso(target), relativeMinutes: hours * 60,
    };
  }

  if (JST_LOCAL_TIME_RE.test(valueText)) {
    const p = jstParts(now);
    return {
      kind: 'jst-current-time', answer: `現在の日本時間（JST）は${p.hour}時${pad2(p.minute)}分です。`,
      route: 'jst-clock-v53', search: false, timeZone: 'Asia/Tokyo', utcOffsetMinutes: 540,
      serverEpochMs: now.getTime(), jstIso: jstIso(now),
    };
  }

  if (JST_DATE_RE.test(valueText)) {
    const tomorrow = /明日/.test(valueText);
    const target = tomorrow ? new Date(now.getTime() + 86_400_000) : now;
    const p = jstParts(target);
    const date = `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
    const asksWeekday = /何曜日/.test(valueText);
    return {
      kind: 'jst-current-date',
      answer: asksWeekday
        ? `日本時間では、今日は${p.year}年${p.month}月${p.day}日、${p.weekday}曜日です。`
        : `日本時間では、${tomorrow ? '明日' : '今日'}は${p.year}年${p.month}月${p.day}日です。`,
      route: 'jst-calendar-v53', search: false, timeZone: 'Asia/Tokyo', utcOffsetMinutes: 540,
      serverEpochMs: now.getTime(), jstIso: jstIso(now), jstDate: date,
    };
  }
  return null;
}

function sentences(value) {"""
replace_once(anchor, temporal, 'JST helpers')

replace_once('function buildGeminiRequest(modelArgs = {}) {', 'function buildGeminiRequest(modelArgs = {}, now = new Date()) {', 'Gemini request clock argument')
replace_once(
    "parts: [{ text: clean(`${TALKSYS_IDENTITY_INSTRUCTION}${inheritedSystem ? `\\n\\n${inheritedSystem}` : ''}`, 60000) }],",
    "parts: [{ text: clean(`${TALKSYS_IDENTITY_INSTRUCTION}\\n\\n${jstTemporalInstruction(now)}${inheritedSystem ? `\\n\\n${inheritedSystem}` : ''}`, 60000) }],",
    'Gemini system temporal context',
)
replace_once('system_instruction: TALKSYS_IDENTITY_INSTRUCTION,', 'system_instruction: `${TALKSYS_IDENTITY_INSTRUCTION}\\n\\n${jstTemporalInstruction()}`,', 'Interactions temporal context')
replace_once("out.set('x-talksys-answer-route', 'gemini-native-interactions');", "out.set('x-talksys-answer-route', clean(data?.route || 'router-first-v53', 80));", 'answer route header')

replace_once(
    """      mode: 'compatibility-only',
      nativeGeminiAnswerPath: true,
      nativeGoogleSearch: true,
      customTruthGateOnNativeAnswers: false,""",
    """      mode: 'router-first-jst-evidence',
      nativeGeminiAnswerPath: false,
      nativeGoogleSearch: false,
      customTruthGateOnNativeAnswers: false,
      routerFirst: true,
      defaultTimezone: 'Asia/Tokyo',
      authoritativeJstClock: true,
      dynamicFactsRequireEvidence: true,""",
    'truth health contract',
)
replace_once(
    """      api: 'interactions',
      nativeGoogleSearch: true,
      revision: GEMINI_ADAPTER_REVISION,""",
    """      api: 'generateContent-adapter',
      nativeGoogleSearch: false,
      routerFirst: true,
      defaultTimezone: 'Asia/Tokyo',
      authoritativeJstClock: true,
      revision: GEMINI_ADAPTER_REVISION,""",
    'gemini health contract',
)

turn_pattern = re.compile(
    r"\n  if \(request\.method === 'POST' && url\.pathname === '/api/turn'\) \{\n"
    r"    let body = \{\};.*?\n  \}\n\n"
    r"  const runtimeEnv = withGeminiGenerationProvider\(env\);\n"
    r"  const response = await worker\.fetch\(request, runtimeEnv, ctx\);",
    re.S,
)
new_turn = """
  let turnBody = null;
  if (request.method === 'POST' && url.pathname === '/api/turn') {
    try {
      turnBody = await request.clone().json();
    } catch {
      return json({ ok: false, error: 'invalid_json' }, 400);
    }
    const temporal = localJstTemporalAnswer(turnBody?.text);
    if (temporal) {
      return json({
        ok: true,
        ...temporal,
        planner: 'trusted-jst-clock-v53',
        sources: [],
        apiSources: [],
        generationProvider: 'deterministic',
        generationModel: 'server-jst-clock',
        generationRevision: GEMINI_ADAPTER_REVISION,
        responseQualityRevision: RESPONSE_QUALITY_REVISION,
        geminiConfigured: hasGeminiKey(env),
        legacyGlmExecution: false,
        routerFirst: true,
      }, 200);
    }
  }

  const runtimeEnv = withGeminiGenerationProvider(env);
  const response = await worker.fetch(request, runtimeEnv, ctx);"""
text, n = turn_pattern.subn(new_turn, text, count=1)
if n != 1:
    raise SystemExit(f'router-first api turn regex matched {n} blocks')

anchor_after = """  const headers = new Headers(response.headers);
  headers.set('x-talksys-truth-gate-revision', TRUTH_GATE_REVISION);
  headers.set('x-talksys-generation-revision', GEMINI_ADAPTER_REVISION);
  headers.set('x-talksys-response-quality-revision', RESPONSE_QUALITY_REVISION);

  if (request.method === 'GET' && url.pathname === '/voice-health'"""
new_after = """  const headers = new Headers(response.headers);
  headers.set('x-talksys-truth-gate-revision', TRUTH_GATE_REVISION);
  headers.set('x-talksys-generation-revision', GEMINI_ADAPTER_REVISION);
  headers.set('x-talksys-response-quality-revision', RESPONSE_QUALITY_REVISION);

  if (request.method === 'POST' && url.pathname === '/api/turn' && /application\\/json/i.test(headers.get('content-type') || '')) {
    try {
      const payload = await response.clone().json();
      const question = clean(turnBody?.text, 1800);
      const gated = gateTurnPayload(payload, question);
      const normalized = normalizeGenerationMetadata({
        ...gated,
        routerFirst: true,
        defaultTimezone: 'Asia/Tokyo',
        authoritativeJstClock: true,
        dynamicFactsRequireEvidence: true,
        nativeGeminiAnswerPath: false,
        nativeGoogleSearch: false,
      }, env);
      return json(normalized, response.status, headers);
    } catch {
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
  }

  if (request.method === 'GET' && url.pathname === '/voice-health'"""
replace_once(anchor_after, new_after, 'turn response truth gate')

replace_once(
    """        truthGatePolicy: 'compatibility-only',
        nativeGeminiAnswerPath: true,
        nativeGoogleSearch: true,
        upstreamIdentitySuppressed: true,""",
    """        truthGatePolicy: 'claim-level-fail-close',
        nativeGeminiAnswerPath: false,
        nativeGoogleSearch: false,
        routerFirst: true,
        defaultTimezone: 'Asia/Tokyo',
        authoritativeJstClock: true,
        dynamicFactsRequireEvidence: true,
        upstreamIdentitySuppressed: true,""",
    'voice health JST flags',
)

replace_once(
    "  buildGeminiRequest,\n  sanitizeProviderSelfIdentification,",
    "  buildGeminiRequest,\n  jstParts,\n  jstIso,\n  jstTemporalInstruction,\n  localJstTemporalAnswer,\n  namedForeignTimeRequest,\n  sanitizeProviderSelfIdentification,",
    'test exports',
)

path.write_text(text)

Path('tests/jst-router-v53.test.mjs').write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';
import app, { RESPONSE_QUALITY_REVISION, __test } from '../src/entry.js';

const { buildGeminiRequest, jstTemporalInstruction, localJstTemporalAnswer, namedForeignTimeRequest } = __test;
const FIXED = new Date('2026-09-17T10:15:20Z');

test('v53 injects an authoritative Asia/Tokyo clock into every Gemini generation request', () => {
  assert.equal(RESPONSE_QUALITY_REVISION, 'talksys-v53-router-first-jst-r1');
  const instruction = jstTemporalInstruction(FIXED);
  assert.match(instruction, /2026-09-17T19:15:20\+09:00/);
  assert.match(instruction, /JST/);
  assert.match(instruction, /Asia\/Tokyo/);
  assert.match(instruction, /UTCやモデル内部時計を現在時刻として使わない/);
  const request = buildGeminiRequest({ messages: [{ role: 'user', content: '今は何時？' }] }, FIXED);
  const system = request.systemInstruction.parts[0].text;
  assert.match(system, /日本標準時JST/);
  assert.match(system, /2026-09-17T19:15:20\+09:00/);
  assert.match(system, /現在時刻より前の便を「次」と扱わず/);
});

test('trusted JST clock answers current time, date and relative time without model lookup', () => {
  const current = localJstTemporalAnswer('今何時？', FIXED);
  assert.equal(current.route, 'jst-clock-v53');
  assert.equal(current.timeZone, 'Asia/Tokyo');
  assert.equal(current.utcOffsetMinutes, 540);
  assert.match(current.answer, /19時15分/);
  const after = localJstTemporalAnswer('今から30分後は何時？', FIXED);
  assert.equal(after.relativeMinutes, 30);
  assert.match(after.answer, /19時45分/);
  const date = localJstTemporalAnswer('今日は何日？', FIXED);
  assert.equal(date.route, 'jst-calendar-v53');
  assert.equal(date.jstDate, '2026-09-17');
});

test('named foreign current-time requests are not forced to JST', () => {
  assert.equal(namedForeignTimeRequest('ニューヨークは今何時？'), true);
  assert.equal(localJstTemporalAnswer('ニューヨークは今何時？', FIXED), null);
  assert.equal(namedForeignTimeRequest('日本は今何時？'), false);
});

test('router-first entry keeps deterministic arithmetic out of native Gemini', async () => {
  const request = new Request('https://talksys.test/api/turn', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '12345÷15', history: [] }),
  });
  const response = await app.fetch(request, { GEMINI_API_KEY: 'test', AI: { run: async () => { throw new Error('AI must not run'); } } }, {});
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.route, 'deterministic-v45');
  assert.equal(body.search, false);
  assert.match(body.answer, /823/);
  assert.notEqual(body.route, 'gemini-native-interactions');
});

test('current-time route overrides stale assistant history with server JST', async () => {
  const request = new Request('https://talksys.test/api/turn', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '今何時？', history: [{ role: 'assistant', content: '現在は10時37分です。' }] }),
  });
  const before = Date.now();
  const response = await app.fetch(request, { GEMINI_API_KEY: 'test', AI: { run: async () => { throw new Error('AI must not run'); } } }, {});
  const body = await response.json();
  const after = Date.now();
  assert.equal(body.route, 'jst-clock-v53');
  assert.equal(body.generationProvider, 'deterministic');
  assert.equal(body.timeZone, 'Asia/Tokyo');
  assert.ok(body.serverEpochMs >= before && body.serverEpochMs <= after);
  assert.doesNotMatch(body.answer, /10時37分/);
});

test('health contract advertises router-first JST and evidence-only dynamic facts', async () => {
  const response = await app.fetch(new Request('https://talksys.test/voice-health'), {
    GEMINI_API_KEY: 'test', AI: { run: async () => ({ response: 'unused' }) },
  }, {});
  const body = await response.json();
  assert.equal(body.routerFirst, true);
  assert.equal(body.defaultTimezone, 'Asia/Tokyo');
  assert.equal(body.authoritativeJstClock, true);
  assert.equal(body.dynamicFactsRequireEvidence, true);
  assert.equal(body.nativeGeminiAnswerPath, false);
  assert.equal(body.nativeGoogleSearch, false);
});
''')

print('patched JST router and tests')

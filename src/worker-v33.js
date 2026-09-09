import { collectGroundedEvidenceV26 } from './search-v26.js';
import { groundingDecisionV22 } from './grounding-policy-v22.js';
import { TALK_CLIENT_V33 } from './talk-client-v33.js';

const REVISION = 'talksys-v33-clean-http-voice';
const GLM_MODEL = '@cf/zai-org/glm-5.3-flash';
const STT_MODEL = '@cf/openai/whisper-large-v3-turbo';
const TTS_MODEL = '@cf/myshell-ai/melotts';

const HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#111827">
<title>TalkSys</title>
<style>
:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#111827;background:#f5f6f8}*{box-sizing:border-box}body{margin:0}.app{max-width:820px;margin:0 auto;min-height:100vh;background:#fff;display:flex;flex-direction:column}.top{padding:16px 18px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;gap:12px}.brand{font-size:20px;font-weight:800}.mode{font-size:12px;color:#6b7280}.status{margin-left:auto;font-size:13px;font-weight:700}.chat{flex:1;min-height:48vh;padding:16px;overflow:auto}.msg{max-width:88%;padding:11px 13px;margin:8px 0;border-radius:14px;line-height:1.55;white-space:pre-wrap}.user{margin-left:auto;background:#111827;color:#fff}.assistant{background:#f0f2f5}.controls{padding:12px 16px 16px;border-top:1px solid #e5e7eb}.mic{width:100%;border:0;border-radius:12px;padding:14px;font-size:16px;font-weight:800;background:#111827;color:#fff}.mic.on{background:#b42318}.form{display:flex;gap:8px;margin-top:10px}.input{flex:1;border:1px solid #d1d5db;border-radius:10px;padding:11px;font-size:16px}.send{border:1px solid #111827;background:#fff;border-radius:10px;padding:0 14px;font-weight:700}.hint{font-size:12px;color:#6b7280;margin:8px 2px 0}.debug{border-top:1px solid #e5e7eb;padding:0 16px 16px}.debug summary{cursor:pointer;padding:12px 0;font-weight:800}.grid{display:grid;grid-template-columns:140px 1fr;gap:5px 10px;font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace}.key{color:#6b7280}.log{margin-top:10px;max-height:190px;overflow:auto;background:#0b1020;color:#d1d5db;border-radius:8px;padding:9px;font:11px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap}.test{margin-top:10px;border:1px solid #d1d5db;background:#fff;border-radius:8px;padding:8px 10px;font-weight:700}@media(max-width:600px){.app{max-width:none}.msg{max-width:94%}.grid{grid-template-columns:108px 1fr}}
</style>
</head>
<body><main class="app">
<header class="top"><div><div class="brand">TalkSys</div><div class="mode">電話相談モード</div></div><div id="status" class="status">停止中</div></header>
<section id="chat" class="chat" aria-live="polite"></section>
<section class="controls"><button id="mic" class="mic" type="button">マイク会話を開始</button><form id="form" class="form"><input id="input" class="input" autocomplete="off" placeholder="非常用の文字入力"><button class="send" type="submit">送信</button></form><div class="hint">文字入力も同じ会話として扱います。</div></section>
<details class="debug"><summary>デバッグ画面</summary><div id="diag" class="grid"></div><button id="tts-test" class="test" type="button">日本語TTSをテスト</button><div id="log" class="log"></div></details>
</main><script src="/talk-v33.js"></script></body></html>`;

function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('x-talksys-revision', REVISION);
  return new Response(JSON.stringify(data), { ...init, headers });
}

function cleanText(value, max = 6000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-14).map((item) => ({
    role: item?.role === 'assistant' ? 'assistant' : 'user',
    content: cleanText(item?.content, 1400),
  })).filter((item) => item.content);
}

function base64FromBytes(bytes) {
  let out = '';
  const size = 0x8000;
  for (let i = 0; i < bytes.length; i += size) out += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + size)));
  return btoa(out);
}

function extractText(result) {
  if (typeof result === 'string') return cleanText(result);
  if (!result) return '';
  for (const value of [result.response, result.result, result.text, result.output_text]) {
    if (typeof value === 'string' && value.trim()) return cleanText(value);
  }
  const content = result.choices?.[0]?.message?.content;
  if (typeof content === 'string') return cleanText(content);
  if (Array.isArray(content)) return cleanText(content.map((x) => typeof x === 'string' ? x : x?.text || x?.content || '').join(''));
  return cleanText(result.choices?.[0]?.text || '');
}

function normalizeTts(text) {
  return cleanText(text, 1800)
    .replace(/\bPC\b/gi, 'パソコン').replace(/\bSSD\b/gi, 'エスエスディー')
    .replace(/\bCPU\b/gi, 'シーピーユー').replace(/\bGPU\b/gi, 'ジーピーユー')
    .replace(/\bRAM\b/gi, 'メモリー').replace(/\bWeb\b/gi, 'ウェブ')
    .replace(/\bAI\b/gi, 'エーアイ').replace(/\bWi[-‐‑–—]?Fi\b/gi, 'ワイファイ')
    .replace(/https?:\/\/\S+/g, 'リンク').replace(/[*_#>`~]/g, '');
}

async function audioBufferFromResult(result) {
  if (!result) return null;
  if (result instanceof Response) return result.ok ? result.arrayBuffer() : null;
  if (result instanceof ArrayBuffer) return result;
  if (result instanceof Uint8Array) return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
  if (result instanceof ReadableStream) return new Response(result).arrayBuffer();
  const base64 = typeof result === 'string' ? result : typeof result?.audio === 'string' ? result.audio : '';
  if (!base64) return null;
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

function evidenceBlock(result) {
  const sources = Array.isArray(result?.sources) ? result.sources.slice(0, 7) : [];
  return sources.map((item, i) => {
    const excerpt = cleanText(item?.excerpt || item?.snippet || '', 900);
    return `[${i + 1}] ${cleanText(item?.title, 180)}\n${cleanText(item?.url, 500)}\n${excerpt}`;
  }).join('\n\n');
}

const SYSTEM = `あなたはTalkSysという日本語の電話相談AIです。
返答は短く、はっきり言ってください。最初の一文で質問へ直接答えてください。
原則1〜3文です。説明が必要な場合だけ4文まで許可します。前置き、同じ内容の言い換え、過剰な安心表現、不要な一般論は禁止です。
「一番」「おすすめ」「どれがいい」と聞かれ、判断材料が足りている場合は候補をぼかさず1つ選び、その名前を最初に言ってください。
既に会話で分かっている用途・予算・場所などを聞き直さないでください。毎回質問で終わらせないでください。
断定できる根拠があることは断定してください。根拠が不足することだけ、不明と明示してください。
URL、Markdown、内部処理、モデル名は回答本文に出さないでください。`;

const GROUNDED = `${SYSTEM}\nこのターンはWeb確認済みです。外部事実は提示された根拠に直接支えられる範囲だけ使ってください。根拠にない店名・価格・営業時間・住所などを補わないでください。`;

async function runGlm(env, messages, maxTokens = 180) {
  const started = Date.now();
  let firstError = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(attempt ? 6500 : 5200) : undefined;
      const result = await env.AI.run(GLM_MODEL, {
        messages,
        stream: false,
        modalities: ['text'],
        max_completion_tokens: maxTokens,
        temperature: 0.12,
        reasoning_effort: 'low',
      }, signal ? { signal } : undefined);
      const text = extractText(result);
      if (text) return { text, elapsedMs: Date.now() - started, attempts: attempt + 1 };
      firstError ||= 'empty response';
    } catch (error) {
      firstError ||= String(error?.message || error).slice(0, 180);
    }
  }
  throw new Error(firstError || 'GLM failed');
}

async function transcribe(request, env) {
  const started = Date.now();
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength < 800) return json({ ok: false, error: 'audio too short' }, { status: 400 });
  if (buffer.byteLength > 8_000_000) return json({ ok: false, error: 'audio too large' }, { status: 413 });
  try {
    const result = await env.AI.run(STT_MODEL, {
      audio: base64FromBytes(new Uint8Array(buffer)),
      task: 'transcribe',
      language: 'ja',
      vad_filter: true,
      initial_prompt: '日本語の日常会話を、聞こえた内容のまま文字起こしする。固有名詞、製品名、英数字を勝手に言い換えない。',
      beam_size: 5,
      condition_on_previous_text: false,
    });
    const text = cleanText(result?.text || result?.transcription_info?.text || result?.transcript || result?.response || '');
    return json({ ok: Boolean(text), text, elapsedMs: Date.now() - started, bytes: buffer.byteLength, model: STT_MODEL });
  } catch (error) {
    return json({ ok: false, error: String(error?.message || error).slice(0, 240), elapsedMs: Date.now() - started }, { status: 502 });
  }
}

async function turn(request, env) {
  const started = Date.now();
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid json' }, { status: 400 }); }
  const text = cleanText(body?.text, 1800);
  const history = safeHistory(body?.history);
  if (!text) return json({ ok: false, error: 'text required' }, { status: 400 });

  const decision = groundingDecisionV22(text, history);
  let search = null;
  let searchMs = 0;
  if (decision.search) {
    const searchStarted = Date.now();
    try { search = await collectGroundedEvidenceV26(text, history); }
    catch (error) { search = { resolvedQuestion: text, queries: [text], sources: [], error: String(error?.message || error).slice(0, 180) }; }
    searchMs = Date.now() - searchStarted;
  }

  const evidence = evidenceBlock(search);
  const messages = [
    { role: 'system', content: search ? GROUNDED : SYSTEM },
    ...history,
    { role: 'user', content: search ? `${text}\n\n[今回確認した根拠]\n${evidence || '(有効な根拠なし)'}` : text },
  ];

  try {
    const generated = await runGlm(env, messages, search ? 190 : 150);
    return json({
      ok: true,
      answer: generated.text,
      search: Boolean(search),
      searchUseful: Boolean(search?.sources?.length),
      resolvedQuestion: search?.resolvedQuestion || '',
      queries: Array.isArray(search?.queries) ? search.queries.slice(0, 5) : [],
      sources: Array.isArray(search?.sources) ? search.sources.slice(0, 6).map((x) => ({ title: cleanText(x?.title, 180), url: cleanText(x?.url, 500) })) : [],
      timings: { totalMs: Date.now() - started, searchMs, glmMs: generated.elapsedMs },
      model: GLM_MODEL,
    });
  } catch (error) {
    return json({ ok: false, error: String(error?.message || error).slice(0, 240), timings: { totalMs: Date.now() - started, searchMs } }, { status: 502 });
  }
}

async function tts(request, env) {
  const started = Date.now();
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid json' }, { status: 400 }); }
  const prompt = normalizeTts(body?.text);
  if (!prompt) return json({ ok: false, error: 'text required' }, { status: 400 });
  try {
    const result = await env.AI.run(TTS_MODEL, { prompt, lang: 'JP' });
    const audio = await audioBufferFromResult(result);
    if (!audio || audio.byteLength < 100) throw new Error('empty TTS audio');
    return new Response(audio, { headers: {
      'content-type': 'audio/mpeg',
      'cache-control': 'no-store',
      'x-talksys-revision': REVISION,
      'x-talksys-tts-model': TTS_MODEL,
      'x-talksys-tts-lang': 'JP',
      'x-talksys-tts-ms': String(Date.now() - started),
    }});
  } catch (error) {
    return json({ ok: false, error: String(error?.message || error).slice(0, 240), elapsedMs: Date.now() - started }, { status: 502 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-talksys-revision': REVISION } });
    if (request.method === 'GET' && url.pathname === '/talk-v33.js') return new Response(TALK_CLIENT_V33, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-talksys-revision': REVISION } });
    if (request.method === 'GET' && url.pathname === '/voice-health') return json({
      ok: true,
      revision: REVISION,
      voiceRevision: REVISION,
      architecture: 'http-turns-client-vad',
      conversationModel: GLM_MODEL,
      sttModel: STT_MODEL,
      ttsModel: TTS_MODEL,
      ttsLanguage: 'JP',
      legacyWebSocketVoice: false,
      durableObjectVoice: false,
    });
    if (request.method === 'POST' && url.pathname === '/api/transcribe') return transcribe(request, env);
    if (request.method === 'POST' && url.pathname === '/api/turn') return turn(request, env);
    if (request.method === 'POST' && url.pathname === '/api/tts') return tts(request, env);
    return new Response('Not found', { status: 404 });
  },
};

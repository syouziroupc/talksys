import { collectGroundedEvidenceV26 } from './search-v26.js';
import { groundingDecisionV22 } from './grounding-policy-v22.js';
import { TALK_CLIENT_V34 } from './talk-client-v34.js';

const REVISION = 'talksys-v34-grok-ja-natural';
const GLM_MODEL = '@cf/zai-org/glm-5.3-flash';
const STT_MODEL = '@cf/openai/whisper-large-v3-turbo';
const TTS_MODEL = 'xai/grok-tts';
const TTS_LANGUAGE = 'ja';
const TTS_VOICE = 'ara';

const PC_TOPIC_RE = /(パソコン|\bPC\b|ＰＣ|Windows|MacBook|ThinkPad|Let'?s\s*note|レッツノート|CPU|GPU|Core\s*i[3579]|Ryzen|GeForce|Radeon|メモリ|RAM|SSD|NVMe|SATA|USB[- ]?C|Thunderbolt|Wi-?Fi|Bluetooth|BIOS|UEFI)/i;
const HARD_SEARCH_RE = /(検索して|調べて|ウェブで|Webで|ネットで確認|最新|現在|今日|明日|昨日|今年|今月|ニュース|価格|値段|相場|在庫|営業時間|営業中|天気|株価|為替|発売|販売中|現行|法改正|制度改正|予定|日程|時刻表|運行|遅延|空席|予約状況|電話番号|連絡先|住所|所在地|アクセス|公式サイト|URL|ランキング|順位|どこで買|どこに売|近くの|店舗|販売店|家電量販店|乗り換え|乗換|経路|行き方|所要時間|運賃)/i;
const GENERAL_ADVICE_RE = /(相談|どう思う|どう考える|どう決め|どう選|選び方|選ぶ基準|基準で|でもいいかな|でも大丈夫|した方がいい|すべき|向いている|必要かな|がいい|が欲しい|ほしい|買い替え|使いたい|安い|簡単な|用途)/i;
const SPECIFIC_LOOKUP_RE = /(具体的に.*(?:機種|モデル|製品)|おすすめ.*(?:機種|モデル|製品)|どの(?:機種|モデル|製品)|どれを買|候補を(?:出|挙)|商品名)/i;
const QUALITY_INTENT_RE = /(なぜ|理由|比較|どっち|どちら|どうすれば|どうしたら|整理して|メリット|デメリット|可能性|戦略|設計|方針|改善|問題点|原因|判断|基準|選び方)/i;

const HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#111827"><title>TalkSys</title>
<style>
:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#111827;background:#f5f6f8}*{box-sizing:border-box}body{margin:0}.app{max-width:820px;margin:0 auto;min-height:100vh;background:#fff;display:flex;flex-direction:column}.top{padding:16px 18px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;gap:12px}.brand{font-size:20px;font-weight:800}.mode{font-size:12px;color:#6b7280}.status{margin-left:auto;font-size:13px;font-weight:700}.chat{flex:1;min-height:48vh;padding:16px;overflow:auto}.msg{max-width:88%;padding:11px 13px;margin:8px 0;border-radius:14px;line-height:1.55;white-space:pre-wrap}.user{margin-left:auto;background:#111827;color:#fff}.assistant{background:#f0f2f5}.controls{padding:12px 16px 16px;border-top:1px solid #e5e7eb}.mic{width:100%;border:0;border-radius:12px;padding:14px;font-size:16px;font-weight:800;background:#111827;color:#fff}.mic.on{background:#b42318}.form{display:flex;gap:8px;margin-top:10px}.input{flex:1;border:1px solid #d1d5db;border-radius:10px;padding:11px;font-size:16px}.send{border:1px solid #111827;background:#fff;border-radius:10px;padding:0 14px;font-weight:700}.hint{font-size:12px;color:#6b7280;margin:8px 2px 0}.debug{border-top:1px solid #e5e7eb;padding:0 16px 16px}.debug summary{cursor:pointer;padding:12px 0;font-weight:800}.grid{display:grid;grid-template-columns:140px 1fr;gap:5px 10px;font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace}.key{color:#6b7280}.log{margin-top:10px;max-height:190px;overflow:auto;background:#0b1020;color:#d1d5db;border-radius:8px;padding:9px;font:11px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap}.test{margin-top:10px;border:1px solid #d1d5db;background:#fff;border-radius:8px;padding:8px 10px;font-weight:700}@media(max-width:600px){.app{max-width:none}.msg{max-width:94%}.grid{grid-template-columns:108px 1fr}}
</style></head><body><main class="app"><header class="top"><div><div class="brand">TalkSys</div><div class="mode">電話相談モード</div></div><div id="status" class="status">停止中</div></header><section id="chat" class="chat" aria-live="polite"></section><section class="controls"><button id="mic" class="mic" type="button">マイク会話を開始</button><form id="form" class="form"><input id="input" class="input" autocomplete="off" placeholder="非常用の文字入力"><button class="send" type="submit">送信</button></form><div class="hint">文字入力も同じ会話として扱います。</div></section><details class="debug"><summary>デバッグ画面</summary><div id="diag" class="grid"></div><button id="tts-test" class="test" type="button">日本語TTSをテスト</button><div id="log" class="log"></div></details></main><script src="/talk-v34.js"></script></body></html>`;

function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('x-talksys-revision', REVISION);
  return new Response(JSON.stringify(data), { ...init, headers });
}
function cleanText(value, max = 6000) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max); }
function safeHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-14).map((item) => ({ role: item?.role === 'assistant' ? 'assistant' : 'user', content: cleanText(item?.content, 1600) })).filter((item) => item.content);
}
function base64FromBytes(bytes) {
  let out = ''; const size = 0x8000;
  for (let i = 0; i < bytes.length; i += size) out += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + size)));
  return btoa(out);
}
function extractText(result) {
  if (typeof result === 'string') return cleanText(result);
  if (!result) return '';
  for (const value of [result.response, result.result, result.text, result.output_text]) if (typeof value === 'string' && value.trim()) return cleanText(value);
  const content = result.choices?.[0]?.message?.content;
  if (typeof content === 'string') return cleanText(content);
  if (Array.isArray(content)) return cleanText(content.map((x) => typeof x === 'string' ? x : x?.text || x?.content || '').join(''));
  return cleanText(result.choices?.[0]?.text || '');
}
function normalizeTts(text) {
  return cleanText(text, 1800)
    .replace(/\bWindows\s*10\b/gi, 'ウィンドウズ テン')
    .replace(/\bWindows\s*11\b/gi, 'ウィンドウズ イレブン')
    .replace(/\bPC\b/gi, 'パソコン').replace(/\bSSD\b/gi, 'エスエスディー').replace(/\bHDD\b/gi, 'エイチディーディー')
    .replace(/\bCPU\b/gi, 'シーピーユー').replace(/\bGPU\b/gi, 'ジーピーユー').replace(/\bRAM\b/gi, 'メモリー')
    .replace(/\bUSB\b/gi, 'ユーエスビー').replace(/\bHDMI\b/gi, 'エイチディーエムアイ').replace(/\bWi[-‐‑–—]?Fi\b/gi, 'ワイファイ')
    .replace(/https?:\/\/\S+/g, 'リンク').replace(/[*_#>`~]/g, '');
}
function evidenceBlock(result) {
  const sources = Array.isArray(result?.sources) ? result.sources.slice(0, 7) : [];
  return sources.map((item, i) => `[${i + 1}] ${cleanText(item?.title, 180)}\n${cleanText(item?.url, 500)}\n${cleanText(item?.excerpt || item?.snippet || '', 850)}`).join('\n\n');
}
function quickCasualReply(text) {
  const value = cleanText(text, 80).replace(/[！!。．.]+$/u, '');
  if (/^(こんにちは|こんにちわ|やあ|どうも|もしもし)$/u.test(value)) return 'こんにちは。どうしました？';
  if (/^(おはよう|おはようございます)$/u.test(value)) return 'おはようございます。どうしました？';
  if (/^こんばんは$/u.test(value)) return 'こんばんは。どうしました？';
  if (/^(ありがとう|ありがとうございます|どうもありがとう)$/u.test(value)) return 'どういたしまして。';
  return '';
}
function shouldSearch(text, history) {
  if (HARD_SEARCH_RE.test(text)) return { search: true, reason: 'explicit-current-lookup' };
  if (SPECIFIC_LOOKUP_RE.test(text)) return { search: true, reason: 'specific-product-lookup' };
  if (GENERAL_ADVICE_RE.test(text)) return { search: false, reason: 'contextual-advice' };
  if (text.length <= 48 && QUALITY_INTENT_RE.test(text)) return { search: false, reason: 'contextual-reasoning' };
  const context = `${history.slice(-6).map((x) => x.content).join(' ')} ${text}`;
  if (PC_TOPIC_RE.test(context) && text.length <= 80 && !HARD_SEARCH_RE.test(text)) return { search: false, reason: 'pc-conversation' };
  const base = groundingDecisionV22(text, history);
  return { search: Boolean(base.search), reason: base.reason || 'grounding-policy' };
}

const GENERAL_PROMPT = `あなたはTalkSysという日本語の電話相談AIです。
同じ通話の会話履歴を必ず使い、すでに分かっている用途・希望・予算・場所などを聞き直さないでください。
人と電話で話している自然な日本語にしてください。最初に役立つ答えを言い、そのあと必要な理由だけを続けてください。
単純な内容は1〜2文、通常は2〜4文、複雑でも5文程度までを目安にしてください。短くするためにぶつ切りの電文調にはしないでください。
曖昧に「具体的な内容を教えてください」で返さないでください。情報が足りなくても、分かっている範囲でまず一歩進んだ提案を出してください。
判断材料が十分なら、候補をぼかさず結論を言ってください。必要な確認質問は一度に1つだけで、質問なしで答え切れるなら質問で終えないでください。
この経路ではWeb検索していません。価格、在庫、営業時間、ニュース、法律、現行仕様など変化する外部事実を記憶だけで断定しないでください。
URL、Markdown、内部処理、モデル名は回答本文に出さないでください。`;

const PC_PROMPT = `${GENERAL_PROMPT}
パソコン相談では販売・修理の実務者として、用途から必要十分な性能を判断してください。過剰性能を勧めないでください。
買い替え相談では、用途が分かった時点で「どの程度のクラスが適切か」を先に示してください。CPU、メモリ、SSDなどは判断に必要な項目だけ述べ、仕様表の読み上げにしないでください。
「安い」「簡単な用途」などの希望も有効な条件として扱い、同じことを数値で聞き直す前に実用的な方向性を示してください。`;

const GROUNDED_PROMPT = `あなたはTalkSysという日本語の電話相談AIです。
このターンではWeb確認済みです。具体的な外部事実は今回提示された根拠に直接支えられる内容だけを使ってください。
検索結果の紹介ではなく、会話履歴と今回の質問に対する答えとして自然な日本語でまとめてください。
最初に結論を言い、通常2〜4文、必要でも5文程度までにしてください。判断材料が十分なら候補をぼかさず選んでください。
根拠にない店名・価格・仕様・営業時間などは補わないでください。検索の成否、URL、Markdown、根拠番号、モデル名は読み上げないでください。`;
const GROUNDED_PC_PROMPT = `${GROUNDED_PROMPT}\nパソコン関連では、用途・予算・保証・性能など判断を左右する項目を優先し、価格・在庫・現行仕様は根拠にある範囲だけ述べてください。`;

async function runGlm(env, messages, maxTokens = 220) {
  const started = Date.now(); let firstError = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(attempt ? 7000 : 5600) : undefined;
      const result = await env.AI.run(GLM_MODEL, { messages, stream: false, modalities: ['text'], max_completion_tokens: maxTokens, temperature: 0.18, reasoning_effort: 'low' }, signal ? { signal } : undefined);
      const text = extractText(result); if (text) return { text, elapsedMs: Date.now() - started, attempts: attempt + 1 };
      firstError ||= 'empty response';
    } catch (error) { firstError ||= String(error?.message || error).slice(0, 180); }
  }
  throw new Error(firstError || 'GLM failed');
}
async function transcribe(request, env) {
  const started = Date.now(); const buffer = await request.arrayBuffer();
  if (buffer.byteLength < 800) return json({ ok: false, error: 'audio too short' }, { status: 400 });
  if (buffer.byteLength > 8_000_000) return json({ ok: false, error: 'audio too large' }, { status: 413 });
  try {
    const result = await env.AI.run(STT_MODEL, { audio: base64FromBytes(new Uint8Array(buffer)), task: 'transcribe', language: 'ja', vad_filter: true, initial_prompt: '日本語の日常会話を、聞こえた内容のまま文字起こしする。固有名詞、製品名、英数字を勝手に言い換えない。', beam_size: 5, condition_on_previous_text: false });
    const text = cleanText(result?.text || result?.transcription_info?.text || result?.transcript || result?.response || '');
    return json({ ok: Boolean(text), text, elapsedMs: Date.now() - started, bytes: buffer.byteLength, model: STT_MODEL });
  } catch (error) { return json({ ok: false, error: String(error?.message || error).slice(0, 240), elapsedMs: Date.now() - started }, { status: 502 }); }
}
async function turn(request, env) {
  const started = Date.now(); let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid json' }, { status: 400 }); }
  const text = cleanText(body?.text, 1800), history = safeHistory(body?.history);
  if (!text) return json({ ok: false, error: 'text required' }, { status: 400 });
  const quick = quickCasualReply(text);
  if (quick) return json({ ok: true, answer: quick, search: false, route: 'instant-casual', timings: { totalMs: Date.now() - started, searchMs: 0, glmMs: 0 }, model: 'local' });

  const decision = shouldSearch(text, history);
  let search = null, searchMs = 0;
  if (decision.search) {
    const searchStarted = Date.now();
    try { search = await collectGroundedEvidenceV26(text, history); }
    catch (error) { search = { resolvedQuestion: text, queries: [text], sources: [], error: String(error?.message || error).slice(0, 180) }; }
    searchMs = Date.now() - searchStarted;
  }
  const contextText = `${history.slice(-8).map((x) => x.content).join(' ')} ${text}`;
  const pc = PC_TOPIC_RE.test(contextText);
  const evidence = evidenceBlock(search);
  const system = search ? (pc ? GROUNDED_PC_PROMPT : GROUNDED_PROMPT) : (pc ? PC_PROMPT : GENERAL_PROMPT);
  const messages = [{ role: 'system', content: system }, ...history, { role: 'user', content: search ? `${text}\n\n[今回確認したWeb根拠]\n${evidence || '(有効な根拠なし)'}` : text }];
  try {
    const generated = await runGlm(env, messages, search ? 260 : pc ? 240 : 220);
    return json({ ok: true, answer: generated.text, search: Boolean(search), route: decision.reason, searchUseful: Boolean(search?.sources?.length), resolvedQuestion: search?.resolvedQuestion || '', queries: Array.isArray(search?.queries) ? search.queries.slice(0, 5) : [], sources: Array.isArray(search?.sources) ? search.sources.slice(0, 6).map((x) => ({ title: cleanText(x?.title, 180), url: cleanText(x?.url, 500) })) : [], timings: { totalMs: Date.now() - started, searchMs, glmMs: generated.elapsedMs }, model: GLM_MODEL });
  } catch (error) { return json({ ok: false, error: String(error?.message || error).slice(0, 240), timings: { totalMs: Date.now() - started, searchMs } }, { status: 502 }); }
}

async function grokAudio(result) {
  const audioUrl = [result?.audio, result?.result?.audio, result?.response?.audio, result?.result?.result?.audio].find((x) => typeof x === 'string' && /^https:\/\//i.test(x));
  if (!audioUrl) throw new Error('Grok TTS returned no audio URL');
  const response = await fetch(audioUrl);
  if (!response.ok) throw new Error(`Grok TTS audio fetch failed: ${response.status}`);
  const audio = await response.arrayBuffer();
  if (audio.byteLength < 100) throw new Error('Grok TTS returned empty audio');
  return { audio, contentType: response.headers.get('content-type') || 'audio/mpeg' };
}
async function tts(request, env) {
  const started = Date.now(); let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid json' }, { status: 400 }); }
  const text = normalizeTts(body?.text);
  if (!text) return json({ ok: false, error: 'text required' }, { status: 400 });
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await env.AI.run(TTS_MODEL, { text, language: TTS_LANGUAGE, voice_id: TTS_VOICE, text_normalization: true, output_format: { codec: 'mp3', sample_rate: 24000, bit_rate: 128000 } });
      const { audio, contentType } = await grokAudio(result);
      return new Response(audio, { headers: { 'content-type': contentType, 'cache-control': 'no-store', 'x-talksys-revision': REVISION, 'x-talksys-tts-model': TTS_MODEL, 'x-talksys-tts-lang': TTS_LANGUAGE, 'x-talksys-tts-voice': TTS_VOICE, 'x-talksys-tts-attempts': String(attempt + 1), 'x-talksys-tts-ms': String(Date.now() - started) } });
    } catch (error) { lastError = error; if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 180)); }
  }
  return json({ ok: false, error: String(lastError?.message || lastError || 'TTS failed').slice(0, 240), elapsedMs: Date.now() - started }, { status: 502 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-talksys-revision': REVISION } });
    if (request.method === 'GET' && url.pathname === '/talk-v34.js') return new Response(TALK_CLIENT_V34, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-talksys-revision': REVISION } });
    if (request.method === 'GET' && url.pathname === '/voice-health') return json({ ok: true, revision: REVISION, voiceRevision: REVISION, architecture: 'http-turns-client-vad', conversationModel: GLM_MODEL, sttModel: STT_MODEL, ttsModel: TTS_MODEL, ttsLanguage: TTS_LANGUAGE, ttsVoice: TTS_VOICE, legacyWebSocketVoice: false, durableObjectVoice: false });
    if (request.method === 'POST' && url.pathname === '/api/transcribe') return transcribe(request, env);
    if (request.method === 'POST' && url.pathname === '/api/turn') return turn(request, env);
    if (request.method === 'POST' && url.pathname === '/api/tts') return tts(request, env);
    return new Response('Not found', { status: 404 });
  },
};
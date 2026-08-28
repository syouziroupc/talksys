import { Agent, routeAgentRequest } from 'agents';
import { withVoice } from '@cloudflare/voice';
import app from './index.js';
import { REALTIME_VOICE_CLIENT } from './realtime-voice-client.js';
import { VOICE_MARKER_BRIDGE } from './voice-marker-bridge.js';
import { VOICE_FALLBACK_CLIENT } from './voice-fallback-client.js';
import { FinalizableNova3STT } from './finalizable-nova3.js';
import { needsWebSearch, webSearch, formatSearchContext } from './web-search.js';
import {
  TEXT_MODEL,
  extractText,
  cleanSpeechText,
  parseScreenDecision,
  MeloJapaneseTTS,
  wrapAI,
} from './voice-helpers.js';

const VOICE_REVISION = 'fast-grounded-v9';
const CASUAL_VOICE_MODEL = '@cf/meta/llama-3.2-3b-instruct';
const GROUNDED_VOICE_MODEL = '@cf/qwen/qwen3.8-27b';

const CASUAL_SYSTEM_PROMPT = `日本語の自然な会話相手として答える。電話会話なので冗長にはしないが、質問・相談・雑談には原則2〜4文で答え、要点だけの一言で終わらせない。まず直接答え、その後に理由・補足・具体例のいずれかを1つ加え、会話を続ける意味があるときだけ短い質問を1つ返す。挨拶、相槌、Yes/Noだけで十分な発話は短くてよい。雑談をPC操作の話にしない。知らない事実や現在情報は作らず、必要なら確認が必要だと短く言う。定型的な前置き、Markdown、URL読み上げは避ける。`;

const GROUNDED_SYSTEM_PROMPT = `あなたはTalkSysという日本語の音声アシスタントです。電話会話として自然に、通常2〜4文で必要な情報を省略しすぎず答えてください。
絶対ルール:
- [ウェブ検索結果] がある外部事実は、その結果に書かれた範囲だけで答える。検索結果にない事実は補完しない。
- 検索結果が無い、無関係、食い違う場合は推測せず「確認できない」と短く伝える。
- 過去のassistant発言は事実の証拠にしない。
- 実際に行っていないPC操作を「開いた」「押した」「変更した」と言わない。
- 現在画面を断定できるのは [システムが取得した現在画面の情報] が今回の入力にある場合だけ。画面情報に無いボタン名、エラー、配置を作らない。
- 曖昧な場合は捏造するより短い確認質問をする。
- URLやMarkdownは読み上げない。結論だけで終わらず、検索結果に根拠となる補足があれば1〜2点だけ添える。`;

const SCREEN_INTENT_RE = /(画面|ウィンドウ|ボタン|アイコン|メニュー|タブ|クリック|押して|押す|開いて|開きたい|どこにある|どのボタン|エラー表示|表示され|見えて|矢印|指して|デスクトップ|ブラウザ|設定画面)/i;

function mightNeedScreen(transcript) {
  return SCREEN_INTENT_RE.test(String(transcript || ''));
}

function fastChatInput(messages, maxCompletionTokens = 240, temperature = 0.25) {
  return {
    messages,
    max_completion_tokens: maxCompletionTokens,
    temperature,
    reasoning_effort: null,
    chat_template_kwargs: {
      enable_thinking: false,
      clear_thinking: true,
    },
  };
}

function casualChatInput(messages) {
  return {
    messages,
    max_tokens: 180,
    temperature: 0.55,
    top_p: 0.9,
  };
}

async function decideScreen(ai, transcript, history, signal) {
  const recent = Array.isArray(history)
    ? history.slice(-3).map((item) => `${item.role}: ${item.content}`).join('\n')
    : '';
  const result = await ai.run(
    TEXT_MODEL,
    fastChatInput([
      {
        role: 'system',
        content: '今回の依頼に答えるため現在のPC画面を実際に見る必要があるかだけ判定する。雑談、一般知識、文章相談、日常会話はfalse。現在表示中のボタン、アイコン、エラー、ウィンドウ、操作場所を確認しないと正確に答えられない時だけtrue。JSON以外を返さない。形式: {"inspect":true|false,"query":"確認対象を短く"}',
      },
      {
        role: 'user',
        content: `直近の会話:\n${recent || '(なし)'}\n\n今回の発話:\n${transcript}`,
      },
    ], 96, 0),
    signal ? { signal } : undefined,
  );
  return parseScreenDecision(extractText(result));
}

function formatScreenContext(screen) {
  if (!screen || screen.available !== true) return '画面確認は利用できませんでした。';
  const result = screen.result || {};
  if (result.found) {
    return `画面確認結果: 対象「${String(result.label || '対象').slice(0, 160)}」を検出。位置 x=${Number(result.x) || 0}, y=${Number(result.y) || 0}。補足: ${String(result.note || '').slice(0, 300)}`;
  }
  return `画面確認結果: 指定対象は特定できませんでした。補足: ${String(result.note || '').slice(0, 300)}`;
}

const VoiceAgentBase = withVoice(Agent, {
  historyLimit: 16,
  audioFormat: 'mp3',
  maxMessageCount: 500,
  diagnostics: { browserConsole: false },
});

function createJapaneseTranscriber(ai) {
  return new FinalizableNova3STT(ai, {
    language: 'ja',
    sampleRate: 16000,
    smartFormat: true,
    punctuate: true,
    serverSilenceFallbackMs: 1050,
    maxTurnMs: 30000,
    preRollFrames: 6,
    minSpeechMs: 160,
  });
}

export class TalkSysVoiceAgent extends VoiceAgentBase {
  tts = new MeloJapaneseTTS(this.env.AI);
  screenWaiters = new Map();

  createTranscriber() {
    return createJapaneseTranscriber(this.env.AI);
  }

  beforeSynthesize() {
    return null;
  }

  afterTranscribe(transcript) {
    const text = String(transcript || '').trim();
    if (!text || /^[えーあーうーん\s。、]+$/u.test(text)) return null;
    return text;
  }

  onCallStart() {
    // 接続直後はTTSを呼ばず即Listeningへ移行する。
  }

  onMessage(connection, message) {
    if (typeof message !== 'string') return;
    let data;
    try { data = JSON.parse(message); } catch { return; }
    if (data?.type !== 'screen_result' || typeof data.id !== 'string') return;
    const waiter = this.screenWaiters.get(data.id);
    if (!waiter || waiter.connectionId !== connection.id) return;
    waiter.finish(data);
  }

  requestScreen(connection, query, signal) {
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      let finished = false;
      const finish = (value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.screenWaiters.delete(id);
        resolve(value);
      };
      const timer = setTimeout(() => finish({ type: 'screen_result', id, available: false, error: 'timeout' }), 4500);
      this.screenWaiters.set(id, { connectionId: connection.id, finish });
      if (signal) signal.addEventListener('abort', () => finish({ type: 'screen_result', id, available: false, error: 'aborted' }), { once: true });
      connection.send(JSON.stringify({ type: 'screen_request', id, query }));
    });
  }

  async onTurn(transcript, context) {
    const screenIntent = mightNeedScreen(transcript);
    const searchIntent = !screenIntent && needsWebSearch(transcript);
    let screenContext = '';
    let searchContext = '';

    if (screenIntent) {
      try {
        const decision = await decideScreen(this.env.AI, transcript, context.messages, context.signal);
        if (decision.inspect) {
          const screen = await this.requestScreen(context.connection, decision.query || transcript, context.signal);
          screenContext = formatScreenContext(screen);
        }
      } catch {
        screenContext = '';
      }
    } else if (searchIntent) {
      try { context.connection.send(JSON.stringify({ type: 'search_status', phase: 'searching', searched: true })); } catch {}
      const results = await webSearch(transcript, { limit: 5, timeoutMs: 1900 });
      searchContext = formatSearchContext(results) || '有効な検索結果なし。現在情報は推測しないこと。';
      try {
        context.connection.send(JSON.stringify({
          type: 'search_status',
          phase: 'done',
          searched: true,
          resultCount: results.length,
          sources: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url, engine: item.engine || '' })),
        }));
      } catch {}
    }

    let userContent = transcript;
    if (screenContext) userContent += `\n\n[システムが取得した現在画面の情報]\n${screenContext}`;
    if (searchIntent) userContent += `\n\n[ウェブ検索結果]\n${searchContext}`;

    let result;
    if (searchIntent || screenIntent) {
      result = await this.env.AI.run(
        GROUNDED_VOICE_MODEL,
        fastChatInput([
          { role: 'system', content: GROUNDED_SYSTEM_PROMPT },
          ...context.messages.slice(-6).map((message) => ({ role: message.role, content: message.content })),
          { role: 'user', content: userContent },
        ], 360, 0.15),
      );
    } else {
      result = await this.env.AI.run(
        CASUAL_VOICE_MODEL,
        casualChatInput([
          { role: 'system', content: CASUAL_SYSTEM_PROMPT },
          ...context.messages.slice(-6).map((message) => ({ role: message.role, content: message.content })),
          { role: 'user', content: userContent },
        ]),
      );
    }

    const reply = cleanSpeechText(extractText(result));
    if (!reply) throw new Error('Voice LLM returned an empty response');
    try { context.connection.send(JSON.stringify({ type: 'transcript', role: 'assistant', text: reply })); } catch {}
    return reply;
  }
}

async function serveVoiceSmoke(env) {
  try {
    const audio = await new MeloJapaneseTTS(env.AI).synthesize('音声テストです。自然な日本語で応答しています。');
    if (!audio || audio.byteLength < 100) return Response.json({ ok: false, error: 'tts_empty_audio' }, { status: 500 });
    return new Response(audio, { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store', 'x-talksys-voice': 'melotts-jp-diagnostic-only' } });
  } catch (error) {
    const message = String(error?.message || error || 'unknown_tts_error').replace(/[A-Za-z0-9_\-]{32,}/g, '[redacted]').slice(0, 500);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/voice-marker-bridge.js') {
      return new Response(VOICE_MARKER_BRIDGE, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-talksys-voice-revision': VOICE_REVISION } });
    }
    if (url.pathname === '/realtime-voice.js') {
      return new Response(REALTIME_VOICE_CLIENT, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-talksys-voice-revision': VOICE_REVISION } });
    }
    if (url.pathname === '/voice-fallback.js') {
      return new Response(VOICE_FALLBACK_CLIENT, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-talksys-voice-revision': VOICE_REVISION } });
    }
    if (url.pathname === '/api/web-search' && request.method === 'GET') {
      const query = String(url.searchParams.get('q') || '').trim();
      if (!query) return Response.json({ ok: false, error: 'q is required' }, { status: 400 });
      const results = await webSearch(query, { limit: 5, timeoutMs: 2200 });
      return Response.json({ ok: true, query, results }, { headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/voice-health') {
      return Response.json({
        ok: true,
        voiceRevision: VOICE_REVISION,
        realtime: true,
        continuousAudio: true,
        binaryTurnMarkers: true,
        batchFinalStt: true,
        sttModel: '@cf/deepgram/nova-3',
        sttLanguage: 'ja',
        casualLlmModel: CASUAL_VOICE_MODEL,
        groundedLlmModel: GROUNDED_VOICE_MODEL,
        casualPrompt: 'balanced-2-4-sentences',
        casualResponseSentences: '2-4',
        llmTransport: 'env.AI.run',
        llmThinking: false,
        casualConversation: true,
        webSearch: true,
        webSearchEngine: 'wikipedia+bing-html+google-news',
        searchRelevanceFilter: true,
        groundedExternalFacts: true,
        groundedScreenClaims: true,
        screenIntentGate: true,
        assistantTranscriptCompat: true,
        connectionGreetingTts: false,
        cloudTtsDisabled: true,
        ttsPrimary: 'device-ja-JP',
        selfSpeechGuard: true,
        halfDuplexDuringDeviceTts: true,
        ttsEchoGuardMs: 350,
        bargeIn: false,
        aiScreenDecision: true,
      }, { headers: { 'cache-control': 'no-store', 'x-talksys-voice-revision': VOICE_REVISION } });
    }
    if (url.pathname === '/api/voice-smoke' && request.method === 'GET') return serveVoiceSmoke(env);

    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    const wrappedEnv = Object.assign({}, env, { AI: wrapAI(env.AI) });
    const response = await app.fetch(request, wrappedEnv, ctx);
    const type = response.headers.get('content-type') || '';
    if (response.ok && type.includes('text/html')) {
      const html = await response.text();
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      headers.set('cache-control', 'no-store');
      headers.set('x-talksys-voice-revision', VOICE_REVISION);
      return new Response(html.replace('</body>', '<script src="/voice-marker-bridge.js"></script><script src="/realtime-voice.js"></script><script src="/voice-fallback.js"></script></body>'), { status: response.status, statusText: response.statusText, headers });
    }
    return response;
  },
};
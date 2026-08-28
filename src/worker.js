import { Agent, routeAgentRequest } from 'agents';
import { withVoice } from '@cloudflare/voice';
import app from './index.js';
import { REALTIME_VOICE_CLIENT } from './realtime-voice-client.js';
import { VOICE_MARKER_BRIDGE } from './voice-marker-bridge.js';
import { VOICE_FALLBACK_CLIENT } from './voice-fallback-client.js';
import { FinalizableNova3STT, FINAL_STT_MODEL } from './finalizable-nova3.js';
import { needsWebSearch, webSearch, formatSearchContext } from './web-search.js';
import { rerankSearchResults, SEARCH_RERANK_MODEL } from './search-rerank.js';
import { streamWorkersAIText, LIVE_VOICE_MODEL } from './streaming-workers-ai.js';
import {
  TEXT_MODEL,
  extractText,
  cleanSpeechText,
  parseScreenDecision,
  MeloJapaneseTTS,
  wrapAI,
} from './voice-helpers.js';

const VOICE_REVISION = 'accurate-grounded-v12';

const CASUAL_SYSTEM_PROMPT = `日本語の自然な会話相手として答える。電話会話なので冗長にはしないが、質問・相談・雑談には原則2〜4文で答え、要点だけの一言で終わらせない。まず直接答え、その後に理由・補足・具体例のいずれかを1つ加え、会話を続ける意味があるときだけ短い質問を1つ返す。挨拶、相槌、Yes/Noだけで十分な発話は短くてよい。雑談をPC操作の話にしない。外部の事実・製品・人物・制度・技術仕様などについて検索結果が無い状態では、記憶だけで具体的な数字や現在情報を断定しない。分からない場合は作らず、確認が必要だと短く伝える。定型的な前置き、Markdown、URL読み上げは避ける。`;

const GROUNDED_SYSTEM_PROMPT = `あなたはTalkSysという日本語の音声アシスタントです。電話会話として自然に、通常2〜4文で必要な情報を省略しすぎず答えてください。
絶対ルール:
- [ウェブ検索結果] がある外部事実は、その結果だけを根拠として答える。モデルの記憶で固有名詞、数値、日付、仕様を補完しない。
- 同じ事実を複数の検索結果で確認できる場合は一致を優先する。検索結果が1件しかない場合や結果同士が食い違う場合は、断定を弱めて不確実性を明示する。
- 現在情報では新しい情報と公的・一次情報を優先する。検索結果に答えが無い場合は推測せず「確認できない」と伝える。
- 過去のassistant発言は事実の証拠にしない。
- 実際に行っていないPC操作を「開いた」「押した」「変更した」と言わない。
- 現在画面を断定できるのは [システムが取得した現在画面の情報] が今回の入力にある場合だけ。画面情報に無いボタン名、エラー、配置を作らない。
- 曖昧な場合は捏造するより短い確認質問をする。
- URLやMarkdownは読み上げない。結論だけで終わらず、根拠となる補足を1〜2点だけ添える。`;

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
    max_tokens: 240,
    temperature: 0.38,
    top_p: 0.9,
  };
}

function groundedChatInput(messages) {
  return {
    messages,
    max_tokens: 440,
    temperature: 0.12,
    top_p: 0.88,
  };
}

function normalizedSpeech(value) {
  return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function looksLikeAssistantEcho(transcript, assistantText) {
  const heard = normalizedSpeech(transcript);
  const spoken = normalizedSpeech(assistantText);
  if (heard.length < 7 || spoken.length < 12) return false;
  if (spoken.includes(heard)) return true;
  const grams = new Set();
  for (let i = 0; i < heard.length - 1; i += 1) grams.add(heard.slice(i, i + 2));
  if (!grams.size) return false;
  let overlap = 0;
  for (const gram of grams) if (spoken.includes(gram)) overlap += 1;
  return overlap / grams.size >= 0.82;
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

function announceSearchWait(connection) {
  const streamId = `search-wait-${crypto.randomUUID()}`;
  const text = 'ちょっと調べますね。';
  try { connection.send(JSON.stringify({ type: 'assistant_stream_start', streamId, transient: true })); } catch {}
  try { connection.send(JSON.stringify({ type: 'assistant_speech_chunk', streamId, sequence: 0, text, transient: true })); } catch {}
  try { connection.send(JSON.stringify({ type: 'assistant_stream_end', streamId, text, transient: true })); } catch {}
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
    serverSilenceFallbackMs: 950,
    maxTurnMs: 30000,
    preRollFrames: 6,
    minSpeechMs: 140,
    beamSize: 5,
  });
}

export class TalkSysVoiceAgent extends VoiceAgentBase {
  tts = new MeloJapaneseTTS(this.env.AI);
  screenWaiters = new Map();
  currentAssistantText = '';
  lastAssistantText = '';
  assistantSpeechAt = 0;

  createTranscriber() {
    return createJapaneseTranscriber(this.env.AI);
  }

  beforeSynthesize() {
    return null;
  }

  afterTranscribe(transcript) {
    const text = String(transcript || '').trim();
    if (!text || /^[えーあーうーん\s。、]+$/u.test(text)) return null;
    const recentAssistant = this.currentAssistantText || this.lastAssistantText;
    if (Date.now() - this.assistantSpeechAt < 12000 && looksLikeAssistantEcho(text, recentAssistant)) return null;
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
      announceSearchWait(context.connection);
      try { context.connection.send(JSON.stringify({ type: 'search_status', phase: 'searching', searched: true, waitPhrase: 'ちょっと調べますね。' })); } catch {}
      const rawResults = await webSearch(transcript, { limit: 8, timeoutMs: 2600 });
      const results = await rerankSearchResults(this.env.AI, transcript, rawResults, 5);
      searchContext = formatSearchContext(results) || '有効な検索結果なし。外部事実は推測しないこと。';
      try {
        context.connection.send(JSON.stringify({
          type: 'search_status',
          phase: 'done',
          searched: true,
          resultCount: results.length,
          reranked: rawResults.length > 1,
          sources: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url, engine: item.engine || '' })),
        }));
      } catch {}
    }

    let userContent = transcript;
    if (screenContext) userContent += `\n\n[システムが取得した現在画面の情報]\n${screenContext}`;
    if (searchIntent) userContent += `\n\n[ウェブ検索結果]\n${searchContext}`;

    const prompt = searchIntent || screenIntent ? GROUNDED_SYSTEM_PROMPT : CASUAL_SYSTEM_PROMPT;
    const input = (searchIntent || screenIntent ? groundedChatInput : casualChatInput)([
      { role: 'system', content: prompt },
      ...context.messages.slice(-8).map((message) => ({ role: message.role, content: message.content })),
      { role: 'user', content: userContent },
    ]);

    const streamId = crypto.randomUUID();
    this.currentAssistantText = '';
    this.assistantSpeechAt = Date.now();
    try { context.connection.send(JSON.stringify({ type: 'assistant_stream_start', streamId })); } catch {}

    let resultText;
    try {
      resultText = await streamWorkersAIText(this.env.AI, LIVE_VOICE_MODEL, input, {
        signal: context.signal,
        onDelta: (_delta, full) => {
          this.currentAssistantText = full;
        },
        onSpeechChunk: (chunk, sequence) => {
          const spoken = cleanSpeechText(chunk);
          if (!spoken) return;
          try {
            context.connection.send(JSON.stringify({
              type: 'assistant_speech_chunk',
              streamId,
              sequence,
              text: spoken,
            }));
          } catch {}
        },
      });
    } catch (error) {
      this.currentAssistantText = '';
      try { context.connection.send(JSON.stringify({ type: 'assistant_stream_end', streamId, interrupted: true })); } catch {}
      throw error;
    }

    const reply = cleanSpeechText(resultText);
    if (!reply) throw new Error('Voice LLM returned an empty response');
    this.lastAssistantText = reply;
    this.currentAssistantText = '';
    this.assistantSpeechAt = Date.now();
    try { context.connection.send(JSON.stringify({ type: 'assistant_stream_end', streamId, text: reply })); } catch {}
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

async function serveGeminiLiveToken(env) {
  if (!env.GEMINI_API_KEY) {
    return Response.json({ available: false, reason: 'GEMINI_API_KEY_not_configured' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
  const now = Date.now();
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      uses: 1,
      expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
      newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
      liveConnectConstraints: {
        model: 'models/gemini-3.1-flash-live-preview',
        config: {
          sessionResumption: {},
          responseModalities: ['AUDIO'],
        },
      },
    }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    return Response.json({ available: false, reason: 'gemini_token_failed', detail }, { status: 502, headers: { 'cache-control': 'no-store' } });
  }
  const token = await response.json();
  return Response.json({
    available: true,
    token: token.name,
    model: 'gemini-3.1-flash-live-preview',
    endpoint: 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained',
  }, { headers: { 'cache-control': 'no-store' } });
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
    if (url.pathname === '/api/gemini-live-token' && request.method === 'POST') return serveGeminiLiveToken(env);
    if (url.pathname === '/api/web-search' && request.method === 'GET') {
      const query = String(url.searchParams.get('q') || '').trim();
      if (!query) return Response.json({ ok: false, error: 'q is required' }, { status: 400 });
      const rawResults = await webSearch(query, { limit: 8, timeoutMs: 2800 });
      const results = await rerankSearchResults(env.AI, query, rawResults, 5);
      return Response.json({ ok: true, query, reranked: rawResults.length > 1, results }, { headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/voice-health') {
      return Response.json({
        ok: true,
        voiceRevision: VOICE_REVISION,
        realtime: true,
        continuousAudio: true,
        binaryTurnMarkers: true,
        batchFinalStt: true,
        sttModel: FINAL_STT_MODEL,
        sttLanguage: 'ja',
        sttVadFilter: true,
        sttBeamSize: 5,
        sttConditionOnPreviousText: false,
        liveLlmModel: LIVE_VOICE_MODEL,
        llmStreaming: true,
        incrementalSpeechChunks: true,
        casualResponseSentences: '2-4',
        llmTransport: 'env.AI.run-stream',
        casualConversation: true,
        webSearch: true,
        webSearchPolicy: 'knowledge-questions-default-search',
        webSearchEngine: 'wikipedia+bing-html+google-news',
        searchRelevanceFilter: true,
        searchReranker: SEARCH_RERANK_MODEL,
        searchWaitSpeech: true,
        groundedExternalFacts: true,
        groundedScreenClaims: true,
        screenIntentGate: true,
        assistantTranscriptCompat: true,
        connectionGreetingTts: false,
        cloudTtsDisabled: true,
        ttsPrimary: 'device-ja-JP-streamed-chunks',
        selfSpeechGuard: true,
        echoTranscriptFilter: true,
        halfDuplexDuringDeviceTts: false,
        ttsEchoGuardMs: 160,
        bargeIn: true,
        geminiLivePreferredWhenConfigured: true,
        geminiLiveConfigured: Boolean(env.GEMINI_API_KEY),
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
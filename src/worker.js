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

const VOICE_REVISION = 'grounded-search-v7';
const CASUAL_VOICE_MODEL = '@cf/zai-org/glm-4.7-flash';
const GROUNDED_VOICE_MODEL = '@cf/qwen/qwen3.8-27b';

const VOICE_SYSTEM_PROMPT = `あなたはTalkSysという日本語の音声アシスタントです。

会話の基本:
- 普通の日常会話、雑談、相談、挨拶には、普通の会話相手として自然に応じる。何でもPC操作の話に結び付けない。
- 電話で話しているように短く自然に返す。通常は1〜3文。必要なら会話を続ける短い質問を1つだけ返してよい。
- 「承知しました」「お手伝いします」などの定型句を毎回つけない。
- Markdown、箇条書き記号、URLなど、耳で聞き取りにくい表現は避ける。
- ユーザーが言い直したり途中で割り込んだ場合は、新しい発話を優先する。

事実性の絶対ルール:
- 知らない事実、現在の外部情報、ユーザーの個人情報を推測して作らない。
- 過去のassistant発言は事実の証拠として扱わない。
- [ウェブ検索結果] がある場合、現在の出来事、人物、価格、日程、制度、仕様など外部事実は検索結果に書かれた範囲だけで答える。検索結果に無い内容を補完しない。
- [ウェブ検索結果] が「有効な結果なし」の場合、現在情報を推測せず、確認できなかったと短く伝える。
- 検索結果が食い違う場合は断定せず、その旨を言う。必要なら情報源のサイト名だけ短く伝える。URLは読み上げない。
- 実際に行っていないPC操作を「開きました」「押しました」「変更しました」などと断定しない。
- 現在のPC画面について、[システムが取得した現在画面の情報] が今回の入力に存在する場合だけ「見えている」「表示されている」「ここにある」と断定してよい。
- 画面情報が無い場合は、画面内容を想像しない。必要なら「画面を確認すれば案内できる」とだけ言う。
- 曖昧な依頼で事実を補完するくらいなら、短い確認質問をする。

PC支援:
- 画面確認結果が与えられた場合は、その結果だけを根拠に具体的に案内する。
- 画面確認結果に無いボタン名、エラー、配置を勝手に補わない。

目的は、電話AIとして自然に会話しつつ、外部事実は検索、PC操作は実画面という観測済み情報だけを使うこと。`;

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

async function decideScreen(ai, transcript, history, signal) {
  const recent = Array.isArray(history)
    ? history.slice(-4).map((item) => `${item.role}: ${item.content}`).join('\n')
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
  if (!screen || screen.available !== true) {
    return '画面確認は利用できませんでした。';
  }
  const result = screen.result || {};
  if (result.found) {
    return `画面確認結果: 対象「${String(result.label || '対象').slice(0, 160)}」を検出。位置は正規化座標 x=${Number(result.x) || 0}, y=${Number(result.y) || 0}。補足: ${String(result.note || '').slice(0, 300)}`;
  }
  return `画面確認結果: 指定対象は特定できませんでした。補足: ${String(result.note || '').slice(0, 300)}`;
}

const VoiceAgentBase = withVoice(Agent, {
  historyLimit: 20,
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
    serverSilenceFallbackMs: 1100,
    maxTurnMs: 30000,
    preRollFrames: 6,
    minSpeechMs: 160,
  });
}

export class TalkSysVoiceAgent extends VoiceAgentBase {
  // withVoice requires a TTS provider property, but browser/device ja-JP TTS is the
  // production speech path. beforeSynthesize() returns null so cloud TTS is skipped.
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
    // Do not synthesize a greeting. The client is already connected and can enter
    // listening immediately, avoiding a slow/failed TTS call at call startup.
  }

  onMessage(connection, message) {
    if (typeof message !== 'string') return;
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
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
      const timer = setTimeout(
        () => finish({ type: 'screen_result', id, available: false, error: 'timeout' }),
        5000,
      );
      this.screenWaiters.set(id, { connectionId: connection.id, finish });
      if (signal) {
        signal.addEventListener(
          'abort',
          () => finish({ type: 'screen_result', id, available: false, error: 'aborted' }),
          { once: true },
        );
      }
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
          const screen = await this.requestScreen(
            context.connection,
            decision.query || transcript,
            context.signal,
          );
          screenContext = formatScreenContext(screen);
        }
      } catch {
        screenContext = '';
      }
    } else if (searchIntent) {
      const results = await webSearch(transcript, { limit: 5, timeoutMs: 2300 });
      searchContext = formatSearchContext(results) || '有効な結果なし。現在情報は推測しないこと。';
      try {
        context.connection.send(JSON.stringify({
          type: 'search_status',
          searched: true,
          resultCount: results.length,
          sources: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
        }));
      } catch {}
    }

    let userContent = transcript;
    if (screenContext) {
      userContent += `\n\n[システムが取得した現在画面の情報]\n${screenContext}`;
    }
    if (searchIntent) {
      userContent += `\n\n[ウェブ検索結果]\n${searchContext}`;
    }

    const model = searchIntent ? GROUNDED_VOICE_MODEL : CASUAL_VOICE_MODEL;
    const result = await this.env.AI.run(
      model,
      fastChatInput([
        { role: 'system', content: VOICE_SYSTEM_PROMPT },
        ...context.messages.slice(-10).map((message) => ({
          role: message.role,
          content: message.content,
        })),
        { role: 'user', content: userContent },
      ], searchIntent ? 360 : 220, searchIntent ? 0.2 : 0.55),
    );
    const reply = cleanSpeechText(extractText(result));
    if (!reply) throw new Error('Voice LLM returned an empty response');

    try {
      context.connection.send(JSON.stringify({
        type: 'transcript',
        role: 'assistant',
        text: reply,
      }));
    } catch {}

    return reply;
  }
}

async function serveVoiceSmoke(env) {
  try {
    const audio = await new MeloJapaneseTTS(env.AI).synthesize('音声テストです。自然な日本語で応答しています。');
    if (!audio || audio.byteLength < 100) {
      return Response.json({ ok: false, error: 'tts_empty_audio' }, { status: 500 });
    }
    return new Response(audio, {
      headers: {
        'content-type': 'audio/mpeg',
        'cache-control': 'no-store',
        'x-talksys-voice': 'melotts-jp-diagnostic-only',
      },
    });
  } catch (error) {
    const message = String(error?.message || error || 'unknown_tts_error')
      .replace(/[A-Za-z0-9_\-]{32,}/g, '[redacted]')
      .slice(0, 500);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/voice-marker-bridge.js') {
      return new Response(VOICE_MARKER_BRIDGE, {
        headers: {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
          'x-talksys-voice-revision': VOICE_REVISION,
        },
      });
    }

    if (url.pathname === '/realtime-voice.js') {
      return new Response(REALTIME_VOICE_CLIENT, {
        headers: {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
          'x-talksys-voice-revision': VOICE_REVISION,
        },
      });
    }

    if (url.pathname === '/voice-fallback.js') {
      return new Response(VOICE_FALLBACK_CLIENT, {
        headers: {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
          'x-talksys-voice-revision': VOICE_REVISION,
        },
      });
    }

    if (url.pathname === '/api/web-search' && request.method === 'GET') {
      const query = String(url.searchParams.get('q') || '').trim();
      if (!query) return Response.json({ ok: false, error: 'q is required' }, { status: 400 });
      const results = await webSearch(query, { limit: 5, timeoutMs: 3000 });
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
        llmTransport: 'env.AI.run',
        llmThinking: false,
        casualConversation: true,
        webSearch: true,
        webSearchEngine: 'bing-rss',
        groundedExternalFacts: true,
        groundedScreenClaims: true,
        screenIntentGate: true,
        assistantTranscriptCompat: true,
        connectionGreetingTts: false,
        cloudTtsDisabled: true,
        ttsPrimary: 'device-ja-JP',
        bargeIn: true,
        aiScreenDecision: true,
      }, {
        headers: {
          'cache-control': 'no-store',
          'x-talksys-voice-revision': VOICE_REVISION,
        },
      });
    }

    if (url.pathname === '/api/voice-smoke' && request.method === 'GET') {
      return serveVoiceSmoke(env);
    }

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
      return new Response(
        html.replace(
          '</body>',
          '<script src="/voice-marker-bridge.js"></script><script src="/realtime-voice.js"></script><script src="/voice-fallback.js"></script></body>',
        ),
        { status: response.status, statusText: response.statusText, headers },
      );
    }
    return response;
  },
};

import { Agent, routeAgentRequest } from 'agents';
import { withVoice } from '@cloudflare/voice';
import app from './index.js';
import { REALTIME_VOICE_CLIENT } from './realtime-voice-client.js';
import { VOICE_MARKER_BRIDGE } from './voice-marker-bridge.js';
import { FinalizableNova3STT } from './finalizable-nova3.js';
import {
  TEXT_MODEL,
  extractText,
  cleanSpeechText,
  parseScreenDecision,
  MeloJapaneseTTS,
  wrapAI,
} from './voice-helpers.js';

const VOICE_REVISION = 'direct-binding-v5';

const VOICE_SYSTEM_PROMPT = `あなたはTalkSysという日本語の音声アシスタントです。電話で人と会話しているように、短く、自然に、テンポよく話してください。
- 原則1〜3文で答える。長い説明は求められた時だけ行う。
- Markdown、箇条書き記号、URLの読み上げは避け、耳で理解しやすい文章にする。
- ユーザーが言い直したり途中で割り込んだ場合は、新しい発話を優先する。
- 不必要な前置きや「承知しました」の連発を避ける。
- 画面確認結果が与えられた場合は、その事実を使って具体的に案内する。
- 画面確認が必要なのに利用できない場合だけ、画面共有が必要だと一度だけ簡潔に伝える。
これは電話AIとパソコン作業支援AIの実験系であり、会話の自然さと即応性を優先する。`;

const SCREEN_INTENT_RE = /(画面|ウィンドウ|ボタン|アイコン|メニュー|タブ|クリック|押して|押す|開いて|開きたい|どこ|エラー表示|表示され|見えて|矢印|指して|デスクトップ|ブラウザ|設定画面)/i;

function mightNeedScreen(transcript) {
  return SCREEN_INTENT_RE.test(String(transcript || ''));
}

function fastChatInput(messages, maxCompletionTokens = 320, temperature = 0.25) {
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
        content: 'ユーザーの依頼に答えるため、現在のPC画面を実際に見る必要があるか判定してください。一般知識、雑談、文章作成、単純質問ではfalse。現在表示中のボタン・アイコン・エラー・ウィンドウ・操作場所・画面状態を確認しないと正確に答えられない場合だけtrue。JSON以外を返さない。形式: {"inspect":true|false,"query":"画面上で確認すべき対象を短く"}',
      },
      {
        role: 'user',
        content: `直近の会話:\n${recent || '(なし)'}\n\n今回の発話:\n${transcript}`,
      },
    ], 128, 0),
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
  historyLimit: 24,
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
    serverSilenceFallbackMs: 1400,
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

  beforeSynthesize(text) {
    const cleaned = cleanSpeechText(text);
    return cleaned || null;
  }

  afterTranscribe(transcript) {
    const text = String(transcript || '').trim();
    if (!text || /^[えーあーうーん\s。、]+$/u.test(text)) return null;
    return text;
  }

  async onCallStart(connection) {
    try {
      await this.speak(connection, 'はい、TalkSysです。どうぞ。');
    } catch {
      // TTS障害で通話/STTまで巻き添えにしない。
    }
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
        6500,
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
    let screenContext = '';
    if (mightNeedScreen(transcript)) {
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
    }

    const userContent = screenContext
      ? `${transcript}\n\n[システムが取得した現在画面の情報]\n${screenContext}`
      : transcript;
    const result = await this.env.AI.run(
      TEXT_MODEL,
      fastChatInput([
        { role: 'system', content: VOICE_SYSTEM_PROMPT },
        ...context.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        { role: 'user', content: userContent },
      ], 512, 0.35),
    );
    const reply = cleanSpeechText(extractText(result));
    if (!reply) throw new Error('Voice LLM returned an empty response');

    // Existing TalkSys clients consume the complete `transcript` event.
    // Cloudflare Voice emits assistant streaming events during an active call,
    // so mirror the finalized reply in the complete format as a compatibility path.
    try {
      context.connection.send(JSON.stringify({
        type: 'transcript',
        role: 'assistant',
        text: reply,
      }));
    } catch {
      // The Voice mixin still owns the normal streaming transcript/TTS pipeline.
    }

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
        'x-talksys-voice': 'melotts-jp',
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
        llmTransport: 'env.AI.run',
        llmStreaming: false,
        llmThinking: false,
        screenIntentGate: true,
        assistantTranscriptCompat: true,
        bargeIn: true,
        aiScreenDecision: true,
        japaneseTts: true,
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
          '<script src="/voice-marker-bridge.js"></script><script src="/realtime-voice.js"></script></body>',
        ),
        { status: response.status, statusText: response.statusText, headers },
      );
    }
    return response;
  },
};
import { Agent, routeAgentRequest } from 'agents';
import { withVoice, WorkersAINova3STT } from '@cloudflare/voice';
import { streamText } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import app from './index.js';
import { REALTIME_VOICE_CLIENT } from './realtime-voice-client.js';

const LEGACY_TEXT_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
const LEGACY_VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const TEXT_MODEL = '@cf/zai-org/glm-4.7-flash';
const VISION_MODEL = '@cf/google/gemma-4-26b-a4b-it';
const JAPANESE_TTS_MODEL = '@cf/myshell-ai/melotts';

const VOICE_SYSTEM_PROMPT = `あなたはTalkSysという日本語の音声アシスタントです。電話で人と会話しているように、短く、自然に、テンポよく話してください。
- 原則1〜3文で答える。長い説明は求められた時だけ行う。
- Markdown、箇条書き記号、URLの読み上げは避け、耳で理解しやすい文章にする。
- ユーザーが言い直したり途中で割り込んだ場合は、新しい発話を優先する。
- 不必要な前置きや「承知しました」の連発を避ける。
- 画面確認結果が与えられた場合は、その事実を使って具体的に案内する。
- 画面確認が必要なのに利用できない場合だけ、画面共有が必要だと一度だけ簡潔に伝える。
これは電話AIとパソコン作業支援AIの実験系であり、会話の自然さと即応性を優先する。`;

function extractText(value, depth = 0) {
  if (depth > 6 || value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = extractText(item, depth + 1);
      if (text) return text;
    }
    return '';
  }
  if (typeof value !== 'object') return '';

  const candidates = [
    value.response,
    value.choices?.[0]?.message?.content,
    value.choices?.[0]?.text,
    value.result,
    value.output_text,
    value.output,
    value.message?.content,
    value.content,
    value.text,
  ];
  for (const candidate of candidates) {
    if (candidate === value) continue;
    const text = extractText(candidate, depth + 1);
    if (text) return text;
  }
  return '';
}

function cleanSpeechText(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, 'コード部分は画面で確認してください。')
    .replace(/https?:\/\/\S+/g, 'リンク')
    .replace(/[*_#>`~]/g, '')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseScreenDecision(text) {
  if (typeof text !== 'string') return { inspect: false, query: '' };
  const match = text.match(/\{[\s\S]*?\}/);
  if (!match) return { inspect: false, query: '' };
  try {
    const parsed = JSON.parse(match[0]);
    return {
      inspect: parsed.inspect === true,
      query: typeof parsed.query === 'string' ? parsed.query.trim().slice(0, 300) : '',
    };
  } catch {
    return { inspect: false, query: '' };
  }
}

async function decideScreen(ai, transcript, history, signal) {
  const recent = Array.isArray(history)
    ? history.slice(-4).map((item) => `${item.role}: ${item.content}`).join('\n')
    : '';
  const result = await ai.run(TEXT_MODEL, {
    messages: [
      {
        role: 'system',
        content: 'ユーザーの依頼に答えるため、現在のPC画面を実際に見る必要があるか判定してください。一般知識、雑談、文章作成、単純質問ではfalse。現在表示中のボタン・アイコン・エラー・ウィンドウ・操作場所・画面状態を確認しないと正確に答えられない場合だけtrue。JSON以外を返さない。形式: {"inspect":true|false,"query":"画面上で確認すべき対象を短く"}',
      },
      {
        role: 'user',
        content: `直近の会話:\n${recent || '(なし)'}\n\n今回の発話:\n${transcript}`,
      },
    ],
    max_tokens: 100,
    temperature: 0,
  }, signal ? { signal } : undefined);
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

class MeloJapaneseTTS {
  constructor(ai) {
    this.ai = ai;
  }

  async synthesize(text, signal) {
    const spoken = cleanSpeechText(text);
    if (!spoken) return null;
    const response = await this.ai.run(
      JAPANESE_TTS_MODEL,
      { prompt: spoken, lang: 'JP' },
      { returnRawResponse: true, ...(signal ? { signal } : {}) },
    );
    if (!(response instanceof Response) || !response.ok) return null;
    return response.arrayBuffer();
  }
}

const VoiceAgentBase = withVoice(Agent, {
  historyLimit: 24,
  audioFormat: 'mp3',
  maxMessageCount: 500,
  diagnostics: { browserConsole: false },
});

export class TalkSysVoiceAgent extends VoiceAgentBase {
  transcriber = new WorkersAINova3STT(this.env.AI, {
    language: 'ja',
    endpointingMs: 220,
    utteranceEndMs: 650,
    smartFormat: true,
    punctuate: true,
    keyterms: ['TalkSys', 'Cloudflare', 'Windows', 'パソコン'],
    sampleRate: 16000,
  });

  tts = new MeloJapaneseTTS(this.env.AI);
  screenWaiters = new Map();

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
    await this.speak(connection, 'はい、TalkSysです。どうぞ。');
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

    const workersAI = createWorkersAI({ binding: this.env.AI });
    const userContent = screenContext
      ? `${transcript}\n\n[システムが取得した現在画面の情報]\n${screenContext}`
      : transcript;
    const result = streamText({
      model: workersAI(TEXT_MODEL, { sessionAffinity: this.sessionAffinity }),
      system: VOICE_SYSTEM_PROMPT,
      messages: [
        ...context.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        { role: 'user', content: userContent },
      ],
      abortSignal: context.signal,
    });
    return result.fullStream;
  }
}

function wrapAI(ai) {
  return {
    async run(model, input) {
      const isVision = model === LEGACY_VISION_MODEL;
      const targetModel = model === LEGACY_TEXT_MODEL
        ? TEXT_MODEL
        : isVision
          ? VISION_MODEL
          : model;
      const targetInput = isVision
        ? {
            ...input,
            max_tokens: Math.max(512, Number(input?.max_tokens) || 0),
            chat_template_kwargs: {
              ...(input?.chat_template_kwargs || {}),
              enable_thinking: false,
            },
          }
        : input;
      const result = await ai.run(targetModel, targetInput);
      const response = extractText(result);
      return response ? { ...result, response } : result;
    },
  };
}

async function serveVoiceSmoke(env) {
  const audio = await new MeloJapaneseTTS(env.AI).synthesize('音声テストです。自然な日本語で応答しています。');
  if (!audio || audio.byteLength < 100) {
    return Response.json({ ok: false, error: 'tts_failed' }, { status: 500 });
  }
  return new Response(audio, {
    headers: {
      'content-type': 'audio/mpeg',
      'cache-control': 'no-store',
      'x-talksys-voice': 'melotts-jp',
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/realtime-voice.js') {
      return new Response(REALTIME_VOICE_CLIENT, {
        headers: {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
        },
      });
    }

    if (url.pathname === '/voice-health') {
      return Response.json({
        ok: true,
        realtime: true,
        continuousStt: true,
        bargeIn: true,
        aiScreenDecision: true,
        japaneseTts: true,
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
      return new Response(
        html.replace('</body>', '<script src="/realtime-voice.js"></script></body>'),
        { status: response.status, statusText: response.statusText, headers },
      );
    }
    return response;
  },
};

export {
  extractText,
  wrapAI,
  cleanSpeechText,
  parseScreenDecision,
  MeloJapaneseTTS,
  TEXT_MODEL,
  VISION_MODEL,
  JAPANESE_TTS_MODEL,
};

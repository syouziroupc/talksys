import { Agent, routeAgentRequest } from 'agents';
import { withVoice } from '@cloudflare/voice';
import app from './index.js';
import { CLOUDFLARE_LIVE_CLIENT } from './cloudflare-live-client.js';
import {
  CloudflareJapaneseSTT,
  REALTIME_STT_MODEL,
  ACCURATE_STT_MODEL,
  RESOLVER_MODEL,
} from './cloudflare-japanese-stt.js';
import { CloudflareJapaneseTTS, PRIMARY_TTS_MODEL } from './cloudflare-japanese-tts.js';
import {
  PRIMARY_CONVERSATION_MODEL,
  FALLBACK_CONVERSATION_MODEL,
  streamCloudflareConversation,
  answerWithCloudflareWebSearch,
} from './cloudflare-llm.js';
import { needsWebSearch } from './web-search.js';
import { cleanSpeechText, extractText, wrapAI } from './voice-helpers.js';

const VOICE_REVISION = 'cloudflare-live-v14.1';

const CASUAL_SYSTEM_PROMPT = `あなたはTalkSysという日本語のリアルタイム音声アシスタントです。
自然な日常会話として答えてください。通常は2〜5文。最初の1文で直接答え、その後に役立つ理由・補足・具体例を1〜3点だけ足してください。
単なる相槌や挨拶は短くて構いません。相手の言い方を不自然に言い直したり、何でもPC操作へ結び付けたりしないでください。
モデルの記憶だけで現在情報、価格、人物、法律、製品仕様、医療・技術上の具体的事実を断定しないでください。その種の質問は検索経路へ送られる前提です。
知らない事実は作らず、不明なら不明と短く言ってください。実行していない操作を「やった」と言わないでください。
電話会話なのでMarkdown、長い箇条書き、URLの読み上げ、定型的な前置きは避けてください。`;

const GROUNDED_SYSTEM_PROMPT = `あなたはTalkSysという日本語のリアルタイム音声アシスタントです。
この回答は外部事実の確認が必要です。今回取得したWebページ本文と検索結果だけを根拠にし、モデルの記憶で固有名詞・数値・日付・価格・法律・仕様を補完しないでください。
現在情報では新しい情報と公的・一次情報を優先してください。複数ソースが食い違う場合はその不確実性を伝え、確認できなければ推測せず「確認できない」と答えてください。
回答は日本語で通常2〜5文。最初に結論、その後に重要な根拠を1〜3点。URLそのものは読み上げないでください。`;

const SCREEN_SYSTEM_PROMPT = `あなたはTalkSysという日本語のPC操作支援アシスタントです。
今回渡された[現在画面の確認結果]だけを根拠に画面について答えてください。画面情報に無いボタン名、文字、エラー、位置を作らないでください。
対象が特定できない場合は断定せず、画面共有や追加確認を求めてください。通常2〜4文で簡潔に案内してください。`;

const SCREEN_INTENT_RE = /(画面|ウィンドウ|ボタン|アイコン|メニュー|タブ|クリック|タップ|押して|押す|開いて|どこにある|どのボタン|エラー表示|表示され|見えて|矢印|指して|デスクトップ|ブラウザ|設定画面)/i;

function mightNeedScreen(text) {
  return SCREEN_INTENT_RE.test(String(text || ''));
}

function normalizedSpeech(value) {
  return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function looksLikeAssistantEcho(transcript, assistantText) {
  const heard = normalizedSpeech(transcript);
  const spoken = normalizedSpeech(assistantText);
  if (heard.length < 6 || spoken.length < 10) return false;
  if (spoken.includes(heard)) return true;
  const grams = new Set();
  for (let i = 0; i < heard.length - 1; i += 1) grams.add(heard.slice(i, i + 2));
  if (!grams.size) return false;
  let overlap = 0;
  for (const gram of grams) if (spoken.includes(gram)) overlap += 1;
  return overlap / grams.size >= 0.82;
}

function formatScreenContext(screen) {
  if (!screen?.available) return '現在画面は取得できませんでした。';
  const result = screen.result || {};
  if (!result.found) return `対象は特定できませんでした。補足: ${String(result.note || '').slice(0, 300)}`;
  return `対象「${String(result.label || '対象').slice(0, 160)}」を検出。位置 x=${Number(result.x) || 0}, y=${Number(result.y) || 0}。補足: ${String(result.note || '').slice(0, 300)}`;
}

const VoiceAgentBase = withVoice(Agent, {
  historyLimit: 32,
  audioFormat: 'mp3',
  maxMessageCount: 1000,
  diagnostics: { browserConsole: false },
});

export class TalkSysVoiceAgent extends VoiceAgentBase {
  tts = new CloudflareJapaneseTTS(this.env.AI);
  screenWaiters = new Map();
  currentAssistantText = '';
  lastAssistantText = '';
  assistantSpeechAt = 0;

  createTranscriber() {
    return new CloudflareJapaneseSTT(this.env.AI, {
      language: 'ja',
      sampleRate: 16000,
      endpointingMs: 400,
      utteranceEndMs: 850,
      silenceMs: 520,
      minSpeechMs: 160,
      maxTurnMs: 30000,
      preRollFrames: 7,
      contextProvider: () => this.getConversationHistory(),
    });
  }

  beforeSynthesize(text) {
    const spoken = cleanSpeechText(text);
    return spoken || null;
  }

  afterTranscribe(transcript) {
    const text = String(transcript || '').trim();
    if (!text || /^[えーあーうーんんー\s。、]+$/u.test(text)) return null;
    const assistant = this.currentAssistantText || this.lastAssistantText;
    if (Date.now() - this.assistantSpeechAt < 14000 && looksLikeAssistantEcho(text, assistant)) return null;
    return text;
  }

  onCallStart() {
    // No greeting: the connection becomes ready to listen immediately.
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
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.screenWaiters.delete(id);
        resolve(value);
      };
      const timer = setTimeout(() => finish({ available: false, error: 'timeout' }), 4500);
      this.screenWaiters.set(id, { connectionId: connection.id, finish });
      if (signal) signal.addEventListener('abort', () => finish({ available: false, error: 'aborted' }), { once: true });
      connection.send(JSON.stringify({ type: 'screen_request', id, query }));
    });
  }

  trackAssistant(iterable) {
    const self = this;
    return (async function* () {
      self.currentAssistantText = '';
      self.assistantSpeechAt = Date.now();
      try {
        for await (const delta of iterable) {
          const value = String(delta || '');
          if (!value) continue;
          self.currentAssistantText += value;
          yield value;
        }
      } finally {
        const clean = cleanSpeechText(self.currentAssistantText);
        if (clean) self.lastAssistantText = clean;
        self.currentAssistantText = '';
        self.assistantSpeechAt = Date.now();
      }
    })();
  }

  searchResponse(transcript, context) {
    const self = this;
    return this.trackAssistant((async function* () {
      try { context.connection.send(JSON.stringify({ type: 'search_status', phase: 'searching', searched: true })); } catch {}
      // The Voice pipeline starts sentence TTS as soon as this first sentence is yielded,
      // while the web retrieval below continues in parallel.
      yield 'ちょっと調べますね。';
      const result = await answerWithCloudflareWebSearch(
        self.env.AI,
        transcript,
        context.messages,
        GROUNDED_SYSTEM_PROMPT,
        { signal: context.signal },
      );
      try {
        context.connection.send(JSON.stringify({
          type: 'search_status',
          phase: 'done',
          searched: true,
          provider: result.provider,
          nativeSearch: false,
          sources: Array.isArray(result.sources) ? result.sources.map((item) => ({ title: item.title, url: item.url })) : [],
        }));
      } catch {}
      yield String(result.text || '確認できませんでした。');
    })());
  }

  async onTurn(transcript, context) {
    if (mightNeedScreen(transcript)) {
      let screen;
      try { screen = await this.requestScreen(context.connection, transcript, context.signal); }
      catch { screen = { available: false }; }
      const messages = [
        { role: 'system', content: SCREEN_SYSTEM_PROMPT },
        ...context.messages.slice(-10).map((item) => ({ role: item.role, content: item.content })),
        { role: 'user', content: `${transcript}\n\n[現在画面の確認結果]\n${formatScreenContext(screen)}` },
      ];
      return this.trackAssistant(streamCloudflareConversation(this.env.AI, messages, { signal: context.signal, maxTokens: 440 }));
    }

    if (needsWebSearch(transcript)) return this.searchResponse(transcript, context);

    const messages = [
      { role: 'system', content: CASUAL_SYSTEM_PROMPT },
      ...context.messages.slice(-12).map((item) => ({ role: item.role, content: item.content })),
      { role: 'user', content: transcript },
    ];
    return this.trackAssistant(streamCloudflareConversation(this.env.AI, messages, { signal: context.signal, maxTokens: 440 }));
  }
}

function serveScript(source) {
  return new Response(source, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
      'x-talksys-voice-revision': VOICE_REVISION,
    },
  });
}

async function modelSmoke(env) {
  const started = Date.now();
  try {
    const result = await env.AI.run(PRIMARY_CONVERSATION_MODEL, {
      messages: [
        { role: 'system', content: '日本語で簡潔に答える。' },
        { role: 'user', content: '1+1は？ 数字だけ答えて。' },
      ],
      max_tokens: 48,
      temperature: 0,
    });
    const text = extractText(result);
    return Response.json({ ok: Boolean(text), model: PRIMARY_CONVERSATION_MODEL, text, elapsedMs: Date.now() - started }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return Response.json({ ok: false, model: PRIMARY_CONVERSATION_MODEL, error: String(error?.message || error).slice(0, 400), elapsedMs: Date.now() - started }, { status: 500, headers: { 'cache-control': 'no-store' } });
  }
}

async function voiceSmoke(env) {
  try {
    const tts = new CloudflareJapaneseTTS(env.AI);
    const audio = await tts.synthesize('これは日本語の音声テストです。');
    if (!audio || audio.byteLength < 100) throw new Error('empty audio');
    return new Response(audio, {
      headers: {
        'content-type': 'audio/mpeg',
        'cache-control': 'no-store',
        'x-talksys-tts-provider': tts.preferredProvider,
        'x-talksys-voice-revision': VOICE_REVISION,
      },
    });
  } catch (error) {
    return Response.json({ ok: false, error: String(error?.message || error).slice(0, 400) }, { status: 500, headers: { 'cache-control': 'no-store' } });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/cloudflare-live.js') return serveScript(CLOUDFLARE_LIVE_CLIENT);
    if (url.pathname === '/api/model-smoke' && request.method === 'GET') return modelSmoke(env);
    if (url.pathname === '/api/voice-smoke' && request.method === 'GET') return voiceSmoke(env);
    if (url.pathname === '/voice-health') {
      return Response.json({
        ok: true,
        voiceRevision: VOICE_REVISION,
        primary: 'cloudflare-voice',
        providerApiKeysRequired: false,
        realtimeAudio: true,
        audioChunkMs: 40,
        serverTurnDetectionMs: 520,
        bargeIn: true,
        conversationPersistence: 'durable-object-sqlite',
        sharedTypedAndVoiceHistory: true,
        sttRealtime: REALTIME_STT_MODEL,
        sttAccurateFinal: ACCURATE_STT_MODEL,
        sttResolver: RESOLVER_MODEL,
        sttLanguage: 'ja',
        dualAsrReconciliation: true,
        llmPrimary: PRIMARY_CONVERSATION_MODEL,
        llmFallback: FALLBACK_CONVERSATION_MODEL,
        webSearch: 'google+duckduckgo+bing+wikipedia+google-news+page-evidence+reranker',
        searchWaitSpeech: true,
        ttsPrimary: PRIMARY_TTS_MODEL,
        serverSideTts: true,
        browserSpeechSynthesisPrimary: false,
        deviceJapaneseTtsFallback: true,
        externalProviderKeys: [],
        screenFunction: true,
      }, { headers: { 'cache-control': 'no-store', 'x-talksys-voice-revision': VOICE_REVISION } });
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
      return new Response(html.replace('</body>', '<script src="/cloudflare-live.js"></script></body>'), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    return response;
  },
};

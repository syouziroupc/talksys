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
  LIVE_CONVERSATION_MODEL,
  QUALITY_CONVERSATION_MODEL,
  GROUNDING_CONVERSATION_MODEL,
  FALLBACK_CONVERSATION_MODEL,
  streamCloudflareLiveConversation,
  streamCloudflareQualityConversation,
  answerWithCloudflareWebSearch,
  benchmarkVoiceModels,
} from './cloudflare-llm.js';
import { needsWebSearch } from './web-search.js';
import { cleanSpeechText, extractText, wrapAI } from './voice-helpers.js';

const VOICE_REVISION = 'cloudflare-live-v15.0';

const CASUAL_SYSTEM_PROMPT = `あなたはTalkSysという日本語のリアルタイム音声会話アシスタントです。
相手と電話で自然に話しているように会話してください。発話の意図を直接受け止め、最初の一文から返答を始めてください。
短い雑談や相槌は短く、相談・意見・説明は必要なだけ話してください。毎回同じ長さ、同じ型、同じ締め方にしないでください。
直前の会話で共有された話題・人物・対象・ユーザーの立場を自然に引き継ぎ、「それ」「さっきの件」のような参照を文脈から扱ってください。
相手の言葉を無意味に言い直さないでください。毎回質問で終わらせず、会話を続ける価値がある場合だけ自然な一言を返してください。
冗談、驚き、迷い、軽い感情表現は文脈に合う範囲で自然に使えますが、過剰に演技しないでください。
モデルの記憶だけで現在情報、価格、人物、法律、製品仕様、医療・技術上の具体的事実を断定しないでください。その種の質問は検索経路へ送られる前提です。
知らない事実は作らず、不明なら不明と言ってください。実行していない操作を「やった」と言わないでください。
電話会話なのでMarkdown、長い箇条書き、URLの読み上げ、定型的な前置きは避けてください。`;

const QUALITY_SYSTEM_PROMPT = `${CASUAL_SYSTEM_PROMPT}
今回は少し考える必要がある会話です。表面的な相槌だけで済ませず、論点を整理し、必要なら複数の見方を示してください。
ただし講義調に長々と話さず、電話で聞いて理解できる自然なまとまりにしてください。`;

const GROUNDED_SYSTEM_PROMPT = `あなたはTalkSysという日本語のリアルタイム音声アシスタントです。
この回答は外部事実の確認が必要です。今回取得したWebページ本文と検索結果だけを根拠にし、モデルの記憶で固有名詞・数値・日付・価格・法律・仕様を補完しないでください。
現在情報では新しい情報と公的・一次情報を優先してください。複数ソースが食い違う場合はその不確実性を伝え、確認できなければ推測せず「確認できない」と答えてください。
回答は電話で自然に聞ける日本語にしてください。最初に結論を言い、その後に重要な根拠だけを必要な量で補足してください。URLそのものは読み上げないでください。`;

const SCREEN_SYSTEM_PROMPT = `あなたはTalkSysという日本語のPC操作支援アシスタントです。
今回渡された[現在画面の確認結果]だけを根拠に画面について答えてください。画面情報に無いボタン名、文字、エラー、位置を作らないでください。
対象が特定できない場合は断定せず、画面共有や追加確認を求めてください。電話で聞き取りやすい順序で簡潔に案内してください。`;

const SCREEN_INTENT_RE = /(画面|ウィンドウ|ボタン|アイコン|メニュー|タブ|クリック|タップ|押して|押す|開いて|どこにある|どのボタン|エラー表示|表示され|見えて|矢印|指して|デスクトップ|ブラウザ|設定画面)/i;
const QUALITY_INTENT_RE = /(どう思う|どう考える|考えて|なぜ|理由|比較|どっち|どちら|相談|どうすれば|どうしたら|説明して|整理して|メリット|デメリット|可能性|戦略|設計|方針|判断|選ぶ|選択|改善|問題点|原因|将来|実現可能|おすすめ)/i;

function mightNeedScreen(text) {
  return SCREEN_INTENT_RE.test(String(text || ''));
}

function needsQualityConversation(text) {
  const value = String(text || '').trim();
  return value.length >= 52 || QUALITY_INTENT_RE.test(value);
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

function sessionAffinity(context) {
  return `talksys-${String(context?.connection?.id || 'default').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 96)}`;
}

const VoiceAgentBase = withVoice(Agent, {
  historyLimit: 48,
  audioFormat: 'mp3',
  maxMessageCount: 1200,
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
      endpointingMs: 320,
      utteranceEndMs: 720,
      silenceMs: 440,
      minSpeechMs: 140,
      maxTurnMs: 30000,
      preRollFrames: 7,
      fastFinalConfidence: 0.88,
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
    // No greeting: become ready to listen immediately.
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

  trackAssistant(iterable, context, tier) {
    const self = this;
    return (async function* () {
      self.currentAssistantText = '';
      self.assistantSpeechAt = Date.now();
      try {
        context?.connection?.send(JSON.stringify({ type: 'model_route', tier }));
      } catch {}
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
      // The Voice pipeline can synthesize this sentence while retrieval continues.
      yield 'ちょっと調べますね。';
      const result = await answerWithCloudflareWebSearch(
        self.env.AI,
        transcript,
        context.messages,
        GROUNDED_SYSTEM_PROMPT,
        {
          signal: context.signal,
          sessionAffinity: sessionAffinity(context),
        },
      );
      try {
        context.connection.send(JSON.stringify({
          type: 'search_status',
          phase: 'done',
          searched: true,
          provider: result.provider,
          model: result.model,
          nativeSearch: false,
          sources: Array.isArray(result.sources) ? result.sources.map((item) => ({ title: item.title, url: item.url })) : [],
        }));
      } catch {}
      yield String(result.text || '確認できませんでした。');
    })(), context, 'grounded');
  }

  async onTurn(transcript, context) {
    const affinity = sessionAffinity(context);

    if (mightNeedScreen(transcript)) {
      let screen;
      try { screen = await this.requestScreen(context.connection, transcript, context.signal); }
      catch { screen = { available: false }; }
      const messages = [
        { role: 'system', content: SCREEN_SYSTEM_PROMPT },
        ...context.messages.slice(-14).map((item) => ({ role: item.role, content: item.content })),
        { role: 'user', content: `${transcript}\n\n[現在画面の確認結果]\n${formatScreenContext(screen)}` },
      ];
      return this.trackAssistant(
        streamCloudflareQualityConversation(this.env.AI, messages, {
          signal: context.signal,
          maxTokens: 460,
          sessionAffinity: affinity,
        }),
        context,
        'screen-quality',
      );
    }

    if (needsWebSearch(transcript)) return this.searchResponse(transcript, context);

    const quality = needsQualityConversation(transcript);
    const messages = [
      { role: 'system', content: quality ? QUALITY_SYSTEM_PROMPT : CASUAL_SYSTEM_PROMPT },
      ...context.messages.slice(-(quality ? 18 : 16)).map((item) => ({ role: item.role, content: item.content })),
      { role: 'user', content: transcript },
    ];

    if (quality) {
      return this.trackAssistant(
        streamCloudflareQualityConversation(this.env.AI, messages, {
          signal: context.signal,
          maxTokens: 480,
          sessionAffinity: affinity,
        }),
        context,
        'quality',
      );
    }

    return this.trackAssistant(
      streamCloudflareLiveConversation(this.env.AI, messages, {
        signal: context.signal,
        maxTokens: 320,
        sessionAffinity: affinity,
      }),
      context,
      'live',
    );
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

async function smokeModel(env, model) {
  const started = Date.now();
  try {
    const result = await env.AI.run(model, {
      messages: [
        { role: 'system', content: '日本語で簡潔に答える。' },
        { role: 'user', content: '1+1は？ 数字だけ答えて。' },
      ],
      max_completion_tokens: 48,
      temperature: 0,
      stream: false,
      ...(model === LIVE_CONVERSATION_MODEL ? {
        reasoning_effort: null,
        chat_template_kwargs: { enable_thinking: false, clear_thinking: true },
      } : {}),
    });
    const text = extractText(result);
    return Response.json(
      { ok: Boolean(text), model, text, elapsedMs: Date.now() - started },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    return Response.json(
      { ok: false, model, error: String(error?.message || error).slice(0, 400), elapsedMs: Date.now() - started },
      { status: 500, headers: { 'cache-control': 'no-store' } },
    );
  }
}

async function voiceModelBench(request, env) {
  let prompt = '';
  if (request.method === 'POST') {
    try {
      const body = await request.json();
      prompt = typeof body?.prompt === 'string' ? body.prompt : '';
    } catch {}
  }
  const result = await benchmarkVoiceModels(env.AI, {
    prompt,
    sessionAffinity: `talksys-bench-${crypto.randomUUID()}`,
  });
  return Response.json(result, { headers: { 'cache-control': 'no-store' } });
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
    if (url.pathname === '/api/model-smoke' && request.method === 'GET') return smokeModel(env, LIVE_CONVERSATION_MODEL);
    if (url.pathname === '/api/quality-model-smoke' && request.method === 'GET') return smokeModel(env, QUALITY_CONVERSATION_MODEL);
    if (url.pathname === '/api/grounded-model-smoke' && request.method === 'GET') return smokeModel(env, GROUNDING_CONVERSATION_MODEL);
    if (url.pathname === '/api/voice-model-bench' && (request.method === 'GET' || request.method === 'POST')) return voiceModelBench(request, env);
    if (url.pathname === '/api/voice-smoke' && request.method === 'GET') return voiceSmoke(env);
    if (url.pathname === '/voice-health') {
      return Response.json({
        ok: true,
        voiceRevision: VOICE_REVISION,
        primary: 'cloudflare-voice',
        providerApiKeysRequired: false,
        realtimeAudio: true,
        audioChunkMs: 40,
        serverTurnDetectionMs: 440,
        bargeIn: true,
        conversationPersistence: 'durable-object-sqlite',
        sharedTypedAndVoiceHistory: true,
        promptPrefixCaching: true,
        sessionAffinity: true,
        sttRealtime: REALTIME_STT_MODEL,
        sttAccurateFinal: ACCURATE_STT_MODEL,
        sttResolver: RESOLVER_MODEL,
        sttLanguage: 'ja',
        sttHighConfidenceFastPath: true,
        sttFastFinalConfidence: 0.88,
        dualAsrReconciliation: true,
        llmLive: LIVE_CONVERSATION_MODEL,
        llmQuality: QUALITY_CONVERSATION_MODEL,
        llmGrounded: GROUNDING_CONVERSATION_MODEL,
        llmFallback: FALLBACK_CONVERSATION_MODEL,
        llmRouting: 'live-qwen / quality-glm-flash-with-qwen-fallback / grounded-gpt-oss-with-fallbacks',
        qualityModelPaidAccessOptional: true,
        modelBenchmarkEndpoint: '/api/voice-model-bench',
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

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
  GROUNDING_FALLBACK_MODEL,
  FALLBACK_CONVERSATION_MODEL,
  streamCloudflareLiveConversation,
  streamCloudflareQualityConversation,
  benchmarkVoiceModels,
} from './cloudflare-llm.js';
import { answerWithVerifiedWebSearch } from './search-answer-v18.js';
import {
  generateSearchFiller,
  SEARCH_FILLER_MODEL,
  SEARCH_TOTAL_BUDGET_MS,
  SEARCH_PLANNER_BUDGET_MS,
  SEARCH_FETCH_BUDGET_MS,
  SEARCH_COVERAGE_BUDGET_MS,
  shouldDeepSearch,
} from './search-orchestrator.js';
import {
  SESSION_STORE_MAX_MESSAGES,
  SESSION_CONTEXT_MAX_MESSAGES,
  CALLER_MEMORY_MAX_MESSAGES,
  beginCallSession,
  ensureConnectionSession,
  getSession,
  getConversationHistory,
  appendConversationTurn,
  endCallSession,
  callerMemorySlice,
  normalizeCallerIdentity,
  trustedCallerIdentity,
  setTrustedCallerIdentity,
} from './conversation-memory.js';
import { cleanSpeechText, extractText, wrapAI } from './voice-helpers.js';

const VOICE_REVISION = 'cloudflare-live-v18.6';

const CASUAL_SYSTEM_PROMPT = `あなたはTalkSysという日本語の電話相談アシスタントです。
相手と電話で自然に話しているように会話してください。発話の意図を直接受け止め、最初の一文から返答を始めてください。
同じ通話・接続の会話履歴が渡された場合は必ずその文脈を使い、「それ」「さっきの」「調べて」「どこがいい？」などの省略を自然に解決してください。ユーザーが前の回答を訂正した場合は、その訂正を最優先してください。
過去のassistant発言は会話文脈であって事実根拠ではありません。外部確認が必要な事実は検索経路に任せてください。
短い雑談や相槌は短く、相談・意見・説明は必要なだけ話してください。毎回同じ長さ、同じ型、同じ締め方にしないでください。
電話で聞き取りやすいよう、一文を短めにし、一文に一つの要点を置いてください。長い従属節、括弧の連続、記号列、表形式、長い箇条書きは避けてください。
結論がある場合は先に言い、その後に理由を1〜3点だけ補足してください。既に分かっている文脈を毎回言い直さないでください。
相手の言葉を無意味に言い直さないでください。毎回質問で終わらせず、会話を続ける価値がある場合だけ自然な一言を返してください。
現在情報、価格、店舗、人物、法律、製品仕様、ニュースなど外部確認が必要な質問は別の検索経路で処理されます。この通常会話経路で、検索していない現在情報を推測して断定しないでください。
電話相談専用です。画面共有、スクリーンショット解析、矢印オーバーレイの機能があるとは言わないでください。
Markdown、URLの読み上げ、定型的な前置きは避けてください。`;

const QUALITY_SYSTEM_PROMPT = `${CASUAL_SYSTEM_PROMPT}
今回は少し考える必要がある相談です。表面的な相槌だけで済ませず、論点を整理してください。
ただし講義調に長々と話さず、電話で一度に聞いて理解できる長さにしてください。`;

const GROUNDED_SYSTEM_PROMPT = `あなたはTalkSysという日本語の電話相談アシスタントです。
今回は外部事実をWebで調査してから答えます。正確さを優先しつつ、取得できた根拠から結論を先に答えてください。
現在の固有事実、店舗名、会社名、施設名、数値、日付、価格、在庫、営業時間、法律、現行仕様は今回取得した検索結果とWebページ本文に根拠があるものだけ使ってください。
検索根拠に出ていない店舗名・会社名・施設名を、モデルの記憶や類推で補わないでください。似た名前の店を作らないでください。
検索結果が不足している場合も、検索前に断ったり、検索責任をユーザーへ返したりしないでください。確認できた部分を具体的に答えてください。
購入先・おすすめ・比較では、確認済みの候補と一般的な選び方を明確に分けてください。価格・在庫など当日変わる情報は確認できた場合だけ言ってください。
同じ通話の文脈とユーザーの訂正を必ず引き継いでください。過去のassistant発言は事実根拠として扱わないでください。
回答は電話で自然に聞ける日本語にしてください。一文を短めにし、最初に結論、その後に重要な根拠を1〜3点だけ補足してください。URL、Markdown、長い列挙は読み上げないでください。`;

const QUALITY_INTENT_RE = /(どう思う|どう考える|考えて|なぜ|理由|比較|どっち|どちら|相談|どうすれば|どうしたら|説明して|整理して|メリット|デメリット|可能性|戦略|設計|方針|判断|選ぶ|選択|改善|問題点|原因|将来|実現可能)/i;

function needsQualityConversation(text) {
  const value = String(text || '').trim();
  return value.length >= 72 || QUALITY_INTENT_RE.test(value);
}

function quickCasualReply(text) {
  const value = String(text || '').trim().replace(/[！!。．.]+$/u, '');
  if (/^(こんにちは|こんにちわ|やあ|どうも)$/u.test(value)) return 'こんにちは。どうしました？';
  if (/^(おはよう|おはようございます)$/u.test(value)) return 'おはようございます。どうしました？';
  if (/^(こんばんは)$/u.test(value)) return 'こんばんは。どうしました？';
  if (/^(ありがとう|ありがとうございます|どうもありがとう)$/u.test(value)) return 'どういたしまして。';
  if (/^(元気|元気ですか|お元気ですか)$/u.test(value)) return '元気ですよ。ありがとうございます。';
  return '';
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

function connectionFrom(value) {
  return value?.connection || value || null;
}

function sessionAffinity(context) {
  const connection = connectionFrom(context);
  const session = getSession(connection);
  const source = session?.callerKey || session?.id || String(connection?.id || '');
  const safe = String(source).replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 96);
  return safe ? `talksys-${safe}` : '';
}

const VoiceAgentBase = withVoice(Agent, {
  // @cloudflare/voice has its own agent-wide SQLite history. TalkSys deliberately
  // disables that store so users sharing the same Agent instance can never inherit it.
  historyLimit: 0,
  maxMessageCount: 0,
  audioFormat: 'mp3',
  diagnostics: { browserConsole: false },
});

export class TalkSysVoiceAgent extends VoiceAgentBase {
  tts = new CloudflareJapaneseTTS(this.env.AI);
  voiceRuntime = new Map();
  callerMemorySchemaReady = false;

  runtimeFor(connection) {
    const key = String(connection?.id || '');
    if (!key) return { currentAssistantText: '', lastAssistantText: '', assistantSpeechAt: 0 };
    let runtime = this.voiceRuntime.get(key);
    if (!runtime) {
      runtime = { currentAssistantText: '', lastAssistantText: '', assistantSpeechAt: 0 };
      this.voiceRuntime.set(key, runtime);
    }
    return runtime;
  }

  clearRuntime(connection) {
    const key = String(connection?.id || '');
    if (key) this.voiceRuntime.delete(key);
  }

  ensureCallerMemorySchema() {
    if (this.callerMemorySchemaReady) return;
    this.sql`
      CREATE TABLE IF NOT EXISTS talksys_caller_memory (
        caller_key TEXT PRIMARY KEY,
        messages_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `;
    this.callerMemorySchemaReady = true;
  }

  loadCallerMemory(callerKey) {
    const key = normalizeCallerIdentity(callerKey);
    if (!key) return [];
    try {
      this.ensureCallerMemorySchema();
      const rows = this.sql`SELECT messages_json FROM talksys_caller_memory WHERE caller_key = ${key} LIMIT 1`;
      const raw = rows?.[0]?.messages_json;
      if (!raw) return [];
      return callerMemorySlice(JSON.parse(raw));
    } catch {
      return [];
    }
  }

  saveCallerMemory(callerKey, messages) {
    const key = normalizeCallerIdentity(callerKey);
    if (!key) return;
    try {
      this.ensureCallerMemorySchema();
      const json = JSON.stringify(callerMemorySlice(messages));
      const now = Date.now();
      this.sql`
        INSERT INTO talksys_caller_memory (caller_key, messages_json, updated_at)
        VALUES (${key}, ${json}, ${now})
        ON CONFLICT(caller_key) DO UPDATE SET
          messages_json = excluded.messages_json,
          updated_at = excluded.updated_at
      `;
    } catch {}
  }

  // Intended for a future authenticated telephony ingress. Do not bind identities
  // from arbitrary browser parameters or untrusted client messages.
  bindTrustedCallerIdentity(connection, identity) {
    return setTrustedCallerIdentity(connection, identity);
  }

  getTalkSysHistory(value) {
    return getConversationHistory(connectionFrom(value));
  }

  rememberConversationTurn(context, userText, assistantText) {
    return appendConversationTurn(connectionFrom(context), userText, assistantText);
  }

  createTranscriber(connection) {
    return new CloudflareJapaneseSTT(this.env.AI, {
      language: 'ja',
      sampleRate: 16000,
      endpointingMs: 300,
      utteranceEndMs: 650,
      silenceMs: 400,
      minSpeechMs: 140,
      maxTurnMs: 30000,
      preRollFrames: 7,
      fastFinalConfidence: 0.88,
      contextProvider: () => this.getTalkSysHistory(connection),
    });
  }

  beforeSynthesize(text) {
    const spoken = cleanSpeechText(text);
    return spoken || null;
  }

  afterTranscribe(transcript, connection) {
    const text = String(transcript || '').trim();
    if (!text || /^[えーあーうーんんー\s。、]+$/u.test(text)) return null;
    const runtime = this.runtimeFor(connection);
    const assistant = runtime.currentAssistantText || runtime.lastAssistantText;
    if (Date.now() - runtime.assistantSpeechAt < 14000 && looksLikeAssistantEcho(text, assistant)) return null;
    return text;
  }

  onCallStart(connection) {
    const callerKey = trustedCallerIdentity(connection);
    const seed = callerKey ? this.loadCallerMemory(callerKey) : [];
    beginCallSession(connection, seed);
    this.clearRuntime(connection);
  }

  onCallEnd(connection) {
    const session = endCallSession(connection);
    if (session?.callerKey) this.saveCallerMemory(session.callerKey, session.messages);
    this.clearRuntime(connection);
  }

  trackAssistant(iterable, context, tier, userText = '') {
    const self = this;
    const connection = connectionFrom(context);
    return (async function* () {
      ensureConnectionSession(connection);
      const runtime = self.runtimeFor(connection);
      runtime.currentAssistantText = '';
      runtime.assistantSpeechAt = Date.now();
      try {
        try { connection?.send(JSON.stringify({ type: 'model_route', tier })); } catch {}
        for await (const delta of iterable) {
          const value = String(delta || '');
          if (!value) continue;
          runtime.currentAssistantText += value;
          yield value;
        }
      } catch {
        if (!runtime.currentAssistantText) {
          const fallback = '応答が途中で止まりました。もう一度だけ話してください。';
          runtime.currentAssistantText = fallback;
          yield fallback;
        }
      } finally {
        const clean = cleanSpeechText(runtime.currentAssistantText);
        if (clean) runtime.lastAssistantText = clean;
        self.rememberConversationTurn(context, userText, clean);
        runtime.currentAssistantText = '';
        runtime.assistantSpeechAt = Date.now();
      }
    })();
  }

  searchResponse(transcript, context, history) {
    const self = this;
    return this.trackAssistant((async function* () {
      try { context.connection.send(JSON.stringify({ type: 'search_status', phase: 'planning', searched: true })); } catch {}

      let searchSettled = false;
      let secondProgressTimer = null;
      const searchPromise = answerWithVerifiedWebSearch(
        self.env.AI,
        transcript,
        history,
        GROUNDED_SYSTEM_PROMPT,
        {
          signal: context.signal,
          sessionAffinity: sessionAffinity(context),
        },
      ).finally(() => {
        searchSettled = true;
        if (secondProgressTimer) clearTimeout(secondProgressTimer);
      });
      const fillerPromise = generateSearchFiller(self.env.AI, transcript, history, context.signal);
      secondProgressTimer = setTimeout(() => {
        if (searchSettled || context.signal?.aborted) return;
        try {
          context.connection.send(JSON.stringify({
            type: 'search_status',
            phase: 'searching',
            searched: true,
            waitPhrase: '情報を照合しています。もう少し待ってください。',
          }));
        } catch {}
      }, 4200);

      const first = await Promise.race([
        searchPromise.then((result) => ({ type: 'result', result })),
        fillerPromise.then((text) => ({ type: 'filler', text })).catch(() => ({ type: 'filler', text: '' })),
      ]);

      let result;
      if (first.type === 'filler') {
        const filler = cleanSpeechText(first.text);
        if (filler && !context.signal?.aborted) {
          try { context.connection.send(JSON.stringify({ type: 'search_status', phase: 'searching', searched: true, waitPhrase: filler })); } catch {}
        }
        result = await searchPromise;
      } else {
        result = first.result;
      }

      try {
        context.connection.send(JSON.stringify({
          type: 'search_status',
          phase: 'done',
          searched: true,
          provider: result.provider,
          model: result.model,
          planned: Boolean(result.planned),
          resolvedQuestion: result.resolvedQuestion || transcript,
          queries: Array.isArray(result.queries) ? result.queries.slice(0, 12) : [],
          rounds: Number(result.rounds) || 1,
          evidenceUseful: Boolean(result.evidenceUseful),
          auditPassed: Boolean(result.auditPassed),
          timings: result.timings || null,
          sources: Array.isArray(result.sources) ? result.sources.slice(0, 12).map((item) => ({ title: item.title, url: item.url })) : [],
        }));
      } catch {}

      yield String(result.text || '確認できた範囲から答えます。');
    })(), context, 'verified-context-search', transcript);
  }

  async onTurn(transcript, context) {
    const connection = context?.connection;
    ensureConnectionSession(connection);
    const affinity = sessionAffinity(context);
    const history = this.getTalkSysHistory(connection);

    if (shouldDeepSearch(transcript, history)) return this.searchResponse(transcript, context, history);

    const quick = quickCasualReply(transcript);
    if (quick) {
      return this.trackAssistant((async function* () { yield quick; })(), context, 'instant-local', transcript);
    }

    const messages = [
      { role: 'system', content: needsQualityConversation(transcript) ? QUALITY_SYSTEM_PROMPT : CASUAL_SYSTEM_PROMPT },
      ...history,
      { role: 'user', content: transcript },
    ];

    if (needsQualityConversation(transcript)) {
      return this.trackAssistant(
        streamCloudflareQualityConversation(this.env.AI, messages, {
          signal: context.signal,
          maxTokens: 360,
          openTimeoutMs: 2500,
          firstTokenTimeoutMs: 2700,
          fallbackTimeoutMs: 3000,
          sessionAffinity: affinity,
        }),
        context,
        'quality-bounded',
        transcript,
      );
    }

    return this.trackAssistant(
      streamCloudflareLiveConversation(this.env.AI, messages, {
        signal: context.signal,
        maxTokens: 260,
        openTimeoutMs: 1900,
        firstTokenTimeoutMs: 2300,
        fallbackTimeoutMs: 2600,
        sessionAffinity: affinity,
      }),
      context,
      'live-fast',
      transcript,
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
    const audio = await tts.synthesize('これは日本語の音声テストです。聞き取りやすさを確認します。');
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
        mode: 'phone-consultation-only',
        providerApiKeysRequired: false,
        realtimeAudio: true,
        audioChunkMs: 40,
        serverTurnDetectionMs: 400,
        bargeIn: true,
        conversationPersistence: 'call-session-with-trusted-caller-memory',
        sessionMemoryLifecycle: 'start_call-to-end_call',
        sessionMemoryTimeBasedExpiry: false,
        sharedTypedAndVoiceHistory: true,
        crossTurnContext: true,
        crossSessionContext: 'trusted-caller-only',
        trustedCallerIdentityRequired: true,
        callerIdentityPersistence: true,
        voiceBuiltinHistoryDisabled: true,
        conversationSessionStoredMessages: SESSION_STORE_MAX_MESSAGES,
        conversationContextMaxMessages: SESSION_CONTEXT_MAX_MESSAGES,
        callerContextMaxMessages: CALLER_MEMORY_MAX_MESSAGES,
        promptPrefixCaching: true,
        sessionAffinity: true,
        sttRealtime: REALTIME_STT_MODEL,
        sttAccurateFinal: ACCURATE_STT_MODEL,
        sttResolver: RESOLVER_MODEL,
        sttLanguage: 'ja',
        sttHighConfidenceFastPath: true,
        sttFastFinalConfidence: 0.88,
        dualAsrReconciliation: true,
        sttUsesConversationContext: true,
        llmLive: LIVE_CONVERSATION_MODEL,
        llmQuality: QUALITY_CONVERSATION_MODEL,
        llmGrounded: GROUNDING_CONVERSATION_MODEL,
        llmGroundedFallback: GROUNDING_FALLBACK_MODEL,
        llmFallback: FALLBACK_CONVERSATION_MODEL,
        llmRouting: 'instant-local / bounded-live / bounded-quality / bounded-contextual-search',
        normalConversationLiveOnly: false,
        casualFastPath: true,
        qualityRouteForComplexConversation: true,
        searchPrecisionOnly: true,
        modelBenchmarkEndpoint: '/api/voice-model-bench',
        webSearch: 'bounded-parallel-contextual-multiquery+conditional-recovery+page-evidence+reranker+answer-audit',
        searchQueryPlanning: true,
        searchMultiQuery: true,
        searchMaxQueries: 8,
        searchMaxRounds: 2,
        searchDeepResearchBudgetMs: SEARCH_TOTAL_BUDGET_MS,
        searchPlannerBudgetMs: SEARCH_PLANNER_BUDGET_MS,
        searchFetchBudgetMs: SEARCH_FETCH_BUDGET_MS,
        searchCoverageBudgetMs: SEARCH_COVERAGE_BUDGET_MS,
        searchSecondProgressSpeechMs: 4200,
        searchWaitSpeech: true,
        searchFillerModel: SEARCH_FILLER_MODEL,
        searchFillerGeneratedInParallel: true,
        typedSpeechSimulation: true,
        typedSpeechVoiceOutput: true,
        callConnectTimeoutMs: 10000,
        searchAnswerAudit: true,
        ttsPrimary: PRIMARY_TTS_MODEL,
        serverSideTts: true,
        browserSpeechSynthesisPrimary: false,
        deviceJapaneseTtsFallback: true,
        speechClarityProcessing: true,
        externalProviderKeys: [],
        screenFunction: false,
        screenOverlay: false,
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

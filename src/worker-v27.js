import workerV26, { TalkSysVoiceAgent as TalkSysVoiceAgentV26 } from './worker-v26.js';
import { CLOUDFLARE_LIVE_CLIENT_V26 } from './cloudflare-live-client-v26.js';
import { SEARCH_TRACE_CLIENT_V23 } from './search-trace-client-v23.js';
import { ensureConnectionSession, recordConversationUser } from './conversation-memory.js';
import { cleanSpeechText, MeloJapaneseTTS } from './voice-helpers.js';
import {
  streamGrokConversationV27,
  GROK_CONVERSATION_MODEL_V27,
  GROK_FALLBACK_MODEL_V27,
  GROK_EMERGENCY_MODEL_V27,
} from './grok-conversation-v27.js';

const VOICE_REVISION = 'cloudflare-agent-v27-grok-conversation-android-realtime';
const PC_TOPIC_RE = /(パソコン|\bPC\b|ＰＣ|Windows|MacBook|ThinkPad|Let'?s\s*note|レッツノート|CPU|GPU|Core\s*i[3579]|Ryzen|GeForce|Radeon|メモリ|RAM|SSD|NVMe|SATA|USB[- ]?C|Thunderbolt|Wi-?Fi|Bluetooth|BIOS|UEFI)/i;
const QUALITY_INTENT_RE = /(どう考える|なぜ|理由|比較|どっち|どちら|どうすれば|どうしたら|整理して|メリット|デメリット|可能性|戦略|設計|方針|改善|問題点|原因|将来|実現可能|検討|判断)/i;

const GENERAL_PROMPT = `あなたはTalkSysという日本語のリアルタイム電話相談AIです。
会話履歴から省略された主語・対象・条件を自然に引き継いでください。既に分かっていることを聞き直さないでください。
まず質問に直接答え、通常は1〜3文にしてください。長い前置き、一般論の羅列、同じ内容の言い換えは禁止です。
正確さを優先し、判断に必要な情報だけを述べてください。難しい相談では論点を整理しますが、電話で一度に理解できる長さを維持してください。
この経路ではWeb検索していません。現在価格、在庫、営業時間、ニュース、法律、現行仕様など変化する外部事実を記憶から断定しないでください。
足りない条件が本当に必要なら、最も価値の高い質問を1つだけしてください。
URL、Markdown、内部処理は読み上げないでください。`;

const PC_PROMPT = `${GENERAL_PROMPT}
パソコン関連ではPC販売・修理の実務者に通用する精度を優先してください。
結論を最初に言い、CPU世代、RAM、SSD、端子、OS要件などは結論を左右する項目だけ具体的に使ってください。
聞かれていない寿命論、OSサポート期限、仕様一覧を勝手に付けないでください。症状相談では最も可能性が高い確認手順から示してください。`;

const GROUNDED_PROMPT = `あなたはTalkSysという日本語のリアルタイム電話相談AIです。
今回はWeb検索済みです。外部事実は今回提示された根拠に直接支えられる内容だけを使ってください。
質問への答えを最初の一文で出し、原則1〜3文、候補列挙でも4文以内です。
検索の成否、検索結果件数、検索サイト、内部処理を説明しないでください。「検索結果には記載がありません」等の検索メタ発言は禁止です。
店舗なら条件に合う実在候補を2〜3件だけ、経路なら路線・乗換・降車駅を優先してください。
根拠が弱い情報は言わず、判断不能なら追加条件を1つだけ聞いてください。URL、Markdown、根拠番号は読み上げないでください。`;

const GROUNDED_PC_PROMPT = `${GROUNDED_PROMPT}
パソコン関連では実務精度を優先し、判断を左右する2〜4項目だけ具体的に述べてください。
価格・相場・在庫・発売時期は今回の根拠にある内容だけを使ってください。`;

function connectionFrom(context) {
  return context?.connection || context || null;
}

function send(connection, payload) {
  try { connection?.send(JSON.stringify(payload)); } catch {}
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

function sessionAffinity(context) {
  const connection = connectionFrom(context);
  const source = String(connection?.id || '').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 96);
  return source ? `talksys-v27-${source}` : '';
}

function quickCasualReply(text) {
  const value = String(text || '').trim().replace(/[！!。．.]+$/u, '');
  if (/^(こんにちは|こんにちわ|やあ|どうも|もしもし)$/u.test(value)) return 'こんにちは。どのようなご相談でしょうか？';
  if (/^(おはよう|おはようございます)$/u.test(value)) return 'おはようございます。どのようなご相談でしょうか？';
  if (/^こんばんは$/u.test(value)) return 'こんばんは。どのようなご相談でしょうか？';
  if (/^(ありがとう|ありがとうございます|どうもありがとう)$/u.test(value)) return 'どういたしまして。';
  if (/^(了解|了解です|わかりました)$/u.test(value)) return '承知しました。';
  return '';
}

function nonGroundedMessages(history, transcript) {
  const pc = PC_TOPIC_RE.test(String(transcript || ''));
  return [
    { role: 'system', content: pc ? PC_PROMPT : GENERAL_PROMPT },
    ...(Array.isArray(history) ? history.slice(-14) : []),
    { role: 'user', content: transcript },
  ];
}

function evidenceMessages(history, transcript, result) {
  const pc = PC_TOPIC_RE.test(String(result?.resolvedQuestion || transcript || ''));
  const sources = Array.isArray(result?.sources) ? result.sources.slice(0, pc ? 8 : 7) : [];
  const compact = sources.map((item, index) => {
    const evidence = String(item?.excerpt || item?.snippet || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, pc ? 1000 : 800);
    return `[${index + 1}] ${String(item?.title || '').slice(0, 180)}\n${String(item?.url || '').slice(0, 600)}\n${evidence}`;
  }).join('\n\n');

  return [
    { role: 'system', content: pc ? GROUNDED_PC_PROMPT : GROUNDED_PROMPT },
    ...(Array.isArray(history) ? history.slice(-12) : []),
    {
      role: 'user',
      content: `${transcript}\n\n[今回確認したWeb根拠]\n${compact || '(根拠データなし)'}`,
    },
  ];
}

function noEvidenceReply(transcript) {
  const value = String(transcript || '');
  if (/(乗り換え|乗換|経路|行き方|電車|鉄道|駅から|駅まで|所要時間|運賃|時刻表|直通)/i.test(value)) return '何時ごろ出る予定ですか？';
  if (PC_TOPIC_RE.test(value)) return '型番か予算をもう1点だけ教えてください。';
  return '対象か条件をもう1点だけ教えてください。';
}

function modelCallbacks(connection, tier) {
  return {
    onModelAttempt(model) {
      send(connection, { type: 'model_route', tier, model, phase: 'attempt' });
    },
    onModelSelected(model) {
      send(connection, { type: 'model_route', tier, model, phase: 'selected' });
    },
  };
}

export class TalkSysVoiceAgent extends TalkSysVoiceAgentV26 {
  // The user asked for Grok as the conversation model, not as the speech synthesizer.
  // Keep TTS on Cloudflare-hosted Melo so third-party billing cannot delay audible output.
  tts = new MeloJapaneseTTS(this.env.AI);

  trackAssistant(iterable, context, tier, userText = '') {
    const self = this;
    const connection = connectionFrom(context);
    const user = String(userText || '').trim();
    if (user) recordConversationUser(connection, user);

    return (async function* () {
      ensureConnectionSession(connection);
      const runtime = self.runtimeFor(connection);
      runtime.currentAssistantText = '';
      runtime.assistantSpeechAt = Date.now();
      let failed = false;

      try {
        for await (const delta of iterable) {
          const value = String(delta || '');
          if (!value) continue;
          runtime.currentAssistantText += value;
          yield value;
        }
      } catch {
        failed = true;
      }

      // The Grok helper already cascades Grok -> GLM -> Qwen. This final local response
      // is only reached if all three inference paths are unavailable.
      if (failed && !runtime.currentAssistantText) {
        runtime.currentAssistantText = '接続を立て直しています。もう一度お願いします。';
        yield runtime.currentAssistantText;
      }
      if (!runtime.currentAssistantText) {
        runtime.currentAssistantText = 'もう一度お願いします。';
        yield runtime.currentAssistantText;
      }

      const clean = cleanSpeechText(runtime.currentAssistantText);
      if (clean) runtime.lastAssistantText = clean;
      self.rememberConversationTurn(context, userText, clean);
      runtime.currentAssistantText = '';
      runtime.assistantSpeechAt = Date.now();
    })();
  }

  mandatoryGroundedTurn(transcript, context, history) {
    const self = this;
    return (async function* () {
      const connection = connectionFrom(context);
      const result = await self.collectSearchEvidence(transcript, transcript, history, context);

      send(connection, {
        type: 'search_trace',
        phase: 'answering',
        resolvedQuestion: result.resolvedQuestion,
        queries: result.queries,
        evidenceCount: result.sources?.length || 0,
        sources: (result.sources || []).slice(0, 6).map((item) => ({ title: item.title, url: item.url })),
        message: 'Grokで回答を構成',
      });

      if (!result.sources?.length) {
        yield noEvidenceReply(transcript);
        return;
      }

      const pc = PC_TOPIC_RE.test(String(result.resolvedQuestion || transcript || ''));
      const callbacks = modelCallbacks(connection, pc ? 'grok-grounded-pc-v27' : 'grok-grounded-v27');
      yield* streamGrokConversationV27(self.env.AI, evidenceMessages(history, transcript, result), {
        signal: context?.signal,
        maxTokens: pc ? 340 : 250,
        openTimeoutMs: pc ? 1900 : 1550,
        firstTokenTimeoutMs: pc ? 2200 : 1800,
        fallbackTimeoutMs: pc ? 3000 : 2600,
        reasoningEffort: 'low',
        sessionAffinity: sessionAffinity(context),
        ...callbacks,
      });

      send(connection, {
        type: 'search_trace',
        phase: 'done',
        resolvedQuestion: result.resolvedQuestion,
        queries: result.queries,
        evidenceCount: result.sources?.length || 0,
        sources: (result.sources || []).slice(0, 6).map((item) => ({ title: item.title, url: item.url })),
        message: '回答を完了',
      });
    })();
  }

  normalConversationTurn(transcript, context, history) {
    const quick = quickCasualReply(transcript);
    if (quick) return this.trackAssistant((async function* () { yield quick; })(), context, 'instant-local-v27', transcript);

    const pc = PC_TOPIC_RE.test(String(transcript || ''));
    const quality = pc || String(transcript || '').length >= 110 || QUALITY_INTENT_RE.test(String(transcript || ''));
    const connection = connectionFrom(context);
    const tier = quality ? 'grok-quality-v27' : 'grok-live-v27';
    return this.trackAssistant(
      streamGrokConversationV27(this.env.AI, nonGroundedMessages(history, transcript), {
        signal: context?.signal,
        maxTokens: quality ? 280 : 210,
        openTimeoutMs: quality ? 1750 : 1350,
        firstTokenTimeoutMs: quality ? 2050 : 1650,
        fallbackTimeoutMs: quality ? 2900 : 2400,
        reasoningEffort: 'low',
        sessionAffinity: sessionAffinity(context),
        ...modelCallbacks(connection, tier),
      }),
      context,
      tier,
      transcript,
    );
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/cloudflare-live.js') return serveScript(CLOUDFLARE_LIVE_CLIENT_V26);
    if (request.method === 'GET' && url.pathname === '/search-trace.js') return serveScript(SEARCH_TRACE_CLIENT_V23);

    if (request.method === 'GET' && url.pathname === '/voice-health') {
      const response = await workerV26.fetch(request, env, ctx);
      let data = {};
      try { data = await response.json(); } catch {}
      return Response.json({
        ...data,
        ok: true,
        voiceRevision: VOICE_REVISION,
        conversationOrchestrator: 'grok-primary-bounded-cascade-v27',
        conversationModel: GROK_CONVERSATION_MODEL_V27,
        conversationModelFallback: GROK_FALLBACK_MODEL_V27,
        conversationEmergencyFallback: GROK_EMERGENCY_MODEL_V27,
        grokConversationPrimary: true,
        grokNonReasoningRealtime: true,
        grokStreaming: true,
        grokBillingCircuitBreaker: true,
        glmOnlyConversation: false,
        ttsPrimary: '@cf/myshell-ai/melotts',
        ttsFallback: null,
        grokTtsPrimary: false,
        inFlightUserContext: true,
        directTransitEvidenceFallback: true,
        mobileAudioPipelineV26: true,
        androidAudioWorkletPreferred: true,
        androidScriptProcessorFallback: true,
        androidPcmFrameProbeBeforeCall: true,
        androidCaptureBackendFailover: true,
        androidLifecycleResume: true,
        mobileWebSocketHardRecovery: true,
        microphoneDiagnostics: true,
      }, {
        headers: {
          'cache-control': 'no-store',
          'x-talksys-voice-revision': VOICE_REVISION,
        },
      });
    }

    return workerV26.fetch(request, env, ctx);
  },
};

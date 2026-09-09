import workerV22, { TalkSysVoiceAgent as TalkSysVoiceAgentV22 } from './worker-v22.js';
import { CLOUDFLARE_LIVE_CLIENT_V26 } from './cloudflare-live-client-v26.js';
import { SEARCH_TRACE_CLIENT_V23 } from './search-trace-client-v23.js';
import { ensureConnectionSession, recordConversationUser } from './conversation-memory.js';
import { cleanSpeechText, MeloJapaneseTTS } from './voice-helpers.js';
import { groundingDecisionV22, GROUNDING_POLICY_V22_REVISION } from './grounding-policy-v22.js';
import { collectGroundedEvidenceV26, SEARCH_TOOL_V26_REVISION } from './search-v26.js';
import { streamQwenConversationV28, TALKSYS_CONVERSATION_MODEL_V28 } from './qwen-conversation-v28.js';

export const VOICE_REVISION_V28 = 'cloudflare-agent-v28-simple-qwen-android';

const PC_TOPIC_RE = /(パソコン|\bPC\b|ＰＣ|Windows|MacBook|ThinkPad|Let'?s\s*note|レッツノート|CPU|GPU|Core\s*i[3579]|Ryzen|GeForce|Radeon|メモリ|RAM|SSD|NVMe|SATA|USB[- ]?C|Thunderbolt|Wi-?Fi|Bluetooth|BIOS|UEFI)/i;
const TRANSIT_RE = /(乗り換え|乗換|経路|行き方|電車|鉄道|駅から|駅まで|所要時間|運賃|時刻表|直通)/i;
const SHOPPING_RE = /(価格|値段|予算|いくら|購入|買う|買いたい|店頭|店舗|販売店|在庫)/i;

const GENERAL_PROMPT = `あなたはTalkSysという日本語のリアルタイム電話相談AIです。
会話履歴から省略された主語・対象・条件を自然に引き継ぎ、既に分かっていることを聞き直さないでください。
質問への答えを最初に出し、通常は1〜3文にしてください。長い前置き、一般論の羅列、同じ内容の言い換えは禁止です。
この経路ではWeb検索していません。現在価格、在庫、営業時間、ニュース、法律、現行仕様など変化する外部事実を記憶から断定しないでください。
必要な条件が足りない場合だけ、最も価値の高い質問を1つしてください。URL、Markdown、内部処理は読み上げないでください。`;

const PC_PROMPT = `${GENERAL_PROMPT}
パソコン関連ではPC販売・修理の実務者に通用する精度を優先してください。
結論を先に言い、CPU世代、RAM、SSD、端子、OS要件などは結論を左右する項目だけ具体的に使ってください。
聞かれていない寿命論や仕様一覧を勝手に付けず、症状相談では最も可能性が高い確認手順から示してください。`;

const GROUNDED_PROMPT = `あなたはTalkSysという日本語のリアルタイム電話相談AIです。
今回はWeb検索済みです。外部事実は今回提示された根拠に直接支えられる内容だけを使ってください。
質問への答えを最初の一文で出し、原則1〜3文、候補列挙でも4文以内です。
検索の成否、検索結果件数、検索サイト、内部処理は説明しないでください。
店舗なら条件に合う実在候補を2〜3件だけ、経路なら路線・乗換・降車駅を優先してください。
根拠が弱い情報は言わず、判断不能なら追加条件を1つだけ聞いてください。URL、Markdown、根拠番号は読み上げないでください。`;

const GROUNDED_PC_PROMPT = `${GROUNDED_PROMPT}
パソコン関連では判断を左右する2〜4項目だけ具体的に述べてください。
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
      'x-talksys-voice-revision': VOICE_REVISION_V28,
    },
  });
}

function sessionAffinity(context) {
  const connection = connectionFrom(context);
  const source = String(connection?.id || '').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 96);
  return source ? `talksys-v28-${source}` : '';
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

function waitPhrasesFor(text) {
  const value = String(text || '');
  if (TRANSIT_RE.test(value)) return ['少し調べますね。', '経路を絞っています。'];
  if (PC_TOPIC_RE.test(value)) return ['少し調べますね。', '必要な仕様だけ確認しています。'];
  if (SHOPPING_RE.test(value)) return ['少し調べますね。', '候補を絞っています。'];
  return ['少し調べますね。', '必要なところだけ確認しています。'];
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
    { role: 'user', content: `${transcript}\n\n[今回確認したWeb根拠]\n${compact || '(根拠データなし)'}` },
  ];
}

function noEvidenceReply(transcript) {
  const value = String(transcript || '');
  if (TRANSIT_RE.test(value)) return '何時ごろ出る予定ですか？';
  if (PC_TOPIC_RE.test(value)) return '型番か予算をもう1点だけ教えてください。';
  return '対象か条件をもう1点だけ教えてください。';
}

export class TalkSysVoiceAgent extends TalkSysVoiceAgentV22 {
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
        send(connection, { type: 'model_route', tier, model: TALKSYS_CONVERSATION_MODEL_V28, phase: 'selected' });
        for await (const delta of iterable) {
          const value = String(delta || '');
          if (!value) continue;
          runtime.currentAssistantText += value;
          yield value;
        }
      } catch {
        failed = true;
      }

      if (failed && !runtime.currentAssistantText) {
        runtime.currentAssistantText = '接続を立て直しました。もう一度お願いします。';
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

  async collectSearchEvidence(query, transcript, history, context) {
    const connection = connectionFrom(context);
    const started = Date.now();
    const decision = groundingDecisionV22(query || transcript, history);
    const [waitPhrase, followupPhrase] = waitPhrasesFor(query || transcript);

    send(connection, {
      type: 'grounding_policy',
      revision: GROUNDING_POLICY_V22_REVISION,
      search: decision.search,
      reason: decision.reason,
      riskTags: decision.riskTags,
    });
    send(connection, {
      type: 'search_status',
      phase: 'searching',
      searched: true,
      waitPhrase,
      followupPhrase,
    });

    let result;
    try {
      result = await collectGroundedEvidenceV26(query || transcript, history, {
        signal: context?.signal,
        onProgress: (event) => send(connection, { type: 'search_trace', ...event }),
      });
    } catch (error) {
      result = {
        revision: SEARCH_TOOL_V26_REVISION,
        resolvedQuestion: String(query || transcript || '').trim(),
        queries: [String(query || transcript || '').trim()].filter(Boolean),
        sources: [],
        evidence: '',
        elapsedMs: Date.now() - started,
        error: String(error?.message || error).slice(0, 180),
      };
    }

    send(connection, {
      type: 'search_status',
      phase: 'done',
      searched: true,
      provider: SEARCH_TOOL_V26_REVISION,
      resolvedQuestion: result.resolvedQuestion,
      queries: result.queries,
      evidenceUseful: Boolean(result.sources?.length),
      sources: (result.sources || []).slice(0, 8).map((item) => ({ title: item.title, url: item.url })),
      timings: { searchMs: result.elapsedMs },
    });
    return result;
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
        message: '回答を構成',
      });

      if (!result.sources?.length) {
        yield noEvidenceReply(transcript);
        return;
      }

      const pc = PC_TOPIC_RE.test(String(result.resolvedQuestion || transcript || ''));
      yield* streamQwenConversationV28(self.env.AI, evidenceMessages(history, transcript, result), {
        signal: context?.signal,
        maxTokens: pc ? 340 : 250,
        openTimeoutMs: pc ? 2000 : 1650,
        firstTokenTimeoutMs: pc ? 2400 : 1950,
        retryTimeoutMs: pc ? 3200 : 2800,
        streamIdleTimeoutMs: 2800,
        streamTotalTimeoutMs: pc ? 12000 : 9500,
        sessionAffinity: sessionAffinity(context),
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
    if (quick) return this.trackAssistant((async function* () { yield quick; })(), context, 'instant-local-v28', transcript);

    const pc = PC_TOPIC_RE.test(String(transcript || ''));
    return this.trackAssistant(
      streamQwenConversationV28(this.env.AI, nonGroundedMessages(history, transcript), {
        signal: context?.signal,
        maxTokens: pc ? 260 : 210,
        openTimeoutMs: pc ? 1800 : 1450,
        firstTokenTimeoutMs: pc ? 2150 : 1750,
        retryTimeoutMs: pc ? 3000 : 2600,
        streamIdleTimeoutMs: 2600,
        streamTotalTimeoutMs: pc ? 10500 : 8500,
        sessionAffinity: sessionAffinity(context),
      }),
      context,
      pc ? 'qwen-pc-v28' : 'qwen-live-v28',
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
      return Response.json({
        ok: true,
        voiceRevision: VOICE_REVISION_V28,
        architecture: 'whisper-qwen-melotts-single-path',
        conversationOrchestrator: 'single-qwen-bounded-v28',
        conversationModel: TALKSYS_CONVERSATION_MODEL_V28,
        conversationModelFallback: null,
        conversationEmergencyFallback: null,
        sameModelRetryOnce: true,
        qwenThinkingDisabled: true,
        multiModelFallback: false,
        legacyGlmActive: false,
        legacyGrokActive: false,
        legacyDeepSeekActive: false,
        legacyGptOssActive: false,
        searchAnswerModel: TALKSYS_CONVERSATION_MODEL_V28,
        searchTool: SEARCH_TOOL_V26_REVISION,
        ttsPrimary: '@cf/myshell-ai/melotts',
        ttsFallback: null,
        mobileAudioPipelineV26: true,
        androidAudioWorkletPreferred: true,
        androidScriptProcessorFallback: true,
        androidPcmFrameProbeBeforeCall: true,
        androidCaptureBackendFailover: true,
        androidLifecycleResume: true,
        mobileWebSocketHardRecovery: true,
        microphoneDiagnostics: true,
        inFlightUserContext: true,
        directTransitEvidenceFallback: true,
        contextualSearchSubjectOnlyCarryover: true,
      }, {
        headers: {
          'cache-control': 'no-store',
          'x-talksys-voice-revision': VOICE_REVISION_V28,
        },
      });
    }
    return workerV22.fetch(request, env, ctx);
  },
};

import workerV25, { TalkSysVoiceAgent as TalkSysVoiceAgentV25 } from './worker-v25.js';
import { CLOUDFLARE_LIVE_CLIENT_V31 } from './cloudflare-live-client-v31.js';
import { SEARCH_TRACE_CLIENT_V23 } from './search-trace-client-v23.js';
import { recordConversationUser } from './conversation-memory.js';
import { cleanSpeechText } from './voice-helpers.js';
import { CloudflareJapaneseTTS, PRIMARY_TTS_MODEL } from './cloudflare-japanese-tts.js';
import { augmentGroundedEvidenceV26, SEARCH_TOOL_V26_REVISION } from './search-v26.js';
import { streamGlmConversationV31, GLM_CONVERSATION_MODEL_V31 } from './glm-conversation-v31.js';

const VOICE_REVISION = 'cloudflare-agent-v31-glm-melo-reliable';
const PC_TOPIC_RE = /(パソコン|\bPC\b|ＰＣ|Windows|MacBook|ThinkPad|Let'?s\s*note|レッツノート|CPU|GPU|Core\s*i[3579]|Ryzen|GeForce|Radeon|メモリ|RAM|SSD|NVMe|SATA|USB[- ]?C|Thunderbolt|Wi-?Fi|Bluetooth|BIOS|UEFI)/i;
const QUALITY_INTENT_RE = /(どう考える|なぜ|理由|比較|どっち|どちら|どうすれば|どうしたら|整理して|メリット|デメリット|可能性|戦略|設計|方針|改善|問題点|原因|将来|実現可能|検討|判断)/i;

const GENERAL_PROMPT = `あなたはTalkSysという日本語のリアルタイム電話相談AIです。
同じ接続・通話の会話履歴を必ず使い、省略された主語・対象・条件を自然に引き継いでください。既に分かっていることを聞き直さないでください。
最初の一文から質問に直接答え、通常は1〜3文にしてください。長い前置き、一般論の羅列、同じ内容の言い換えは禁止です。
正確さを優先し、判断に必要な情報だけを述べてください。難しい相談でも電話で一度に理解できる長さを維持してください。
この経路ではWeb検索していません。現在価格、在庫、営業時間、ニュース、法律、現行仕様など変化する外部事実を記憶から断定しないでください。
足りない条件が本当に必要なら、最も価値の高い質問を1つだけしてください。
URL、Markdown、内部処理、モデル名は読み上げないでください。`;

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
  return source ? `talksys-v31-${source}` : '';
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
    { role: 'user', content: `${transcript}\n\n[今回確認したWeb根拠]\n${compact || '(根拠データなし)'}` },
  ];
}

function noEvidenceReply(transcript) {
  const value = String(transcript || '');
  if (/(乗り換え|乗換|経路|行き方|電車|鉄道|駅から|駅まで|所要時間|運賃|時刻表|直通)/i.test(value)) return '出発する時間帯を教えてください。そこまで含めて経路を絞ります。';
  if (PC_TOPIC_RE.test(value)) return '型番か予算をもう1点だけ教えてください。';
  return '対象か条件をもう1点だけ教えてください。';
}

function retryMessages(history, userText, partial = '') {
  const messages = [
    { role: 'system', content: PC_TOPIC_RE.test(String(userText || '')) ? PC_PROMPT : GENERAL_PROMPT },
    ...(Array.isArray(history) ? history.slice(-12) : []),
    { role: 'user', content: String(userText || '').trim() },
  ];
  if (partial) {
    messages.push({ role: 'assistant', content: partial });
    messages.push({ role: 'user', content: '回答が途中まで届いています。同じ内容を繰り返さず、続きだけを短く完成させてください。' });
  } else {
    messages.push({ role: 'user', content: '最初の一文から直接、1〜3文で返答してください。内部処理は説明しないでください。' });
  }
  return messages;
}

export class TalkSysVoiceAgent extends TalkSysVoiceAgentV25 {
  // Explicitly restore the pre-Grok Cloudflare-hosted Japanese TTS path.
  tts = new CloudflareJapaneseTTS(this.env.AI);

  trackAssistant(iterable, context, tier, userText = '') {
    const self = this;
    const connection = connectionFrom(context);
    const user = String(userText || '').trim();
    if (user) recordConversationUser(connection, user);

    return (async function* () {
      const runtime = self.runtimeFor(connection);
      runtime.currentAssistantText = '';
      runtime.assistantSpeechAt = Date.now();
      let failed = false;

      try {
        send(connection, { type: 'model_route', tier, model: GLM_CONVERSATION_MODEL_V31 });
        for await (const delta of iterable) {
          const value = String(delta || '');
          if (!value) continue;
          runtime.currentAssistantText += value;
          yield value;
        }
      } catch {
        failed = true;
      }

      // Search answers must remain evidence-bound. The grounded generator already
      // performs same-GLM recovery, so do not rebuild it as an ungrounded answer.
      if (failed && !String(tier || '').includes('grounded') && !String(tier || '').includes('search')) {
        const partial = cleanSpeechText(runtime.currentAssistantText);
        try {
          const history = self.getTalkSysHistory(connection);
          for await (const delta of streamGlmConversationV31(self.env.AI, retryMessages(history, userText, partial), {
            signal: context?.signal,
            maxTokens: partial ? 150 : 220,
            openTimeoutMs: 2500,
            firstTokenTimeoutMs: 2600,
            fallbackTimeoutMs: 4200,
            streamIdleTimeoutMs: 2800,
            streamTotalTimeoutMs: 9000,
            reasoningEffort: 'low',
            sessionAffinity: sessionAffinity(context),
          })) {
            const value = String(delta || '');
            if (!value) continue;
            runtime.currentAssistantText += value;
            yield value;
          }
        } catch {}
      }

      if (!runtime.currentAssistantText) {
        runtime.currentAssistantText = String(tier || '').includes('grounded') || String(tier || '').includes('search')
          ? '回答生成が一時的に失敗しました。質問内容は保持しているので、もう一度「どうですか」と言ってください。'
          : '回答生成が一時的に失敗しました。もう一度そのまま話してください。';
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
    const base = await super.collectSearchEvidence(query, transcript, history, context);
    if (base?.sources?.length) return { ...base, revision: SEARCH_TOOL_V26_REVISION };
    const connection = connectionFrom(context);
    return augmentGroundedEvidenceV26(base, {
      signal: context?.signal,
      onProgress: (event) => send(connection, { type: 'search_trace', ...event }),
    });
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
        message: 'GLMで回答を構成',
      });

      if (!result.sources?.length) {
        yield noEvidenceReply(transcript);
        return;
      }

      const pc = PC_TOPIC_RE.test(String(result.resolvedQuestion || transcript || ''));
      try {
        yield* streamGlmConversationV31(self.env.AI, evidenceMessages(history, transcript, result), {
          signal: context?.signal,
          maxTokens: pc ? 320 : 240,
          openTimeoutMs: pc ? 2600 : 2300,
          firstTokenTimeoutMs: pc ? 2800 : 2500,
          fallbackTimeoutMs: pc ? 4600 : 4300,
          streamIdleTimeoutMs: 3000,
          streamTotalTimeoutMs: pc ? 12000 : 10500,
          reasoningEffort: 'low',
          sessionAffinity: sessionAffinity(context),
        });
      } catch {
        yield '確認した内容は保持していますが、回答生成だけ一時的に失敗しました。もう一度「どうですか」と言ってください。';
      }

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
    if (quick) return this.trackAssistant((async function* () { yield quick; })(), context, 'instant-local-v31', transcript);

    const pc = PC_TOPIC_RE.test(String(transcript || ''));
    const quality = pc || String(transcript || '').length >= 110 || QUALITY_INTENT_RE.test(String(transcript || ''));
    return this.trackAssistant(
      streamGlmConversationV31(this.env.AI, nonGroundedMessages(history, transcript), {
        signal: context?.signal,
        maxTokens: quality ? 260 : 200,
        openTimeoutMs: quality ? 2500 : 2200,
        firstTokenTimeoutMs: quality ? 2700 : 2400,
        fallbackTimeoutMs: quality ? 4400 : 4000,
        streamIdleTimeoutMs: quality ? 3000 : 2600,
        streamTotalTimeoutMs: quality ? 11000 : 9000,
        reasoningEffort: 'low',
        sessionAffinity: sessionAffinity(context),
      }),
      context,
      quality ? 'glm-quality-v31' : 'glm-live-v31',
      transcript,
    );
  }
}

async function meloTtsResponse(request, env) {
  let text = '';
  try {
    const body = await request.json();
    text = String(body?.text || '').trim().slice(0, 1800);
  } catch {}
  if (!text) return Response.json({ ok: false, error: 'text required' }, { status: 400 });
  try {
    const tts = new CloudflareJapaneseTTS(env.AI);
    const audio = await tts.synthesize(text);
    if (!audio || audio.byteLength < 100) throw new Error('MeloTTS returned empty audio');
    return new Response(audio, {
      headers: {
        'content-type': 'audio/mpeg',
        'cache-control': 'no-store',
        'x-talksys-tts-provider': PRIMARY_TTS_MODEL,
        'x-talksys-voice-revision': VOICE_REVISION,
      },
    });
  } catch (error) {
    return Response.json({ ok: false, error: String(error?.message || error).slice(0, 300) }, { status: 502, headers: { 'cache-control': 'no-store' } });
  }
}

async function glmBindingProbe(env) {
  const started = Date.now();
  let answer = '';
  let conversationError = '';
  try {
    for await (const delta of streamGlmConversationV31(env.AI, [
      { role: 'system', content: '日本語で簡潔に答えてください。' },
      { role: 'user', content: '動作確認です。「正常です」とだけ答えてください。' },
    ], {
      maxTokens: 40,
      openTimeoutMs: 2600,
      firstTokenTimeoutMs: 2800,
      fallbackTimeoutMs: 4500,
      streamTotalTimeoutMs: 8000,
      reasoningEffort: 'low',
      sessionAffinity: `talksys-v31-probe-${crypto.randomUUID()}`,
    })) answer += String(delta || '');
  } catch (error) {
    conversationError = String(error?.message || error).slice(0, 300);
  }

  let ttsBytes = 0;
  let ttsError = '';
  try {
    const tts = new CloudflareJapaneseTTS(env.AI);
    const audio = await tts.synthesize('これはMeloTTSの動作確認です。');
    ttsBytes = Number(audio?.byteLength || 0);
  } catch (error) {
    ttsError = String(error?.message || error).slice(0, 300);
  }

  const ok = Boolean(answer.trim()) && ttsBytes > 100;
  return Response.json({
    ok,
    revision: VOICE_REVISION,
    conversation: { model: GLM_CONVERSATION_MODEL_V31, ok: Boolean(answer.trim()), answer: answer.trim(), error: conversationError },
    tts: { model: PRIMARY_TTS_MODEL, ok: ttsBytes > 100, bytes: ttsBytes, error: ttsError },
    elapsedMs: Date.now() - started,
  }, { status: ok ? 200 : 502, headers: { 'cache-control': 'no-store' } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/cloudflare-live.js') return serveScript(CLOUDFLARE_LIVE_CLIENT_V31);
    if (request.method === 'GET' && url.pathname === '/search-trace.js') return serveScript(SEARCH_TRACE_CLIENT_V23);
    if (request.method === 'POST' && url.pathname === '/api/melo-tts-v31') return meloTtsResponse(request, env);
    if (request.method === 'GET' && url.pathname === '/api/glm-binding-probe-v31') return glmBindingProbe(env);

    if (request.method === 'GET' && url.pathname === '/voice-health') {
      const response = await workerV25.fetch(request, env, ctx);
      let data = {};
      try { data = await response.json(); } catch {}
      return Response.json({
        ...data,
        ok: true,
        voiceRevision: VOICE_REVISION,
        conversationOrchestrator: 'glm-single-model-bounded-recovery-v31',
        conversationModel: GLM_CONVERSATION_MODEL_V31,
        conversationModelFallback: GLM_CONVERSATION_MODEL_V31,
        glmOnlyConversation: true,
        glmReasoningEffort: 'low',
        glmVisibleFirstTokenDeadline: true,
        glmReasoningOnlyStreamEscape: true,
        glmPartialContinuationRecovery: true,
        glmSameModelRecoveryOnly: true,
        glmLegacySixSecondFallbackMinimumRemoved: true,
        inFlightUserContext: true,
        duplicateUserTurnGuard: true,
        searchTool: SEARCH_TOOL_V26_REVISION,
        directTransitEvidenceFallback: true,
        ttsPrimary: PRIMARY_TTS_MODEL,
        ttsFallback: null,
        ttsCloudflareHosted: true,
        browserSpeechSynthesisEnabled: false,
        typedSpeechUsesMeloTts: true,
        serverAudioAuthoritative: true,
        thirdPartyModelCreditsRequired: false,
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

    return workerV25.fetch(request, env, ctx);
  },
};

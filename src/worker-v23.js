import workerV22, { TalkSysVoiceAgent as TalkSysVoiceAgentV22 } from './worker-v22.js';
import { CLOUDFLARE_LIVE_CLIENT_V23 } from './cloudflare-live-client-v23.js';
import { SEARCH_TRACE_CLIENT_V23 } from './search-trace-client-v23.js';
import { streamBoundedQualityConversation } from './bounded-conversation.js';
import { ensureConnectionSession } from './conversation-memory.js';
import { cleanSpeechText } from './voice-helpers.js';
import {
  groundingDecisionV22,
  GROUNDING_POLICY_V22_REVISION,
} from './grounding-policy-v22.js';
import {
  collectGroundedEvidenceV23,
  SEARCH_TOOL_V23_REVISION,
} from './search-v23.js';

const VOICE_REVISION = 'cloudflare-agent-v23-mobile-search-pc-quality';
const PC_TOPIC_RE = /(パソコン|\bPC\b|ＰＣ|Windows|MacBook|ThinkPad|Let'?s\s*note|レッツノート|CPU|GPU|Core\s*i[3579]|Ryzen|GeForce|Radeon|メモリ|RAM|SSD|NVMe|SATA|USB[- ]?C|Thunderbolt|Wi-?Fi|Bluetooth|BIOS|UEFI)/i;
const TRANSIT_RE = /(乗り換え|乗換|経路|行き方|電車|鉄道|駅から|駅まで|所要時間|運賃|時刻表|直通)/i;
const SHOPPING_RE = /(価格|値段|予算|いくら|購入|買う|買いたい|店頭|店舗|販売店|在庫)/i;

const PC_NON_GROUNDED_PROMPT = `あなたはTalkSysという日本語のリアルタイム電話相談AIです。
パソコン関連では、相談相手がPC販売・修理の実務者でも通用する精度で答えてください。初心者向けに曖昧化せず、判断に必要な技術的理由を具体的に述べてください。
ただし、このターンはWeb検索をしていません。現在の価格、在庫、現行製品、発売時期、最新仕様など外部確認が必要な事実をモデル記憶から断定してはいけません。
症状相談では、CPU負荷、メモリ圧迫、ストレージ、温度、電源、ドライバ、OS、ネットワークなどを原因候補として整理し、確認手順を優先順位順に示してください。
買い替え相談の開始時は、用途、予算、持ち運び、画面サイズ、新品中古、必要な端子、現在機の不満のうち重要なものだけを2〜3点確認してください。
相手が聞いていない一般論や検索事情は話さず、結論と技術的根拠を先に述べてください。電話で聞き取れる自然な日本語にしてください。`;

const GROUNDED_GENERAL_PROMPT = `あなたはTalkSysという日本語のリアルタイム電話相談AIです。
今回はWeb検索済みです。具体的な外部事実は今回提示された根拠に直接支えられるものだけを使ってください。
最重要ルールは、ユーザーの質問へ直接答えることです。検索の出来、不足、検索結果の件数、検索サイトの都合、内部処理を説明してはいけません。
「検索結果には記載がありません」「検索結果からは分かりません」「良い検索結果がありません」のような検索メタ発言は禁止です。質問に不要な情報は省いてください。
経路案内では、まず使う路線、乗換の有無、乗換駅、降車駅を短く明確に答えてください。所要時間や運賃は根拠で確認できた場合だけ加え、聞かれていなければ無理に付けません。
根拠のない具体値や固有名詞は補完しないでください。中心的な情報が確定できない場合は、検索事情ではなく、正確な案内に必要な条件を1つだけ確認してください。
URL、Markdown、根拠番号、内部処理は読み上げないでください。通常は2〜6文で、結論を先に答えてください。`;

const GROUNDED_PC_PROMPT = `${GROUNDED_GENERAL_PROMPT}
パソコン関連ではPC販売・修理の実務者が聞いても破綻しない技術精度を優先してください。
質問に関係する範囲で、CPUの世代・型番・コア/スレッド、メモリ容量と増設可否、SSDの規格、GPU、画面、端子、無線、OS要件、充電方式、バッテリーや中古状態など、判断材料になる仕様を具体的に示してください。
単に「高性能」「十分」「おすすめ」と言わず、なぜそう判断するかを仕様・用途との対応で説明してください。
価格や相場、在庫、発売時期は今回の根拠で確認できた内容だけを使ってください。
ただし、聞かれていないスペックを全部羅列するのではなく、質問への判断に効く項目を優先してください。必要なら5〜10文程度まで詳しく答えて構いません。`;

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
  return source ? `talksys-v23-${source}` : '';
}

function waitPhrasesFor(text) {
  const value = String(text || '');
  if (TRANSIT_RE.test(value)) return ['少し調べますね。', '経路と乗り換えを絞っています。'];
  if (PC_TOPIC_RE.test(value)) return ['少し調べますね。', '仕様と必要な条件を照合しています。'];
  if (SHOPPING_RE.test(value)) return ['少し調べますね。', '価格と候補を絞っています。'];
  return ['少し調べますね。', '必要なところだけ確認しています。'];
}

function evidenceMessages(history, transcript, result) {
  const pc = PC_TOPIC_RE.test(String(result?.resolvedQuestion || transcript || ''));
  const sources = Array.isArray(result?.sources) ? result.sources.slice(0, pc ? 12 : 10) : [];
  const compact = sources.map((item, index) => {
    const evidence = String(item?.excerpt || item?.snippet || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, pc ? 1500 : 1200);
    return `[${index + 1}] ${String(item?.title || '').slice(0, 220)}\n${String(item?.url || '').slice(0, 700)}\n${evidence}`;
  }).join('\n\n');

  return [
    { role: 'system', content: pc ? GROUNDED_PC_PROMPT : GROUNDED_GENERAL_PROMPT },
    ...(Array.isArray(history) ? history.slice(-16) : []),
    {
      role: 'user',
      content: `${transcript}\n\n[今回確認したWeb根拠]\n${compact || '(根拠データなし)'}`,
    },
  ];
}

function pcNonGroundedMessages(history, transcript) {
  return [
    { role: 'system', content: PC_NON_GROUNDED_PROMPT },
    ...(Array.isArray(history) ? history.slice(-16) : []),
    { role: 'user', content: transcript },
  ];
}

async function* streamGroundedWithContinuation(ai, messages, options) {
  let partial = '';
  try {
    const stream = streamBoundedQualityConversation(ai, messages, options);
    for await (const delta of stream) {
      const value = String(delta || '');
      if (!value) continue;
      partial += value;
      yield value;
    }
    return;
  } catch {}

  const cleanPartial = cleanSpeechText(partial);
  const retryMessages = [
    ...messages,
    ...(cleanPartial ? [{ role: 'assistant', content: cleanPartial }] : []),
    {
      role: 'user',
      content: cleanPartial
        ? '直前の回答は途中まで届いています。同じ内容を繰り返さず、今回のWeb根拠だけを使って続きから完結させてください。'
        : '回答生成が一度途切れました。今回のWeb根拠だけを使い、質問への答えを最初から簡潔に完成させてください。',
    },
  ];

  try {
    const retry = streamBoundedQualityConversation(ai, retryMessages, {
      ...options,
      maxTokens: cleanPartial ? Math.min(360, options.maxTokens || 360) : options.maxTokens,
      openTimeoutMs: 3300,
      firstTokenTimeoutMs: 3600,
      fallbackTimeoutMs: 4600,
    });
    for await (const delta of retry) {
      const value = String(delta || '');
      if (value) yield value;
    }
  } catch {}
}

function noEvidenceReply(transcript) {
  const value = String(transcript || '');
  if (TRANSIT_RE.test(value)) return '出発時刻まで含めて正確に絞るなら、何時ごろ出る予定ですか？';
  if (PC_TOPIC_RE.test(value)) return '型番末尾か、用途と予算のどちらかをもう一段具体化してください。そこまで分かれば仕様を絞って判断できます。';
  return '正確に絞るため、対象の名称や条件をもう1つだけ具体的に教えてください。';
}

export class TalkSysVoiceAgent extends TalkSysVoiceAgentV22 {
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
      result = await collectGroundedEvidenceV23(query || transcript, history, {
        signal: context?.signal,
        onProgress: (event) => send(connection, { type: 'search_trace', ...event }),
      });
    } catch (error) {
      result = {
        revision: SEARCH_TOOL_V23_REVISION,
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
      provider: SEARCH_TOOL_V23_REVISION,
      resolvedQuestion: result.resolvedQuestion,
      queries: result.queries,
      evidenceUseful: Boolean(result.sources?.length),
      sources: (result.sources || []).slice(0, 10).map((item) => ({ title: item.title, url: item.url })),
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
        sources: (result.sources || []).slice(0, 8).map((item) => ({ title: item.title, url: item.url })),
        message: '質問への回答に必要な情報を構成',
      });

      if (!result.sources?.length) {
        yield noEvidenceReply(transcript);
        send(connection, {
          type: 'search_trace',
          phase: 'done',
          resolvedQuestion: result.resolvedQuestion,
          queries: result.queries,
          evidenceCount: 0,
          sources: [],
          message: '追加条件を確認',
        });
        return;
      }

      const pc = PC_TOPIC_RE.test(String(result.resolvedQuestion || transcript || ''));
      const messages = evidenceMessages(history, transcript, result);
      yield* streamGroundedWithContinuation(self.env.AI, messages, {
        signal: context?.signal,
        maxTokens: pc ? 760 : 480,
        openTimeoutMs: pc ? 3300 : 2800,
        firstTokenTimeoutMs: pc ? 3600 : 3100,
        fallbackTimeoutMs: pc ? 4800 : 4100,
        sessionAffinity: sessionAffinity(context),
      });

      send(connection, {
        type: 'search_trace',
        phase: 'done',
        resolvedQuestion: result.resolvedQuestion,
        queries: result.queries,
        evidenceCount: result.sources?.length || 0,
        sources: (result.sources || []).slice(0, 8).map((item) => ({ title: item.title, url: item.url })),
        message: '回答を完了',
      });
    })();
  }

  normalConversationTurn(transcript, context, history) {
    if (!PC_TOPIC_RE.test(String(transcript || ''))) return super.normalConversationTurn(transcript, context, history);

    return this.trackAssistant(
      streamBoundedQualityConversation(this.env.AI, pcNonGroundedMessages(history, transcript), {
        signal: context?.signal,
        maxTokens: 520,
        openTimeoutMs: 2800,
        firstTokenTimeoutMs: 3100,
        fallbackTimeoutMs: 4000,
        sessionAffinity: sessionAffinity(context),
      }),
      context,
      'pc-expert-consult-v23',
      transcript,
    );
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/cloudflare-live.js') return serveScript(CLOUDFLARE_LIVE_CLIENT_V23);
    if (request.method === 'GET' && url.pathname === '/search-trace.js') return serveScript(SEARCH_TRACE_CLIENT_V23);

    if (request.method === 'GET' && url.pathname === '/voice-health') {
      const response = await workerV22.fetch(request, env, ctx);
      let data = {};
      try { data = await response.json(); } catch {}
      return Response.json({
        ...data,
        ok: true,
        voiceRevision: VOICE_REVISION,
        conversationOrchestrator: 'grounded-conversation-agent-v23',
        webSearchTool: SEARCH_TOOL_V23_REVISION,
        parallelIntentSearch: true,
        adaptiveSearchWaitSpeech: true,
        audibleSearchWaitSpeech: true,
        searchWaitFollowupSpeech: true,
        searchMetaSpeechForbidden: true,
        pcExpertAnswerMode: true,
        pcExpertGroundedDetail: true,
        groundedContinuationRetry: true,
        duplicateBrowserTtsGuard: true,
        browserTtsFallbackDelayMs: 3500,
        microphoneConstraintFallback: true,
        microphoneFrameWatchdog: true,
        microphoneAutoRecovery: true,
        workletToScriptProcessorAutoFallback: true,
        duplicateSearchTraceFixed: true,
      }, {
        headers: {
          'cache-control': 'no-store',
          'x-talksys-voice-revision': VOICE_REVISION,
        },
      });
    }

    return workerV22.fetch(request, env, ctx);
  },
};

import workerV22, { TalkSysVoiceAgent as TalkSysVoiceAgentV22 } from './worker-v22.js';
import { CLOUDFLARE_LIVE_CLIENT_V24 } from './cloudflare-live-client-v24.js';
import { SEARCH_TRACE_CLIENT_V23 } from './search-trace-client-v23.js';
import { streamBoundedQualityConversation } from './bounded-conversation.js';
import { cleanSpeechText } from './voice-helpers.js';
import {
  groundingDecisionV22,
  GROUNDING_POLICY_V22_REVISION,
} from './grounding-policy-v22.js';
import {
  collectGroundedEvidenceV23,
  SEARCH_TOOL_V23_REVISION,
} from './search-v23.js';

const VOICE_REVISION = 'cloudflare-agent-v24-xperia-fast-bargein';
const PC_TOPIC_RE = /(パソコン|\bPC\b|ＰＣ|Windows|MacBook|ThinkPad|Let'?s\s*note|レッツノート|CPU|GPU|Core\s*i[3579]|Ryzen|GeForce|Radeon|メモリ|RAM|SSD|NVMe|SATA|USB[- ]?C|Thunderbolt|Wi-?Fi|Bluetooth|BIOS|UEFI)/i;
const TRANSIT_RE = /(乗り換え|乗換|経路|行き方|電車|鉄道|駅から|駅まで|所要時間|運賃|時刻表|直通)/i;
const SHOPPING_RE = /(価格|値段|予算|いくら|購入|買う|買いたい|店頭|店舗|販売店|在庫)/i;

const PC_NON_GROUNDED_PROMPT = `あなたはTalkSysという日本語のリアルタイム電話相談AIです。
PC販売・修理の実務者にも通用する正確さを保ちつつ、長話はしないでください。
最初に結論を言い、その判断に必要な仕様だけを述べてください。原則1〜3文です。
ユーザーが聞いていない寿命の一般論、OSサポート期限、CPU/GPU/RAM等の総一覧は付けないでください。
買い替え相談では、次の判断に本当に必要な質問を1つだけ聞いてください。既に分かっている条件は聞き直さないでください。
現在価格、在庫、現行機種、発売時期など外部確認が必要な事実はWeb未検索なら断定しないでください。
症状相談では原因候補を羅列せず、最も可能性が高い確認手順から示してください。
曖昧な「十分」「高性能」ではなく、必要なら仕様値と用途の関係を一言で説明してください。`;

const GROUNDED_GENERAL_PROMPT = `あなたはTalkSysという日本語のリアルタイム電話相談AIです。
今回はWeb検索済みです。外部事実は今回の根拠に直接ある内容だけを使ってください。
質問への答えを最初の一文で出してください。原則1〜3文、候補列挙でも4文以内です。
検索の出来、不足、件数、検索サイト、内部処理について絶対に話さないでください。
「検索結果には記載がありません」「確認できませんでした」「良い検索結果がありません」などの検索メタ発言は禁止です。
店舗を聞かれたら、条件に合う実在候補を2〜3件だけ具体名で答え、必要なら違いを短く添えてください。
経路案内は路線・乗換有無・乗換駅・降車駅を優先し、聞かれていない周辺情報は省いてください。
根拠が弱い事実は言わず、どうしても判断不能なら追加条件を1つだけ聞いてください。
URL、Markdown、根拠番号は読み上げないでください。`;

const GROUNDED_PC_PROMPT = `${GROUNDED_GENERAL_PROMPT}
パソコン関連ではPC販売・修理の実務精度を優先してください。
ただし詳しさを仕様一覧の長さで稼がないでください。質問の判断を左右する2〜4項目だけ述べてください。
CPU世代、RAM、SSD規格、増設可否、端子、OS要件などは、その質問の結論に関係するときだけ具体的に使ってください。
価格・相場・在庫・発売時期は今回の根拠で確認できた内容だけを使ってください。`;

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
  return source ? `talksys-v24-${source}` : '';
}

function waitPhrasesFor(text) {
  const value = String(text || '');
  if (TRANSIT_RE.test(value)) return ['少し調べますね。', '経路を絞っています。'];
  if (PC_TOPIC_RE.test(value)) return ['少し調べますね。', '必要な仕様だけ確認しています。'];
  if (SHOPPING_RE.test(value)) return ['少し調べますね。', '候補を絞っています。'];
  return ['少し調べますね。', '必要なところだけ確認しています。'];
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
    { role: 'system', content: pc ? GROUNDED_PC_PROMPT : GROUNDED_GENERAL_PROMPT },
    ...(Array.isArray(history) ? history.slice(-12) : []),
    {
      role: 'user',
      content: `${transcript}\n\n[今回確認したWeb根拠]\n${compact || '(根拠データなし)'}`,
    },
  ];
}

function pcNonGroundedMessages(history, transcript) {
  return [
    { role: 'system', content: PC_NON_GROUNDED_PROMPT },
    ...(Array.isArray(history) ? history.slice(-12) : []),
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
        ? '同じ内容を繰り返さず、続きだけを短く完結させてください。'
        : '質問への答えを最初から短く完成させてください。',
    },
  ];

  try {
    const retry = streamBoundedQualityConversation(ai, retryMessages, {
      ...options,
      maxTokens: cleanPartial ? Math.min(180, options.maxTokens || 180) : options.maxTokens,
      openTimeoutMs: 2300,
      firstTokenTimeoutMs: 2500,
      fallbackTimeoutMs: 3200,
    });
    for await (const delta of retry) {
      const value = String(delta || '');
      if (value) yield value;
    }
  } catch {}
}

function noEvidenceReply(transcript) {
  const value = String(transcript || '');
  if (TRANSIT_RE.test(value)) return '何時ごろ出る予定ですか？';
  if (PC_TOPIC_RE.test(value)) return '型番か予算をもう1点だけ教えてください。';
  return '対象か条件をもう1点だけ教えてください。';
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
        maxTokens: pc ? 360 : 240,
        openTimeoutMs: pc ? 2300 : 1900,
        firstTokenTimeoutMs: pc ? 2600 : 2200,
        fallbackTimeoutMs: pc ? 3300 : 2900,
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
    if (!PC_TOPIC_RE.test(String(transcript || ''))) return super.normalConversationTurn(transcript, context, history);

    return this.trackAssistant(
      streamBoundedQualityConversation(this.env.AI, pcNonGroundedMessages(history, transcript), {
        signal: context?.signal,
        maxTokens: 260,
        openTimeoutMs: 1900,
        firstTokenTimeoutMs: 2200,
        fallbackTimeoutMs: 2900,
        sessionAffinity: sessionAffinity(context),
      }),
      context,
      'pc-precise-fast-v24',
      transcript,
    );
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/cloudflare-live.js') return serveScript(CLOUDFLARE_LIVE_CLIENT_V24);
    if (request.method === 'GET' && url.pathname === '/search-trace.js') return serveScript(SEARCH_TRACE_CLIENT_V23);

    if (request.method === 'GET' && url.pathname === '/voice-health') {
      const response = await workerV22.fetch(request, env, ctx);
      let data = {};
      try { data = await response.json(); } catch {}
      return Response.json({
        ...data,
        ok: true,
        voiceRevision: VOICE_REVISION,
        conversationOrchestrator: 'precise-fast-conversation-agent-v24',
        webSearchTool: SEARCH_TOOL_V23_REVISION,
        parallelIntentSearch: true,
        conciseRepliesByDefault: true,
        pcDecisionDetailOnly: true,
        shorterGroundedTokenBudget: true,
        adaptiveSearchWaitSpeech: true,
        audibleSearchWaitSpeech: true,
        searchMetaSpeechForbidden: true,
        browserStreamingTts: true,
        preListeningMicFrames: true,
        voiceBargeIn: true,
        xperiaHandshakeFix: true,
        microphoneConstraintFallback: true,
        microphoneFrameWatchdog: true,
        microphoneAutoRecovery: true,
        workletToScriptProcessorAutoFallback: true,
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

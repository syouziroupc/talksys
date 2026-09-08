import workerV21, { TalkSysVoiceAgent as TalkSysVoiceAgentV21 } from './worker-v21.js';
import {
  streamBoundedLiveConversation,
  streamBoundedQualityConversation,
} from './bounded-conversation.js';
import {
  groundingDecisionV22,
  requiresGroundingSearchV22,
  GROUNDING_POLICY_V22_REVISION,
} from './grounding-policy-v22.js';
import {
  collectGroundedEvidenceV22,
  SEARCH_TOOL_V22_REVISION,
} from './search-v22.js';

const VOICE_REVISION = 'cloudflare-agent-v22-grounding-by-default';
const QUALITY_INTENT_RE = /(どう考える|なぜ|理由|比較|どっち|どちら|どうすれば|どうしたら|整理して|メリット|デメリット|可能性|戦略|設計|方針|改善|問題点|原因|将来|実現可能)/i;

const NON_GROUNDED_SYSTEM_PROMPT = `あなたはTalkSysという日本語のリアルタイム電話相談AIです。
このターンではWeb検索をしていません。したがって、外部世界についての具体的な事実を新しく断定してはいけません。
店舗名、会社名、人物、場所、路線、価格、在庫、営業時間、製品仕様、制度、法律、医療情報、日付、数値、ランキングなどをモデルの記憶から補わないでください。
この経路で行ってよいのは、挨拶、相づち、ユーザーの希望の整理、追加質問、一般的な考え方、主観的な相談への助言、文章作成です。
製品・店・制度などの相談で情報が足りない場合は、事実を作らず次に必要な条件を1つだけ聞いてください。
電話で自然に聞ける日本語にし、通常は1〜3文にしてください。内部処理や検索経路は説明しないでください。`;

const NON_GROUNDED_QUALITY_PROMPT = `${NON_GROUNDED_SYSTEM_PROMPT}
今回は少し整理が必要な相談です。ただし検索していない外部事実は追加せず、ユーザーの条件と一般的な判断枠組みだけで答えてください。`;

const STRICT_GROUNDED_SYSTEM_PROMPT = `あなたはTalkSysという日本語のリアルタイム電話相談AIです。
今回はWeb検索済みです。回答中の具体的な外部事実は、必ず今回提示された検索根拠に直接支えられている内容だけに限定してください。
モデルの記憶、一般常識、推測、連想で不足部分を補ってはいけません。根拠にない店名、会社名、人名、路線、価格、在庫、営業時間、住所、電話番号、製品仕様、制度、法律、医療情報、日付、数値を作らないでください。
複数の根拠が食い違う場合は、断定せず食い違いがあると短く述べてください。根拠が質問の一部しか支えていない場合は、確認できた範囲だけ答えてください。
会話履歴は質問の意味や条件を理解するために使ってよいですが、外部事実の根拠にはしないでください。
質問へ直接答え、通常は2〜5文程度にしてください。URL、Markdown、内部処理説明は読み上げないでください。`;

function connectionFrom(context) {
  return context?.connection || context || null;
}

function send(connection, payload) {
  try { connection?.send(JSON.stringify(payload)); } catch {}
}

function sessionAffinity(context) {
  const connection = connectionFrom(context);
  const source = String(connection?.id || '').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 96);
  return source ? `talksys-v22-${source}` : '';
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

function normalMessages(history, transcript, quality = false) {
  return [
    { role: 'system', content: quality ? NON_GROUNDED_QUALITY_PROMPT : NON_GROUNDED_SYSTEM_PROMPT },
    ...(Array.isArray(history) ? history.slice(-16) : []),
    { role: 'user', content: transcript },
  ];
}

function evidenceMessages(history, transcript, result) {
  const sources = Array.isArray(result.sources) ? result.sources.slice(0, 10) : [];
  const compact = sources.map((item, index) => {
    const evidence = String(item.excerpt || item.snippet || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1200);
    return `[${index + 1}] ${String(item.title || '').slice(0, 200)}\n${String(item.url || '').slice(0, 700)}\n${evidence}`;
  }).join('\n\n');

  return [
    { role: 'system', content: STRICT_GROUNDED_SYSTEM_PROMPT },
    ...(Array.isArray(history) ? history.slice(-14) : []),
    {
      role: 'user',
      content: `${transcript}\n\n[今回確認したWeb根拠]\n${compact || '(有効な根拠なし)'}`,
    },
  ];
}

export class TalkSysVoiceAgent extends TalkSysVoiceAgentV21 {
  async collectSearchEvidence(query, transcript, history, context) {
    const connection = connectionFrom(context);
    const started = Date.now();
    const decision = groundingDecisionV22(query || transcript, history);

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
      waitPhrase: '少し調べますね。',
    });
    send(connection, {
      type: 'search_trace',
      phase: 'searching',
      message: '外部事実を検索根拠で確認',
      resolvedQuestion: String(query || transcript || '').trim(),
    });

    let result;
    try {
      result = await collectGroundedEvidenceV22(query || transcript, history, {
        signal: context?.signal,
        onProgress: (event) => send(connection, { type: 'search_trace', ...event }),
      });
    } catch (error) {
      result = {
        revision: SEARCH_TOOL_V22_REVISION,
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
      provider: SEARCH_TOOL_V22_REVISION,
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
        message: '確認できた根拠だけで回答を生成',
      });

      if (!result.sources?.length) {
        yield '確認できる根拠を取得できなかったため、この点は推測で断定しません。';
        send(connection, {
          type: 'search_trace',
          phase: 'done',
          resolvedQuestion: result.resolvedQuestion,
          queries: result.queries,
          evidenceCount: 0,
          sources: [],
          message: '根拠不足のため断定を停止',
        });
        return;
      }

      yield* streamBoundedQualityConversation(self.env.AI, evidenceMessages(history, transcript, result), {
        signal: context?.signal,
        maxTokens: 380,
        openTimeoutMs: 2600,
        firstTokenTimeoutMs: 2900,
        fallbackTimeoutMs: 3800,
        sessionAffinity: sessionAffinity(context),
      });

      send(connection, {
        type: 'search_trace',
        phase: 'done',
        resolvedQuestion: result.resolvedQuestion,
        queries: result.queries,
        evidenceCount: result.sources?.length || 0,
        sources: (result.sources || []).slice(0, 8).map((item) => ({ title: item.title, url: item.url })),
        message: '根拠限定回答を完了',
      });
    })();
  }

  normalConversationTurn(transcript, context, history) {
    const quick = quickCasualReply(transcript);
    if (quick) {
      return this.trackAssistant((async function* () { yield quick; })(), context, 'instant-local-v22', transcript);
    }

    const quality = String(transcript || '').length >= 120 || QUALITY_INTENT_RE.test(String(transcript || ''));
    const messages = normalMessages(history, transcript, quality);
    const options = {
      signal: context?.signal,
      maxTokens: quality ? 300 : 240,
      openTimeoutMs: quality ? 2200 : 1700,
      firstTokenTimeoutMs: quality ? 2500 : 2000,
      fallbackTimeoutMs: quality ? 3200 : 2600,
      sessionAffinity: sessionAffinity(context),
    };

    return this.trackAssistant(
      quality
        ? streamBoundedQualityConversation(this.env.AI, messages, options)
        : streamBoundedLiveConversation(this.env.AI, messages, options),
      context,
      quality ? 'quality-nonfact-v22' : 'live-nonfact-v22',
      transcript,
    );
  }

  async onTurn(transcript, context) {
    const connection = connectionFrom(context);
    const history = this.getTalkSysHistory(connection);
    const decision = groundingDecisionV22(transcript, history);
    send(connection, {
      type: 'grounding_policy',
      revision: GROUNDING_POLICY_V22_REVISION,
      search: decision.search,
      reason: decision.reason,
      riskTags: decision.riskTags,
    });

    if (requiresGroundingSearchV22(transcript, history)) {
      return this.trackAssistant(
        this.mandatoryGroundedTurn(transcript, context, history),
        context,
        'grounded-search-v22',
        transcript,
      );
    }
    return this.normalConversationTurn(transcript, context, history);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/voice-health') {
      const response = await workerV21.fetch(request, env, ctx);
      let data = {};
      try { data = await response.json(); } catch {}
      return Response.json({
        ...data,
        ok: true,
        voiceRevision: VOICE_REVISION,
        conversationOrchestrator: 'grounding-by-default-agent-v22',
        toolCalling: 'grounding-policy-router-v22',
        groundingPolicy: GROUNDING_POLICY_V22_REVISION,
        groundingByDefault: true,
        factualQuestionsSearchByDefault: true,
        nonSearchRouteExternalFactAssertionsForbidden: true,
        evidenceOnlyExternalFacts: true,
        insufficientEvidenceStopsAssertion: true,
        contextualFollowupGrounding: true,
        domainSpecificSearchRoutingOnlyOptimizesRetrieval: true,
        webSearchTool: SEARCH_TOOL_V22_REVISION,
      }, {
        headers: {
          'cache-control': 'no-store',
          'x-talksys-voice-revision': VOICE_REVISION,
        },
      });
    }

    return workerV21.fetch(request, env, ctx);
  },
};

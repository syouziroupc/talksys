import workerV20, { TalkSysVoiceAgent as TalkSysVoiceAgentV20 } from './worker-v20.js';
import { CLOUDFLARE_LIVE_CLIENT_V21 } from './cloudflare-live-client-v21.js';
import { streamBoundedQualityConversation } from './bounded-conversation.js';
import { cleanSpeechText } from './voice-helpers.js';
import { ensureConnectionSession } from './conversation-memory.js';
import {
  collectWebEvidenceV21,
  requiresFreshSearchV21,
  SEARCH_TOOL_V21_REVISION,
} from './search-v21.js';

const VOICE_REVISION = 'cloudflare-agent-v21-mobile-transit-reliability';
const FALLBACK_SYSTEM_PROMPT = `あなたはTalkSysという日本語の電話相談AIです。
直前の回答経路が一度失敗したため、同じ質問に対して別経路で回答します。
同じ通話の会話履歴を使い、既に分かっている条件を引き継いでください。
現在の価格、在庫、店舗、運行、乗換、営業時間、ニュースなど外部確認が必要な事実は推測してはいけません。
通常の相談・一般知識だけを、結論を先に2〜4文程度で自然に答えてください。
内部エラー、再試行、モデル、検索経路についてはユーザーに説明しないでください。`;

function connectionFrom(context) {
  return context?.connection || context || null;
}

function sessionAffinity(context) {
  const connection = connectionFrom(context);
  const source = String(connection?.id || '').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 96);
  return source ? `talksys-v21-${source}` : '';
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

function fallbackMessages(history, userText, partial = '') {
  const messages = [
    { role: 'system', content: FALLBACK_SYSTEM_PROMPT },
    ...(Array.isArray(history) ? history.slice(-14) : []),
    { role: 'user', content: String(userText || '').trim() },
  ];
  if (partial) {
    messages.push({ role: 'assistant', content: partial });
    messages.push({
      role: 'user',
      content: '直前の回答は途中まで届いています。内容を最初から繰り返さず、自然な続きだけを短く返してください。',
    });
  }
  return messages;
}

export class TalkSysVoiceAgent extends TalkSysVoiceAgentV20 {
  async collectSearchEvidence(query, transcript, history, context) {
    const connection = connectionFrom(context);
    const started = Date.now();
    send(connection, {
      type: 'search_status',
      phase: 'searching',
      searched: true,
      waitPhrase: '少し調べますね。',
    });
    send(connection, {
      type: 'search_trace',
      phase: 'searching',
      message: 'Web検索を開始',
      resolvedQuestion: String(query || transcript || '').trim(),
    });

    let result;
    try {
      result = await collectWebEvidenceV21(query || transcript, history, {
        signal: context?.signal,
        onProgress: (event) => send(connection, { type: 'search_trace', ...event }),
      });
    } catch (error) {
      result = {
        revision: SEARCH_TOOL_V21_REVISION,
        resolvedQuestion: String(query || transcript || '').trim(),
        queries: [String(query || transcript || '').trim()].filter(Boolean),
        sources: [],
        evidence: '',
        elapsedMs: Date.now() - started,
        error: String(error?.message || error).slice(0, 180),
      };
      send(connection, {
        type: 'search_trace',
        phase: 'evidence_ready',
        resolvedQuestion: result.resolvedQuestion,
        queries: result.queries,
        evidenceCount: 0,
        sources: [],
        message: '検索結果を取得できませんでした',
      });
    }

    send(connection, {
      type: 'search_status',
      phase: 'done',
      searched: true,
      provider: SEARCH_TOOL_V21_REVISION,
      resolvedQuestion: result.resolvedQuestion,
      queries: result.queries,
      evidenceUseful: Boolean(result.sources?.length),
      sources: (result.sources || []).slice(0, 10).map((item) => ({ title: item.title, url: item.url })),
      timings: { searchMs: result.elapsedMs },
    });
    return result;
  }

  trackAssistant(iterable, context, tier, userText = '') {
    const self = this;
    const connection = connectionFrom(context);
    return (async function* () {
      ensureConnectionSession(connection);
      const runtime = self.runtimeFor(connection);
      runtime.currentAssistantText = '';
      runtime.assistantSpeechAt = Date.now();
      let failed = false;

      try {
        send(connection, { type: 'model_route', tier });
        for await (const delta of iterable) {
          const value = String(delta || '');
          if (!value) continue;
          runtime.currentAssistantText += value;
          yield value;
        }
      } catch {
        failed = true;
      }

      if (failed && !String(tier || '').includes('search')) {
        const partial = cleanSpeechText(runtime.currentAssistantText);
        try {
          const history = self.getTalkSysHistory(connection);
          const retry = streamBoundedQualityConversation(
            self.env.AI,
            fallbackMessages(history, userText, partial),
            {
              signal: context?.signal,
              maxTokens: partial ? 180 : 340,
              openTimeoutMs: 3200,
              firstTokenTimeoutMs: 3400,
              fallbackTimeoutMs: 4200,
              sessionAffinity: sessionAffinity(context),
            },
          );
          for await (const delta of retry) {
            const value = String(delta || '');
            if (!value) continue;
            runtime.currentAssistantText += value;
            yield value;
          }
        } catch {}
      }

      if (!runtime.currentAssistantText) {
        const safeFailure = String(tier || '').includes('search')
          ? '確認できる根拠が揃わなかったため、推測で案内することは避けます。'
          : '現在この回答を生成できません。';
        runtime.currentAssistantText = safeFailure;
        yield safeFailure;
      }

      const clean = cleanSpeechText(runtime.currentAssistantText);
      if (clean) runtime.lastAssistantText = clean;
      self.rememberConversationTurn(context, userText, clean);
      runtime.currentAssistantText = '';
      runtime.assistantSpeechAt = Date.now();
    })();
  }

  async onTurn(transcript, context) {
    const connection = connectionFrom(context);
    const history = this.getTalkSysHistory(connection);
    if (requiresFreshSearchV21(transcript, history)) {
      return this.trackAssistant(
        this.mandatorySearchTurn(transcript, context, history),
        context,
        'deterministic-search-v21',
        transcript,
      );
    }
    return this.normalConversationTurn(transcript, context, history);
  }
}

async function searchSmoke(transcript, history = []) {
  const started = Date.now();
  try {
    const result = await collectWebEvidenceV21(transcript, history);
    return Response.json({
      ok: Boolean(result.sources?.length),
      routedToSearch: requiresFreshSearchV21(transcript, history),
      revision: SEARCH_TOOL_V21_REVISION,
      resolvedQuestion: result.resolvedQuestion,
      queries: result.queries,
      evidenceCount: result.sources?.length || 0,
      elapsedMs: result.elapsedMs,
      sources: (result.sources || []).slice(0, 10).map((item) => ({ title: item.title, url: item.url, engine: item.engine })),
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return Response.json({
      ok: false,
      routedToSearch: requiresFreshSearchV21(transcript, history),
      revision: SEARCH_TOOL_V21_REVISION,
      error: String(error?.message || error).slice(0, 240),
      elapsedMs: Date.now() - started,
    }, { status: 500, headers: { 'cache-control': 'no-store' } });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/cloudflare-live.js') {
      return serveScript(CLOUDFLARE_LIVE_CLIENT_V21);
    }

    if (request.method === 'GET' && url.pathname === '/api/search-smoke-transit') {
      return searchSmoke('鷺沼駅から二子玉川駅までの乗り換え案内を知りたいです');
    }

    if (request.method === 'GET' && url.pathname === '/api/search-smoke-yokohama-followup') {
      return searchSmoke('店頭で安いところ 横浜駅周辺にない', [
        { role: 'user', content: 'パソコンの買い替えについて相談したいです' },
        { role: 'user', content: 'ネットサーフィンと動画視聴ぐらいしかしません' },
        { role: 'user', content: '5万円だったらどんなものがあるかな' },
      ]);
    }

    if (request.method === 'GET' && url.pathname === '/voice-health') {
      const response = await workerV20.fetch(request, env, ctx);
      let data = {};
      try { data = await response.json(); } catch {}
      return Response.json({
        ...data,
        ok: true,
        voiceRevision: VOICE_REVISION,
        conversationOrchestrator: 'tiered-fast-agent-v21',
        toolCalling: 'deterministic-search-router-v21',
        modelDecidesToolUse: false,
        mobileAudioContextPrimedOnUserGesture: true,
        audioContextConstructorFallback: true,
        proactiveCallGreeting: true,
        proactiveGreetingText: 'お電話ありがとうございます。AIチャットサポートです。今日はどのようなご相談でしょうか？',
        hiddenModelFailureRetry: true,
        userFacingMidStreamRetryMessageRemoved: true,
        transitQueriesRequireFreshSearch: true,
        stationAreaFollowupsUseConversationContext: true,
        webSearchTool: SEARCH_TOOL_V21_REVISION,
        transitSmokeEndpoint: '/api/search-smoke-transit',
        yokohamaFollowupSmokeEndpoint: '/api/search-smoke-yokohama-followup',
      }, {
        headers: {
          'cache-control': 'no-store',
          'x-talksys-voice-revision': VOICE_REVISION,
        },
      });
    }

    return workerV20.fetch(request, env, ctx);
  },
};

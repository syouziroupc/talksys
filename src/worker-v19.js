import baseWorker, { TalkSysVoiceAgent as BaseTalkSysVoiceAgent } from './worker-v14.js';
import appV19 from './index-v19.js';
import { SEARCH_TRACE_CLIENT } from './search-trace-client.js';
import { answerWithContextualVerifiedSearchV19 } from './search-v19.js';
import { generateSearchFiller } from './search-orchestrator.js';
import { streamBoundedQualityConversation } from './bounded-conversation.js';
import { cleanSpeechText } from './voice-helpers.js';

const VOICE_REVISION = 'cloudflare-live-v19.1';

const RECOMMENDATION_SYSTEM_PROMPT = `あなたはTalkSysという日本語の電話相談アシスタントです。
今回は、直前までの会話条件を使ってユーザー自身へのおすすめ・助言を答えます。
検索結果のタイトルや検索行為そのものを答えにしてはいけません。
現在価格、在庫、営業時間、現在の店舗情報など、Web確認が必要な現在事実は推測しないでください。
一方、安定した一般知識から答えられる用途、必要性能、選び方、優先順位は具体的に答えてください。
「おすすめを教えて」と言われたら、結論を先に出し、何を選べばよいかを曖昧にせず示してください。
直前の会話で分かっている用途、予算感、地域などを聞き直さないでください。
電話で自然に聞ける短い日本語にし、URL、Markdown、検索メタ説明は読み上げないでください。`;

export function isGeneralRecommendationFollowup(text) {
  const value = String(text || '').trim().replace(/\s+/g, '');
  if (!value || value.length > 40) return false;
  if (/(現在|最新|価格|値段|在庫|営業時間|店|店舗|販売店|どこ|市内|県内|買える|売って|検索|調べ)/i.test(value)) return false;
  return /^(?:君|あなた|AI)?(?:が|の)?(?:おすすめ(?:を)?(?:教えて(?:ほしい|欲しい)?|知りたい|して|は(?:何|どれ)?|ある(?:の)?|お願い)|何がおすすめ|どれがおすすめ|何がいい|どれがいい)[。！？!?]*$/i.test(value);
}

function sessionAffinity(context) {
  const connection = context?.connection || context || null;
  const source = String(connection?.id || '').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 96);
  return source ? `talksys-v19-${source}` : '';
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

export class TalkSysVoiceAgent extends BaseTalkSysVoiceAgent {
  async onTurn(transcript, context) {
    if (isGeneralRecommendationFollowup(transcript)) {
      const history = this.getTalkSysHistory(context?.connection);
      const messages = [
        { role: 'system', content: RECOMMENDATION_SYSTEM_PROMPT },
        ...history,
        { role: 'user', content: transcript },
      ];
      return this.trackAssistant(
        streamBoundedQualityConversation(this.env.AI, messages, {
          signal: context?.signal,
          maxTokens: 360,
          openTimeoutMs: 2600,
          firstTokenTimeoutMs: 2900,
          fallbackTimeoutMs: 3200,
          sessionAffinity: sessionAffinity(context),
        }),
        context,
        'quality-recommendation',
        transcript,
      );
    }
    return super.onTurn(transcript, context);
  }

  searchResponse(transcript, context, history) {
    const self = this;
    return this.trackAssistant((async function* () {
      send(context?.connection, { type: 'search_status', phase: 'planning', searched: true });
      send(context?.connection, {
        type: 'search_trace',
        phase: 'planning',
        message: '直前の会話から対象・用途・予算などを復元しています',
      });

      let settled = false;
      let secondProgressTimer = null;
      const searchPromise = answerWithContextualVerifiedSearchV19(
        self.env.AI,
        transcript,
        history,
        {
          signal: context?.signal,
          sessionAffinity: sessionAffinity(context),
          onProgress: (event) => send(context?.connection, { type: 'search_trace', ...event }),
        },
      ).finally(() => {
        settled = true;
        if (secondProgressTimer) clearTimeout(secondProgressTimer);
      });

      const fillerPromise = generateSearchFiller(self.env.AI, transcript, history, context?.signal)
        .catch(() => '前の話を踏まえて確認しています。少し待ってください。');

      secondProgressTimer = setTimeout(() => {
        if (settled || context?.signal?.aborted) return;
        send(context?.connection, {
          type: 'search_status',
          phase: 'searching',
          searched: true,
          waitPhrase: '条件を引き継いで詳しく確認しています。もう少し待ってください。',
        });
      }, 5200);

      const first = await Promise.race([
        searchPromise.then((result) => ({ type: 'result', result })),
        fillerPromise.then((text) => ({ type: 'filler', text })),
      ]);

      let result;
      if (first.type === 'filler') {
        const filler = cleanSpeechText(first.text);
        if (filler && !context?.signal?.aborted) {
          send(context?.connection, { type: 'search_status', phase: 'searching', searched: true, waitPhrase: filler });
        }
        result = await searchPromise;
      } else {
        result = first.result;
      }

      send(context?.connection, {
        type: 'search_status',
        phase: 'done',
        searched: true,
        provider: result.provider,
        model: result.model,
        planned: Boolean(result.planned),
        resolvedQuestion: result.resolvedQuestion || transcript,
        queries: Array.isArray(result.queries) ? result.queries.slice(0, 10) : [],
        rounds: Number(result.rounds) || 1,
        evidenceUseful: Boolean(result.evidenceUseful),
        auditPassed: Boolean(result.auditPassed),
        answerFallback: Boolean(result.answerFallback),
        timings: result.timings || null,
        sources: Array.isArray(result.sources)
          ? result.sources.slice(0, 10).map((item) => ({ title: item.title, url: item.url }))
          : [],
      });

      yield String(result.text || '条件を引き継いだ検索は完了しました。取得できた根拠から回答します。');
    })(), context, 'verified-context-search-v19', transcript);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return appV19.fetch(request, env, ctx);
    }
    if (request.method === 'GET' && url.pathname === '/search-trace.js') {
      return serveScript(SEARCH_TRACE_CLIENT);
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      return appV19.fetch(request, env, ctx);
    }
    if (request.method === 'GET' && url.pathname === '/voice-health') {
      const response = await baseWorker.fetch(request, env, ctx);
      let data = {};
      try { data = await response.json(); } catch {}
      return Response.json({
        ...data,
        ok: true,
        voiceRevision: VOICE_REVISION,
        contextualSearch: 'planner-first-v19',
        searchRawConversationSeedDisabled: true,
        searchPlannerBeforeRetrieval: true,
        searchContextConstraintGuard: true,
        generalRecommendationRoute: 'quality-conversation-no-search',
        searchAnswerCascade: 'grounded-primary/grounded-fallback/quality/live/deterministic',
        searchEmptyPlaceholderDisabled: true,
        searchProcessTrace: true,
        searchProcessTraceExposesPrivateReasoning: false,
        searchProcessTraceFields: ['phase', 'resolvedQuestion', 'queries', 'evidenceCount', 'sources', 'answerRoute', 'auditPassed', 'timings'],
      }, { headers: { 'cache-control': 'no-store', 'x-talksys-voice-revision': VOICE_REVISION } });
    }

    return baseWorker.fetch(request, env, ctx);
  },
};

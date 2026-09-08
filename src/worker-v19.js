import baseWorker, { TalkSysVoiceAgent as BaseTalkSysVoiceAgent } from './worker-v14.js';
import appV19 from './index-v19.js';
import { SEARCH_TRACE_CLIENT } from './search-trace-client.js';
import { answerWithContextualVerifiedSearchV19 } from './search-v19.js';
import { generateSearchFiller } from './search-orchestrator.js';
import { cleanSpeechText } from './voice-helpers.js';

const VOICE_REVISION = 'cloudflare-live-v19.0';

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

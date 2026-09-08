import workerV23, { TalkSysVoiceAgent } from './worker-v23.js';
import { CLOUDFLARE_LIVE_CLIENT_V23_FINAL } from './cloudflare-live-client-v23-final.js';
import { collectGroundedEvidenceV23, SEARCH_TOOL_V23_REVISION } from './search-v23.js';

export { TalkSysVoiceAgent };

function serveScript(source) {
  return new Response(source, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
      'x-talksys-voice-revision': 'cloudflare-agent-v23-mobile-search-pc-quality',
    },
  });
}

async function searchSmoke(query, history = []) {
  const started = Date.now();
  try {
    const result = await collectGroundedEvidenceV23(query, history);
    return Response.json({
      ok: Boolean(result.sources?.length),
      revision: SEARCH_TOOL_V23_REVISION,
      resolvedQuestion: result.resolvedQuestion,
      queries: result.queries,
      evidenceCount: result.sources?.length || 0,
      elapsedMs: result.elapsedMs,
      sources: (result.sources || []).slice(0, 10).map((item) => ({
        title: item.title,
        url: item.url,
        engine: item.engine,
        excerpt: String(item.excerpt || item.snippet || '').slice(0, 600),
      })),
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return Response.json({
      ok: false,
      revision: SEARCH_TOOL_V23_REVISION,
      error: String(error?.message || error).slice(0, 240),
      elapsedMs: Date.now() - started,
    }, { status: 500, headers: { 'cache-control': 'no-store' } });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/cloudflare-live.js') {
      return serveScript(CLOUDFLARE_LIVE_CLIENT_V23_FINAL);
    }
    if (request.method === 'GET' && url.pathname === '/api/search-smoke-v23-transit') {
      return searchSmoke('鷺沼から用賀までの行き方を知りたい');
    }
    if (request.method === 'GET' && url.pathname === '/api/search-smoke-v23-pc') {
      return searchSmoke('CF-SV8のUSB-C充電対応と主要仕様を詳しく知りたい');
    }
    if (request.method === 'GET' && url.pathname === '/voice-health') {
      const response = await workerV23.fetch(request, env, ctx);
      let data = {};
      try { data = await response.json(); } catch {}
      return Response.json({
        ...data,
        serverTtsOwnershipGuard: true,
        browserAnswerFallbackOnlyWhenServerTtsNotExpected: true,
        explicitTtsErrorBrowserFallback: true,
        transitSearchSmokeEndpoint: '/api/search-smoke-v23-transit',
        pcSearchSmokeEndpoint: '/api/search-smoke-v23-pc',
      }, {
        headers: {
          'cache-control': 'no-store',
          'x-talksys-voice-revision': 'cloudflare-agent-v23-mobile-search-pc-quality',
        },
      });
    }
    return workerV23.fetch(request, env, ctx);
  },
};

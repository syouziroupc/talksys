import workerV23, { TalkSysVoiceAgent } from './worker-v23.js';
import { CLOUDFLARE_LIVE_CLIENT_V23_FINAL } from './cloudflare-live-client-v23-final.js';

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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/cloudflare-live.js') {
      return serveScript(CLOUDFLARE_LIVE_CLIENT_V23_FINAL);
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

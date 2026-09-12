// Historical TalkSys v24 production wrapper. Not part of the current production graph.
import workerV24, { TalkSysVoiceAgent } from '../../src/worker-v24.js';
import { CLOUDFLARE_LIVE_CLIENT_V24 } from '../../src/cloudflare-live-client-v24.js';
import { collectGroundedEvidenceV23, SEARCH_TOOL_V23_REVISION } from '../../src/search-v23.js';

export { TalkSysVoiceAgent };

const VOICE_REVISION = 'cloudflare-agent-v24-xperia-fast-bargein';

function serveScript(source) {
  return new Response(source, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
      'x-talksys-voice-revision': VOICE_REVISION,
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
      sources: (result.sources || []).slice(0, 8).map((item) => ({
        title: item.title,
        url: item.url,
        engine: item.engine,
        excerpt: String(item.excerpt || item.snippet || '').slice(0, 500),
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

const CONTEXT_SMOKE_HISTORY = [
  { role: 'user', content: 'パソコンの買い替えについて相談したいんですけど' },
  { role: 'user', content: 'YouTube とネットサーフィンぐらいしかしないかな 安いやつがいい' },
  { role: 'user', content: 'どういうところで買うのがいいのかな' },
  { role: 'user', content: 'お店で買いたいな' },
  { role: 'user', content: '中古だったら どこで買うべき？' },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/cloudflare-live.js') {
      return serveScript(CLOUDFLARE_LIVE_CLIENT_V24);
    }
    if (request.method === 'GET' && url.pathname === '/api/search-smoke-v24-context') {
      return searchSmoke('神奈川県横浜市でおすすめのお店ある', CONTEXT_SMOKE_HISTORY);
    }
    if (request.method === 'GET' && url.pathname === '/api/search-smoke-v24-transit') {
      return searchSmoke('鷺沼から用賀までの行き方を知りたい');
    }
    if (request.method === 'GET' && url.pathname === '/api/search-smoke-v24-pc') {
      return searchSmoke('CF-SV8のUSB-C充電対応と主要仕様を知りたい');
    }
    if (request.method === 'GET' && url.pathname === '/voice-health') {
      const response = await workerV24.fetch(request, env, ctx);
      let data = {};
      try { data = await response.json(); } catch {}
      return Response.json({
        ...data,
        voiceRevision: VOICE_REVISION,
        serverTtsOwnershipGuard: true,
        browserStreamingTts: true,
        browserStreamingTtsStartsAtFirstSentence: true,
        preListeningMicFrames: true,
        startCallPendingGuard: true,
        voiceBargeIn: true,
        hardStopOnUserTranscript: true,
        xperiaHandshakeFix: true,
        contextualSearchSubjectOnlyCarryover: true,
        contextualSearchSmokeEndpoint: '/api/search-smoke-v24-context',
      }, {
        headers: {
          'cache-control': 'no-store',
          'x-talksys-voice-revision': VOICE_REVISION,
        },
      });
    }
    return workerV24.fetch(request, env, ctx);
  },
};

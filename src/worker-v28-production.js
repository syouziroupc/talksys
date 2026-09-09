import workerV28, { TalkSysVoiceAgent, VOICE_REVISION_V28 } from './worker-v28.js';
import { CLOUDFLARE_LIVE_CLIENT_V26 } from './cloudflare-live-client-v26.js';
import { collectGroundedEvidenceV26, SEARCH_TOOL_V26_REVISION } from './search-v26.js';
import { TALKSYS_CONVERSATION_MODEL_V28 } from './qwen-conversation-v28.js';

export { TalkSysVoiceAgent };

function serveScript(source) {
  return new Response(source, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
      'x-talksys-voice-revision': VOICE_REVISION_V28,
    },
  });
}

async function searchSmoke(query, history = []) {
  const started = Date.now();
  try {
    const result = await collectGroundedEvidenceV26(query, history);
    return Response.json({
      ok: Boolean(result.sources?.length),
      revision: SEARCH_TOOL_V26_REVISION,
      resolvedQuestion: result.resolvedQuestion,
      queries: result.queries,
      evidenceCount: result.sources?.length || 0,
      elapsedMs: result.elapsedMs,
      directTransitError: result.directTransitError || '',
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
      revision: SEARCH_TOOL_V26_REVISION,
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

const IN_FLIGHT_TRANSIT_HISTORY = [
  { role: 'user', content: '鷺沼から相模大野までの乗換案内が知りたい' },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/cloudflare-live.js') return serveScript(CLOUDFLARE_LIVE_CLIENT_V26);
    if (request.method === 'GET' && url.pathname === '/api/search-smoke-v28-context') {
      return searchSmoke('神奈川県横浜市でおすすめのお店ある', CONTEXT_SMOKE_HISTORY);
    }
    if (request.method === 'GET' && url.pathname === '/api/search-smoke-v28-transit-followup') {
      return searchSmoke('どうですか', IN_FLIGHT_TRANSIT_HISTORY);
    }
    if (request.method === 'GET' && url.pathname === '/api/search-smoke-v28-pc') {
      return searchSmoke('CF-SV8のUSB-C充電対応と主要仕様を知りたい');
    }
    if (request.method === 'GET' && url.pathname === '/voice-health') {
      const response = await workerV28.fetch(request, env, ctx);
      let data = {};
      try { data = await response.json(); } catch {}
      return Response.json({
        ...data,
        ok: true,
        voiceRevision: VOICE_REVISION_V28,
        architecture: 'whisper-qwen-melotts-single-path',
        conversationModel: TALKSYS_CONVERSATION_MODEL_V28,
        conversationModelFallback: null,
        conversationEmergencyFallback: null,
        searchAnswerModel: TALKSYS_CONVERSATION_MODEL_V28,
        multiModelFallback: false,
        sameModelRetryOnce: true,
        legacyGlmActive: false,
        legacyGrokActive: false,
        legacyDeepSeekActive: false,
        legacyGptOssActive: false,
        ttsPrimary: '@cf/myshell-ai/melotts',
        ttsFallback: null,
        searchTool: SEARCH_TOOL_V26_REVISION,
        contextualSearchSmokeEndpoint: '/api/search-smoke-v28-context',
        transitFollowupSmokeEndpoint: '/api/search-smoke-v28-transit-followup',
      }, {
        headers: {
          'cache-control': 'no-store',
          'x-talksys-voice-revision': VOICE_REVISION_V28,
        },
      });
    }
    return workerV28.fetch(request, env, ctx);
  },
};

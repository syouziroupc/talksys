import workerV27, { TalkSysVoiceAgent } from './worker-v27.js';
import { CLOUDFLARE_LIVE_CLIENT_V26 } from './cloudflare-live-client-v26.js';
import { collectGroundedEvidenceV26, SEARCH_TOOL_V26_REVISION } from './search-v26.js';
import {
  GROK_CONVERSATION_MODEL_V27,
  GROK_FALLBACK_MODEL_V27,
  GROK_EMERGENCY_MODEL_V27,
} from './grok-conversation-v27.js';

export { TalkSysVoiceAgent };

const VOICE_REVISION = 'cloudflare-agent-v27-grok-conversation-android-realtime';

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
    if (request.method === 'GET' && url.pathname === '/api/search-smoke-v27-context') {
      return searchSmoke('神奈川県横浜市でおすすめのお店ある', CONTEXT_SMOKE_HISTORY);
    }
    if (request.method === 'GET' && url.pathname === '/api/search-smoke-v27-transit-followup') {
      return searchSmoke('どうですか', IN_FLIGHT_TRANSIT_HISTORY);
    }
    if (request.method === 'GET' && url.pathname === '/api/search-smoke-v27-pc') {
      return searchSmoke('CF-SV8のUSB-C充電対応と主要仕様を知りたい');
    }
    if (request.method === 'GET' && url.pathname === '/voice-health') {
      const response = await workerV27.fetch(request, env, ctx);
      let data = {};
      try { data = await response.json(); } catch {}
      return Response.json({
        ...data,
        ok: true,
        voiceRevision: VOICE_REVISION,
        conversationOrchestrator: 'grok-primary-bounded-cascade-v27',
        conversationModel: GROK_CONVERSATION_MODEL_V27,
        conversationModelFallback: GROK_FALLBACK_MODEL_V27,
        conversationEmergencyFallback: GROK_EMERGENCY_MODEL_V27,
        primaryConversationModel: GROK_CONVERSATION_MODEL_V27,
        qualityConversationModel: GROK_FALLBACK_MODEL_V27,
        llmLive: GROK_CONVERSATION_MODEL_V27,
        llmQuality: GROK_FALLBACK_MODEL_V27,
        llmFallback: GROK_EMERGENCY_MODEL_V27,
        llmRouting: 'instant-local / grok-primary / glm-fallback / qwen-emergency / bounded-contextual-search',
        grokConversationPrimary: true,
        grokNonReasoningRealtime: true,
        grokStreaming: true,
        glmOnlyConversation: false,
        ttsPrimary: '@cf/myshell-ai/melotts',
        ttsPrimaryLanguage: 'ja',
        ttsPrimaryVoice: 'melotts-ja',
        ttsFallback: null,
        grokTtsPrimary: false,
        grokTtsTextNormalization: false,
        grokTtsMp3: false,
        inFlightUserContext: true,
        searchTool: SEARCH_TOOL_V26_REVISION,
        directTransitEvidenceFallback: true,
        mobileAudioPipelineV26: true,
        androidAudioWorkletPreferred: true,
        androidScriptProcessorFallback: true,
        androidPcmFrameProbeBeforeCall: true,
        androidCaptureBackendFailover: true,
        androidLifecycleResume: true,
        mobileWebSocketHardRecovery: true,
        contextualSearchSubjectOnlyCarryover: true,
        contextualSearchSmokeEndpoint: '/api/search-smoke-v27-context',
        transitFollowupSmokeEndpoint: '/api/search-smoke-v27-transit-followup',
      }, {
        headers: {
          'cache-control': 'no-store',
          'x-talksys-voice-revision': VOICE_REVISION,
        },
      });
    }
    return workerV27.fetch(request, env, ctx);
  },
};

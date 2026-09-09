import workerV25, { TalkSysVoiceAgent as TalkSysVoiceAgentV25 } from './worker-v25.js';
import { CLOUDFLARE_LIVE_CLIENT_V26 } from './cloudflare-live-client-v26.js';
import { SEARCH_TRACE_CLIENT_V23 } from './search-trace-client-v23.js';
import { recordConversationUser } from './conversation-memory.js';
import { augmentGroundedEvidenceV26, SEARCH_TOOL_V26_REVISION } from './search-v26.js';
import { GrokJapaneseTTSV26, GROK_TTS_MODEL_V26, GROK_TTS_VOICE_V26 } from './grok-japanese-tts-v26.js';
import { GLM_CONVERSATION_MODEL_V25 } from './glm-conversation-v25.js';

const VOICE_REVISION = 'cloudflare-agent-v26-grok-tts-android-realtime';

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

export class TalkSysVoiceAgent extends TalkSysVoiceAgentV25 {
  // Grok is the primary Japanese voice. The implementation itself falls back to
  // Cloudflare-hosted MeloTTS if Unified Billing/Grok is temporarily unavailable.
  tts = new GrokJapaneseTTSV26(this.env.AI);

  trackAssistant(iterable, context, tier, userText = '') {
    const connection = connectionFrom(context);
    const user = String(userText || '').trim();
    if (user) recordConversationUser(connection, user);
    return super.trackAssistant(iterable, context, tier, userText);
  }

  async collectSearchEvidence(query, transcript, history, context) {
    const base = await super.collectSearchEvidence(query, transcript, history, context);
    if (base?.sources?.length) return { ...base, revision: SEARCH_TOOL_V26_REVISION };

    const connection = connectionFrom(context);
    const augmented = await augmentGroundedEvidenceV26(base, {
      signal: context?.signal,
      onProgress: (event) => send(connection, { type: 'search_trace', ...event }),
    });
    if (augmented?.sources?.length) {
      send(connection, {
        type: 'search_status',
        phase: 'done',
        searched: true,
        provider: SEARCH_TOOL_V26_REVISION,
        resolvedQuestion: augmented.resolvedQuestion,
        queries: augmented.queries,
        evidenceUseful: true,
        sources: augmented.sources.slice(0, 8).map((item) => ({ title: item.title, url: item.url })),
        timings: { searchMs: augmented.elapsedMs },
      });
    }
    return augmented;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/cloudflare-live.js') return serveScript(CLOUDFLARE_LIVE_CLIENT_V26);
    if (request.method === 'GET' && url.pathname === '/search-trace.js') return serveScript(SEARCH_TRACE_CLIENT_V23);

    if (request.method === 'GET' && url.pathname === '/voice-health') {
      const response = await workerV25.fetch(request, env, ctx);
      let data = {};
      try { data = await response.json(); } catch {}
      return Response.json({
        ...data,
        ok: true,
        voiceRevision: VOICE_REVISION,
        conversationOrchestrator: 'glm-fast-bounded-visible-answer-v26',
        conversationModel: GLM_CONVERSATION_MODEL_V25,
        conversationModelFallback: GLM_CONVERSATION_MODEL_V25,
        glmOnlyConversation: true,
        glmReasoningEffort: 'low',
        glmVisibleFirstTokenDeadline: true,
        glmReasoningOnlyStreamEscape: true,
        glmBoundedSynchronousRecovery: true,
        inFlightUserContext: true,
        duplicateUserTurnGuard: true,
        searchTool: SEARCH_TOOL_V26_REVISION,
        directTransitEvidenceFallback: true,
        ttsPrimary: GROK_TTS_MODEL_V26,
        ttsPrimaryLanguage: 'ja',
        ttsPrimaryVoice: GROK_TTS_VOICE_V26,
        ttsFallback: '@cf/myshell-ai/melotts',
        grokTtsTextNormalization: true,
        grokTtsMp3: true,
        mobileAudioPipelineV26: true,
        androidAudioWorkletPreferred: true,
        androidScriptProcessorFallback: true,
        androidPcmFrameProbeBeforeCall: true,
        androidCaptureBackendFailover: true,
        androidLifecycleResume: true,
        mobileWebSocketHardRecovery: true,
        microphoneDiagnostics: true,
      }, {
        headers: {
          'cache-control': 'no-store',
          'x-talksys-voice-revision': VOICE_REVISION,
        },
      });
    }

    return workerV25.fetch(request, env, ctx);
  },
};

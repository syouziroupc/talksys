import { routeAgentRequest } from 'agents';
import app from './index.js';
import legacyWorker, { TalkSysVoiceAgent as LegacyTalkSysVoiceAgent } from './worker.js';
import { GEMINI_LIVE_PRIMARY } from './gemini-live-primary.js';
import { VOICE_MARKER_BRIDGE } from './voice-marker-bridge.js';
import { REALTIME_VOICE_CLIENT } from './realtime-voice-client.js';
import { VOICE_FALLBACK_CLIENT } from './voice-fallback-client.js';
import { wrapAI } from './voice-helpers.js';

const VOICE_REVISION = 'gemini-live-v13';
const GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview';
const GEMINI_LIVE_ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';

// Keep the old Cloudflare Voice durable object intact as an explicit fallback.
// The primary browser path no longer uses this class when Gemini is configured.
export class TalkSysVoiceAgent extends LegacyTalkSysVoiceAgent {}

function noStoreJson(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      'cache-control': 'no-store',
      'x-talksys-voice-revision': VOICE_REVISION,
    },
  });
}

async function mintGeminiLiveToken(env) {
  if (!env.GEMINI_API_KEY) {
    return noStoreJson({
      available: false,
      reason: 'GEMINI_API_KEY_not_configured',
      model: GEMINI_LIVE_MODEL,
    }, 503);
  }

  const now = Date.now();
  const expireTime = new Date(now + 30 * 60 * 1000).toISOString();
  const newSessionExpireTime = new Date(now + 2 * 60 * 1000).toISOString();
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      uses: 1,
      expireTime,
      newSessionExpireTime,
      liveConnectConstraints: {
        model: GEMINI_LIVE_MODEL,
        config: {
          responseModalities: ['AUDIO'],
          sessionResumption: {},
        },
      },
    }),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 700);
    return noStoreJson({
      available: false,
      reason: 'gemini_ephemeral_token_failed',
      status: response.status,
      detail,
    }, 502);
  }

  const token = await response.json();
  if (!token?.name) {
    return noStoreJson({ available: false, reason: 'gemini_ephemeral_token_empty' }, 502);
  }

  return noStoreJson({
    available: true,
    token: token.name,
    model: GEMINI_LIVE_MODEL,
    endpoint: GEMINI_LIVE_ENDPOINT,
    expireTime,
    newSessionExpireTime,
  });
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

function injectGeminiClient(html) {
  const script = '<script src="/gemini-live.js"></script>';
  return html.includes('</body>') ? html.replace('</body>', script + '</body>') : html + script;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/gemini-live.js') return serveScript(GEMINI_LIVE_PRIMARY);

    // Legacy files are intentionally not loaded by the page. The Gemini client
    // fetches them only when token provisioning is unavailable or repeatedly
    // fails, making Cloudflare Voice a true fallback instead of a parallel path.
    if (url.pathname === '/voice-marker-bridge.js') return serveScript(VOICE_MARKER_BRIDGE);
    if (url.pathname === '/realtime-voice.js') return serveScript(REALTIME_VOICE_CLIENT);
    if (url.pathname === '/voice-fallback.js') return serveScript(VOICE_FALLBACK_CLIENT);

    if (url.pathname === '/api/gemini-live-token' && request.method === 'POST') {
      return mintGeminiLiveToken(env);
    }

    if (url.pathname === '/voice-health') {
      return noStoreJson({
        ok: true,
        voiceRevision: VOICE_REVISION,
        primary: 'gemini-live',
        geminiLiveConfigured: Boolean(env.GEMINI_API_KEY),
        geminiLiveModel: GEMINI_LIVE_MODEL,
        clientToServer: true,
        ephemeralTokens: true,
        constrainedEphemeralTokens: true,
        nativeAudioInput: 'pcm16-16khz',
        nativeAudioOutput: 'pcm16-24khz',
        inputAudioTranscription: true,
        outputAudioTranscription: true,
        japaneseSpeechLanguage: 'ja-JP',
        hybridVad: true,
        googleSearchGrounding: true,
        screenFunctionCalling: true,
        sessionResumption: true,
        contextWindowCompression: true,
        bargeIn: true,
        typedChatTransport: 'realtimeInput.text',
        typedChatSharesLiveSession: true,
        legacyCloudflareVoiceFallback: true,
      });
    }

    // Preserve existing diagnostic endpoints for the fallback implementation.
    if ((url.pathname === '/api/voice-smoke' && request.method === 'GET') ||
        (url.pathname === '/api/web-search' && request.method === 'GET')) {
      return legacyWorker.fetch(request, env, ctx);
    }

    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    const wrappedEnv = Object.assign({}, env, { AI: wrapAI(env.AI) });
    const response = await app.fetch(request, wrappedEnv, ctx);
    const type = response.headers.get('content-type') || '';
    if (response.ok && type.includes('text/html')) {
      const html = await response.text();
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      headers.set('cache-control', 'no-store');
      headers.set('x-talksys-voice-revision', VOICE_REVISION);
      return new Response(injectGeminiClient(html), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    return response;
  },
};

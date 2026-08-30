import { routeAgentRequest } from 'agents';
import app from './index.js';
import legacyWorker, { TalkSysVoiceAgent as LegacyTalkSysVoiceAgent } from './worker.js';
import { GEMINI_LIVE_V13_CLIENT } from './gemini-live-v13-client.js';
import { VOICE_MARKER_BRIDGE } from './voice-marker-bridge.js';
import { REALTIME_VOICE_CLIENT } from './realtime-voice-client.js';
import { VOICE_FALLBACK_CLIENT } from './voice-fallback-client.js';
import { wrapAI } from './voice-helpers.js';

const VOICE_REVISION = 'gemini-live-v13.1';
const GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview';
const GEMINI_TRANSCRIBE_MODEL = 'gemini-3.5-transcribe-live';
const GEMINI_LIVE_ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';

// Kept only so existing Durable Object bindings and fallback sessions remain valid.
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

function isAllowedTokenRequest(request) {
  const origin = request.headers.get('origin');
  if (!origin || origin === 'null') return true; // Electron/file clients and server-side canary.
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

async function mintGeminiLiveToken(request, env) {
  if (!isAllowedTokenRequest(request)) return noStoreJson({ available: false, reason: 'origin_not_allowed' }, 403);
  if (!env.GEMINI_API_KEY) {
    return noStoreJson({ available: false, reason: 'GEMINI_API_KEY_not_configured', model: GEMINI_LIVE_MODEL }, 503);
  }

  let body = {};
  try { body = await request.json(); } catch {}
  const purpose = body?.purpose === 'transcription' ? 'transcription' : 'conversation';
  const model = purpose === 'transcription' ? GEMINI_TRANSCRIBE_MODEL : GEMINI_LIVE_MODEL;
  const now = Date.now();
  const expireTime = new Date(now + 30 * 60 * 1000).toISOString();
  const newSessionExpireTime = new Date(now + 90 * 1000).toISOString();

  // Keep the token single-use, short-lived and model-bound. The Live setup has
  // several evolving fields (Search, transcription, tools, VAD), so constraining
  // only the model avoids rejecting valid new config while never exposing the
  // long-lived API key to the browser/Electron client.
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
      liveConnectConstraints: { model: `models/${model}` },
    }),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 700);
    return noStoreJson({ available: false, reason: 'gemini_ephemeral_token_failed', purpose, status: response.status, detail }, 502);
  }

  const token = await response.json();
  if (!token?.name) return noStoreJson({ available: false, reason: 'gemini_ephemeral_token_empty', purpose }, 502);

  return noStoreJson({
    available: true,
    token: token.name,
    purpose,
    model,
    endpoint: GEMINI_LIVE_ENDPOINT,
    expireTime,
    newSessionExpireTime,
    revision: VOICE_REVISION,
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

    if (url.pathname === '/gemini-live.js') return serveScript(GEMINI_LIVE_V13_CLIENT);
    if (url.pathname === '/voice-marker-bridge.js') return serveScript(VOICE_MARKER_BRIDGE);
    if (url.pathname === '/realtime-voice.js') return serveScript(REALTIME_VOICE_CLIENT);
    if (url.pathname === '/voice-fallback.js') return serveScript(VOICE_FALLBACK_CLIENT);

    if (url.pathname === '/api/gemini-live-token' && request.method === 'POST') return mintGeminiLiveToken(request, env);

    if (url.pathname === '/voice-health') {
      return noStoreJson({
        ok: true,
        voiceRevision: VOICE_REVISION,
        primary: 'gemini-live',
        geminiLiveConfigured: Boolean(env.GEMINI_API_KEY),
        geminiLiveModel: GEMINI_LIVE_MODEL,
        dedicatedTranscriptionModel: GEMINI_TRANSCRIBE_MODEL,
        clientToServer: true,
        ephemeralTokens: true,
        singleUseModelBoundTokens: true,
        nativeAudioInput: 'pcm16-16khz',
        nativeAudioOutput: 'pcm16-24khz',
        nativeAudioResponse: true,
        parallelHighAccuracyTranscription: true,
        inputAudioTranscription: true,
        inputAudioLanguageCodes: ['ja-JP'],
        smartJapaneseTranscription: true,
        customVocabulary: true,
        outputAudioTranscription: true,
        hybridVad: true,
        localEndSilenceMs: 560,
        serverVadFallbackMs: 800,
        googleSearchGrounding: true,
        spokenSearchWaitPhrase: true,
        screenFunctionCalling: true,
        sessionResumption: true,
        proactiveSessionRotation: true,
        contextWindowCompression: true,
        thinkingLevel: 'LOW',
        typedChatTransport: 'realtimeInput.text',
        typedChatSharesLiveSession: true,
        legacyCloudflareVoiceFallback: true,
      });
    }

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
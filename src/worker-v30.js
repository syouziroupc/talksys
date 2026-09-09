import workerV29, { TalkSysVoiceAgent } from './worker-v29.js';
import { CLOUDFLARE_LIVE_CLIENT_V30 } from './cloudflare-live-client-v30.js';
import { GROK_CONVERSATION_MODEL_V29 } from './grok-conversation-v29.js';
import { GrokJapaneseTTSV29, GROK_TTS_MODEL_V29, GROK_TTS_VOICE_V29 } from './grok-japanese-tts-v29.js';

export { TalkSysVoiceAgent };

export const VOICE_REVISION_V30 = 'cloudflare-agent-v30-real-grok-audio-runtime';

function noStore(headers = {}) {
  return { 'cache-control': 'no-store', ...headers };
}

function serveScript(source) {
  return new Response(source, {
    headers: noStore({
      'content-type': 'text/javascript; charset=utf-8',
      'x-talksys-voice-revision': VOICE_REVISION_V30,
    }),
  });
}

function sameOriginBrowserRequest(request) {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (origin && origin !== url.origin) return false;
  if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) return false;
  return true;
}

async function grokTtsResponse(request, env) {
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  if (!sameOriginBrowserRequest(request)) return new Response('Forbidden', { status: 403 });
  let body = {};
  try { body = await request.json(); } catch {}
  const text = String(body?.text || '').trim().slice(0, 1600);
  if (!text) return Response.json({ ok: false, error: 'text_required' }, { status: 400, headers: noStore() });

  const started = Date.now();
  try {
    const tts = new GrokJapaneseTTSV29(env.AI);
    const audio = await tts.synthesize(text, AbortSignal.timeout(15000));
    if (!audio?.byteLength) throw new Error('empty_audio');
    return new Response(audio, {
      headers: noStore({
        'content-type': 'audio/mpeg',
        'content-length': String(audio.byteLength),
        'x-talksys-tts-provider': GROK_TTS_MODEL_V29,
        'x-talksys-tts-voice': GROK_TTS_VOICE_V29,
        'x-talksys-tts-elapsed-ms': String(Date.now() - started),
        'x-talksys-voice-revision': VOICE_REVISION_V30,
      }),
    });
  } catch (error) {
    return Response.json({
      ok: false,
      provider: GROK_TTS_MODEL_V29,
      error: String(error?.message || error).slice(0, 220),
      elapsedMs: Date.now() - started,
    }, { status: 502, headers: noStore({ 'x-talksys-voice-revision': VOICE_REVISION_V30 }) });
  }
}

function extractText(result) {
  if (typeof result === 'string') return result.trim();
  if (!result) return '';
  if (typeof result.response === 'string') return result.response.trim();
  if (typeof result.text === 'string') return result.text.trim();
  const root = result.result && typeof result.result === 'object' ? result.result : result;
  const content = root?.choices?.[0]?.message?.content ?? result?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.map((x) => x?.text || x?.content || '').join('').trim();
  return '';
}

async function bindingProbe(env) {
  const result = {
    ok: false,
    revision: VOICE_REVISION_V30,
    conversation: { model: GROK_CONVERSATION_MODEL_V29, ok: false },
    tts: { model: GROK_TTS_MODEL_V29, voice: GROK_TTS_VOICE_V29, ok: false },
  };

  const chatStarted = Date.now();
  try {
    const answer = await env.AI.run(GROK_CONVERSATION_MODEL_V29, {
      messages: [{ role: 'user', content: '日本語で「接続確認OK」とだけ答えてください。' }],
      max_completion_tokens: 32,
      temperature: 0,
      stream: false,
    }, { signal: AbortSignal.timeout(12000) });
    const text = extractText(answer);
    result.conversation = {
      ...result.conversation,
      ok: Boolean(text),
      elapsedMs: Date.now() - chatStarted,
      sample: text.slice(0, 80),
    };
  } catch (error) {
    result.conversation = {
      ...result.conversation,
      ok: false,
      elapsedMs: Date.now() - chatStarted,
      error: String(error?.message || error).slice(0, 220),
    };
  }

  const ttsStarted = Date.now();
  try {
    const tts = new GrokJapaneseTTSV29(env.AI);
    const audio = await tts.synthesize('音声接続確認です。', AbortSignal.timeout(15000));
    result.tts = {
      ...result.tts,
      ok: Boolean(audio?.byteLength),
      elapsedMs: Date.now() - ttsStarted,
      bytes: Number(audio?.byteLength || 0),
    };
  } catch (error) {
    result.tts = {
      ...result.tts,
      ok: false,
      elapsedMs: Date.now() - ttsStarted,
      error: String(error?.message || error).slice(0, 220),
    };
  }

  result.ok = result.conversation.ok && result.tts.ok;
  return Response.json(result, {
    status: result.ok ? 200 : 502,
    headers: noStore({ 'x-talksys-voice-revision': VOICE_REVISION_V30 }),
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/cloudflare-live.js') return serveScript(CLOUDFLARE_LIVE_CLIENT_V30);
    if (url.pathname === '/api/grok-tts-v30') return grokTtsResponse(request, env);
    if (request.method === 'GET' && url.pathname === '/api/grok-binding-probe-v30') return bindingProbe(env);
    if (request.method === 'GET' && url.pathname === '/voice-health') {
      return Response.json({
        ok: true,
        voiceRevision: VOICE_REVISION_V30,
        architecture: 'grok-authoritative-browser-audio-v30',
        conversationModel: GROK_CONVERSATION_MODEL_V29,
        conversationModelFallback: null,
        sameModelRetryOnce: true,
        grokStartupTimeoutFloorMs: 4500,
        ttsPrimary: GROK_TTS_MODEL_V29,
        ttsFallback: null,
        grokTtsJapaneseVoice: GROK_TTS_VOICE_V29,
        browserSpeechSynthesisEnabled: false,
        typedSpeechUsesGrokTts: true,
        typedSpeechEndpoint: '/api/grok-tts-v30',
        serverAudioAuthoritative: true,
        mobileAudioPipelineV26: true,
        microphoneDiagnostics: true,
      }, { headers: noStore({ 'x-talksys-voice-revision': VOICE_REVISION_V30 }) });
    }
    return workerV29.fetch(request, env, ctx);
  },
};

import * as runtime from './runtime.js';

export * from './runtime.js';

export const TELEPHONY_REVISION = 'talksys-telephony-v85-deepgram-phone-tts';
export const DEFAULT_DEEPGRAM_PHONE_VOICE = 'aura-2-fujin-ja';
export const DEEPGRAM_PHONE_SAMPLE_RATE = 24000;
export const DEEPGRAM_PHONE_BIT_RATE = 48000;

function deepgramApiKey(env) {
  return typeof env?.DEEPGRAM_API_KEY === 'string' ? env.DEEPGRAM_API_KEY.trim() : '';
}

export function deepgramPhoneTtsConfigured(env) {
  return Boolean(deepgramApiKey(env));
}

export function deepgramPhoneTtsModel(env) {
  const configured = typeof env?.TELEPHONY_TTS_MODEL === 'string' ? env.TELEPHONY_TTS_MODEL.trim() : '';
  return configured || DEFAULT_DEEPGRAM_PHONE_VOICE;
}

function isLikelyMp3(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 3) return false;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true; // ID3
  return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0; // MPEG audio frame sync
}

export async function synthesizeDeepgramPhoneMp3(env, text, fetchImpl = fetch) {
  const apiKey = deepgramApiKey(env);
  if (!apiKey) throw new Error('deepgram_api_key_missing');

  const spoken = String(text || '').trim();
  if (!spoken) return null;

  const url = new URL('https://api.deepgram.com/v1/speak');
  url.searchParams.set('model', deepgramPhoneTtsModel(env));
  url.searchParams.set('encoding', 'mp3');
  url.searchParams.set('sample_rate', String(DEEPGRAM_PHONE_SAMPLE_RATE));
  url.searchParams.set('bit_rate', String(DEEPGRAM_PHONE_BIT_RATE));

  const response = await fetchImpl(url.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({ text: spoken }),
  });

  if (!response?.ok) {
    const status = Number(response?.status || 0);
    throw new Error(`deepgram_tts_http_${status || 'error'}`);
  }

  const audio = await response.arrayBuffer();
  const bytes = new Uint8Array(audio);
  if (!bytes.byteLength) throw new Error('deepgram_tts_empty_audio');
  if (!isLikelyMp3(bytes)) throw new Error('deepgram_tts_invalid_mp3');
  return audio;
}

async function decorateHealth(response, env, deps) {
  if (!response?.ok) return response;
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== 'object') return response;

  const injected = typeof deps?.synthesize === 'function';
  const deepgram = deepgramPhoneTtsConfigured(env) && !injected;
  const provider = injected ? 'injected-tts' : deepgram ? 'deepgram-aura-2' : 'cloudflare-melotts-legacy-fallback';
  const outputAudio = injected
    ? 'Injected TTS MP3 → Telnyx'
    : deepgram
      ? `Deepgram Aura-2 MP3 ${DEEPGRAM_PHONE_SAMPLE_RATE / 1000}kHz/${DEEPGRAM_PHONE_BIT_RATE / 1000}kbps → Telnyx`
      : 'Cloudflare MeloTTS MP3 → Telnyx (legacy fallback)';

  const headers = new Headers(response.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify({
    ...payload,
    revision: TELEPHONY_REVISION,
    phoneTtsProvider: provider,
    deepgramTtsConfigured: deepgramPhoneTtsConfigured(env),
    phoneTtsModel: deepgram ? deepgramPhoneTtsModel(env) : null,
    phoneTtsSampleRate: deepgram ? DEEPGRAM_PHONE_SAMPLE_RATE : null,
    phoneTtsBitRate: deepgram ? DEEPGRAM_PHONE_BIT_RATE : null,
    outputAudio,
  }, null, 2), {
    status: response.status,
    headers,
  });
}

export async function handleTelephonyRequest(request, env, ctx, deps = {}) {
  const deepgramConfigured = deepgramPhoneTtsConfigured(env);
  const hasInjectedTts = typeof deps?.synthesize === 'function';
  const effectiveDeps = deepgramConfigured && !hasInjectedTts
    ? {
        ...deps,
        synthesize: (text) => synthesizeDeepgramPhoneMp3(env, text),
      }
    : deps;

  const response = await runtime.handleTelephonyRequest(request, env, ctx, effectiveDeps);
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/telephony-health' && response) {
    return decorateHealth(response, env, deps);
  }
  return response;
}

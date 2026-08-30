import { cleanSpeechText, MeloJapaneseTTS } from './voice-helpers.js';

export const PRIMARY_TTS_MODEL = 'inworld/tts-1.5-max';
export const SECONDARY_TTS_MODEL = 'openai/tts-1';
export const FALLBACK_TTS_MODEL = '@cf/myshell-ai/melotts';

function audioUrl(result) {
  const candidates = [
    result?.result?.audio,
    result?.audio,
    result?.result?.url,
    result?.url,
  ];
  for (const value of candidates) if (typeof value === 'string' && /^https:\/\//i.test(value)) return value;
  return '';
}

async function fetchAudio(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`TTS audio fetch failed: ${response.status}`);
  const audio = await response.arrayBuffer();
  if (!audio || audio.byteLength < 100) throw new Error('TTS returned empty audio');
  return audio;
}

function isUnifiedUnavailable(error) {
  const message = String(error?.message || error || '');
  return /(?:402|403|credit|billing|payment|quota|not enabled|gateway|unauthor|forbidden)/i.test(message);
}

export class CloudflareJapaneseTTS {
  constructor(ai) {
    this.ai = ai;
    this.melo = new MeloJapaneseTTS(ai);
    this.unifiedDisabledUntil = 0;
    this.preferredProvider = 'unified';
  }

  async synthesize(text, signal) {
    const spoken = cleanSpeechText(text);
    if (!spoken) return null;

    if (Date.now() >= this.unifiedDisabledUntil) {
      try {
        const result = await this.ai.run(
          PRIMARY_TTS_MODEL,
          {
            text: spoken,
            voice_id: 'Hana',
            output_format: 'mp3',
            speaking_rate: 1.04,
            temperature: 0.75,
            timestamp_type: 'none',
            apply_text_normalization: true,
          },
          {
            gateway: { id: 'default' },
            ...(signal ? { signal } : {}),
          },
        );
        const url = audioUrl(result);
        if (url) {
          this.preferredProvider = 'inworld';
          return await fetchAudio(url, signal);
        }
        throw new Error('Inworld TTS returned no audio URL');
      } catch (error) {
        if (isUnifiedUnavailable(error)) this.unifiedDisabledUntil = Date.now() + 60000;
      }

      try {
        const result = await this.ai.run(
          SECONDARY_TTS_MODEL,
          {
            text: spoken,
            voice: 'nova',
            response_format: 'mp3',
            speed: 1.04,
          },
          {
            gateway: { id: 'default' },
            ...(signal ? { signal } : {}),
          },
        );
        const url = audioUrl(result);
        if (url) {
          this.preferredProvider = 'openai-tts';
          return await fetchAudio(url, signal);
        }
        throw new Error('OpenAI TTS returned no audio URL');
      } catch (error) {
        if (isUnifiedUnavailable(error)) this.unifiedDisabledUntil = Date.now() + 60000;
      }
    }

    this.preferredProvider = 'melotts';
    return this.melo.synthesize(spoken, signal);
  }
}

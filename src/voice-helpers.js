export const LEGACY_TEXT_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
export const LEGACY_VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
export const TEXT_MODEL = '@cf/zai-org/glm-4.7-flash';
export const VISION_MODEL = '@cf/google/gemma-4-26b-a4b-it';
export const JAPANESE_TTS_MODEL = '@cf/myshell-ai/melotts';

export function extractText(value, depth = 0) {
  if (depth > 6 || value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = extractText(item, depth + 1);
      if (text) return text;
    }
    return '';
  }
  if (typeof value !== 'object') return '';

  const candidates = [
    value.response,
    value.choices?.[0]?.message?.content,
    value.choices?.[0]?.text,
    value.result,
    value.output_text,
    value.output,
    value.message?.content,
    value.content,
    value.text,
  ];
  for (const candidate of candidates) {
    if (candidate === value) continue;
    const text = extractText(candidate, depth + 1);
    if (text) return text;
  }
  return '';
}

export function cleanSpeechText(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, 'コード部分は画面で確認してください。')
    .replace(/https?:\/\/\S+/g, 'リンク')
    .replace(/[*_#>`~]/g, '')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseScreenDecision(text) {
  if (typeof text !== 'string') return { inspect: false, query: '' };
  const match = text.match(/\{[\s\S]*?\}/);
  if (!match) return { inspect: false, query: '' };
  try {
    const parsed = JSON.parse(match[0]);
    return {
      inspect: parsed.inspect === true,
      query: typeof parsed.query === 'string' ? parsed.query.trim().slice(0, 300) : '',
    };
  } catch {
    return { inspect: false, query: '' };
  }
}

function decodeBase64Audio(base64) {
  const value = String(base64 || '').trim();
  if (!value) return null;
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export async function normalizeAudioResult(result) {
  if (!result) return null;
  if (result instanceof Response) {
    if (!result.ok) return null;
    return result.arrayBuffer();
  }
  if (result instanceof ArrayBuffer) return result;
  if (result instanceof Uint8Array) {
    return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
  }
  if (result instanceof ReadableStream) {
    return new Response(result).arrayBuffer();
  }
  if (typeof result === 'string') return decodeBase64Audio(result);
  if (typeof result === 'object' && typeof result.audio === 'string') {
    return decodeBase64Audio(result.audio);
  }
  return null;
}

export class MeloJapaneseTTS {
  constructor(ai) {
    this.ai = ai;
  }

  async synthesize(text, signal) {
    const spoken = cleanSpeechText(text);
    if (!spoken) return null;
    const result = await this.ai.run(
      JAPANESE_TTS_MODEL,
      { prompt: spoken, lang: 'JP' },
      signal ? { signal } : undefined,
    );
    return normalizeAudioResult(result);
  }
}

export function wrapAI(ai) {
  return {
    async run(model, input) {
      const isVision = model === LEGACY_VISION_MODEL;
      const targetModel = model === LEGACY_TEXT_MODEL
        ? TEXT_MODEL
        : isVision
          ? VISION_MODEL
          : model;
      const targetInput = isVision
        ? {
            ...input,
            max_tokens: Math.max(512, Number(input?.max_tokens) || 0),
            chat_template_kwargs: {
              ...(input?.chat_template_kwargs || {}),
              enable_thinking: false,
            },
          }
        : input;
      const result = await ai.run(targetModel, targetInput);
      const response = extractText(result);
      return response ? { ...result, response } : result;
    },
  };
}

import app from './index.js';

const LEGACY_TEXT_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
const LEGACY_VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const TEXT_MODEL = '@cf/zai-org/glm-4.7-flash';
const VISION_MODEL = '@cf/google/gemma-4-26b-a4b-it';

function extractText(value, depth = 0) {
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

function wrapAI(ai) {
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

export default {
  async fetch(request, env, ctx) {
    const wrappedEnv = Object.assign({}, env, { AI: wrapAI(env.AI) });
    return app.fetch(request, wrappedEnv, ctx);
  },
};

export { extractText, wrapAI, TEXT_MODEL, VISION_MODEL };

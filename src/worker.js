import app from './index.js';

const LEGACY_TEXT_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
const LEGACY_VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const TEXT_MODEL = '@cf/zai-org/glm-4.7-flash';
const VISION_MODEL = '@cf/google/gemma-4-26b-a4b-it';

function extractText(result) {
  if (typeof result?.response === 'string') return result.response.trim();
  const content = result?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === 'string' ? part : part?.text || '').join('').trim();
  }
  if (typeof result?.result === 'string') return result.result.trim();
  if (typeof result?.output_text === 'string') return result.output_text.trim();
  return '';
}

function wrapAI(ai) {
  return {
    async run(model, input) {
      const targetModel = model === LEGACY_TEXT_MODEL
        ? TEXT_MODEL
        : model === LEGACY_VISION_MODEL
          ? VISION_MODEL
          : model;
      const result = await ai.run(targetModel, input);
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

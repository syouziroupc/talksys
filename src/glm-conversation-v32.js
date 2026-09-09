export const GLM_CONVERSATION_MODEL_V32 = '@cf/zai-org/glm-5.3-flash';
export const GLM_V32_HEDGE_DELAY_MS = 1700;

function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error('aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, Math.max(0, Number(ms) || 0));
    if (signal) signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('aborted'));
    }, { once: true });
  });
}

function withTimeout(promise, timeoutMs, label) {
  const ms = Math.max(1, Number(timeoutMs) || 1);
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function boundedSignal(parentSignal, timeoutMs) {
  const ms = Math.max(1, Number(timeoutMs) || 1);
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return parentSignal;
  const timeout = AbortSignal.timeout(ms);
  if (!parentSignal) return timeout;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([parentSignal, timeout]) : parentSignal;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((item) => typeof item === 'string' ? item : String(item?.text || item?.content || '')).join('');
}

export function readGlmFinalV32(result) {
  if (typeof result === 'string') return result.trim();
  if (!result) return '';
  for (const value of [result.response, result.result, result.text, result.output_text]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const choice = result.choices?.[0];
  const message = textFromContent(choice?.message?.content).trim();
  if (message) return message;
  if (typeof choice?.text === 'string') return choice.text.trim();
  return '';
}

function sanitizeAnswer(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

async function completeAttempt(ai, messages, options, attemptName) {
  const timeoutMs = Math.max(2600, Number(options.attemptTimeoutMs) || 4300);
  const signal = boundedSignal(options.signal, timeoutMs);
  const runOptions = {};
  if (signal) runOptions.signal = signal;
  if (options.sessionAffinity) runOptions.extraHeaders = { 'x-session-affinity': options.sessionAffinity };
  const result = await withTimeout(ai.run(GLM_CONVERSATION_MODEL_V32, {
    messages,
    stream: false,
    modalities: ['text'],
    max_completion_tokens: options.maxTokens ?? 300,
    temperature: options.temperature ?? 0.18,
    reasoning_effort: options.reasoningEffort ?? 'low',
  }, Object.keys(runOptions).length ? runOptions : undefined), timeoutMs + 100, `GLM v32 ${attemptName}`);
  const text = sanitizeAnswer(readGlmFinalV32(result));
  if (!text) throw new Error(`GLM v32 ${attemptName} returned no visible text`);
  return text;
}

export async function completeGlmConversationV32(ai, messages, options = {}) {
  const hedgeDelayMs = Math.max(250, Number(options.hedgeDelayMs) || GLM_V32_HEDGE_DELAY_MS);
  const primary = completeAttempt(ai, messages, options, 'primary');
  const hedge = (async () => {
    await delay(hedgeDelayMs, options.signal);
    return completeAttempt(ai, messages, { ...options, sessionAffinity: options.sessionAffinity ? `${options.sessionAffinity}-hedge` : '' }, 'hedge');
  })();
  try {
    return await Promise.any([primary, hedge]);
  } catch (error) {
    const reasons = Array.isArray(error?.errors) ? error.errors.map((item) => String(item?.message || item)).join(' / ') : String(error?.message || error);
    throw new Error(`GLM-5.3 Flash failed on both bounded attempts: ${reasons}`);
  }
}

// The voice agent still accepts an AsyncIterable. v32 intentionally yields one coherent
// completed answer instead of raw model token fragments. This prevents partial words from
// becoming separate TTS utterances and removes continuation-splice corruption.
export async function* streamGlmConversationV32(ai, messages, options = {}) {
  const text = await completeGlmConversationV32(ai, messages, options);
  if (text) yield text;
}

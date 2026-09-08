import {
  LIVE_CONVERSATION_MODEL,
  QUALITY_CONVERSATION_MODEL,
  modelInput,
  readDelta,
  readFinal,
} from './cloudflare-llm.js';

function boundedSignal(parentSignal, timeoutMs) {
  const ms = Math.max(1, Number(timeoutMs) || 1);
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return parentSignal;
  const timeout = AbortSignal.timeout(ms);
  if (!parentSignal) return timeout;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([parentSignal, timeout]) : parentSignal;
}

async function withTimeout(promise, timeoutMs, label) {
  const ms = Math.max(1, Number(timeoutMs) || 1);
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function open(ai, model, messages, options, stream) {
  const timeoutMs = stream ? (options.openTimeoutMs ?? 2200) : (options.fallbackTimeoutMs ?? 2800);
  const signal = boundedSignal(options.signal, timeoutMs);
  const runOptions = {};
  if (signal) runOptions.signal = signal;
  if (options.sessionAffinity) runOptions.extraHeaders = { 'x-session-affinity': options.sessionAffinity };
  const request = ai.run(
    model,
    modelInput(model, messages, options.maxTokens ?? 280, options.temperature ?? 0.16, stream),
    Object.keys(runOptions).length ? runOptions : undefined,
  );
  return withTimeout(request, timeoutMs + 120, `Workers AI ${stream ? 'stream open' : 'fallback'}`);
}

async function readWithTimeout(reader, timeoutMs) {
  return withTimeout(reader.read(), timeoutMs, 'Workers AI first token');
}

async function* iterateResult(result, firstTokenTimeoutMs) {
  const byteStream = result && (result instanceof ReadableStream || typeof result.getReader === 'function');
  if (byteStream) {
    const reader = result.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let sawText = false;
    const consume = function* (raw) {
      const line = String(raw || '').trim();
      if (!line || line === 'data: [DONE]') return;
      const body = line.startsWith('data:') ? line.slice(5).trim() : line;
      if (!body || body === '[DONE]') return;
      try {
        const delta = readDelta(JSON.parse(body));
        if (delta) {
          sawText = true;
          yield delta;
        }
      } catch {}
    };
    try {
      while (true) {
        const next = sawText ? await reader.read() : await readWithTimeout(reader, firstTokenTimeoutMs);
        if (next.done) break;
        pending += decoder.decode(next.value, { stream: true });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || '';
        for (const line of lines) yield* consume(line);
      }
      pending += decoder.decode();
      if (pending.trim()) yield* consume(pending);
    } finally {
      try { reader.releaseLock(); } catch {}
    }
    return;
  }

  if (result && typeof result[Symbol.asyncIterator] === 'function') {
    let first = true;
    const iterator = result[Symbol.asyncIterator]();
    while (true) {
      const next = first
        ? await withTimeout(iterator.next(), firstTokenTimeoutMs, 'Workers AI first token')
        : await iterator.next();
      first = false;
      if (next.done) break;
      const delta = readDelta(next.value);
      if (delta) yield delta;
    }
    return;
  }

  const text = readFinal(result);
  if (text) yield text;
}

async function* cascade(ai, models, messages, options = {}) {
  let lastError = null;
  for (const model of [...new Set(models.filter(Boolean))]) {
    let yielded = false;
    try {
      const stream = await open(ai, model, messages, options, true);
      try {
        for await (const delta of iterateResult(stream, options.firstTokenTimeoutMs ?? 2500)) {
          yielded = true;
          yield delta;
        }
      } catch (error) {
        lastError = error;
        if (yielded) return;
      }
      if (yielded) return;

      const fallback = await open(ai, model, messages, options, false);
      const text = readFinal(fallback);
      if (text) {
        yield text;
        return;
      }
      lastError = new Error('Workers AI returned no text');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('No bounded conversation model produced text');
}

export function streamBoundedLiveConversation(ai, messages, options = {}) {
  return cascade(ai, [LIVE_CONVERSATION_MODEL], messages, options);
}

export function streamBoundedQualityConversation(ai, messages, options = {}) {
  return cascade(ai, [QUALITY_CONVERSATION_MODEL, LIVE_CONVERSATION_MODEL], messages, options);
}

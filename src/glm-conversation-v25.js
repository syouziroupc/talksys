export const GLM_CONVERSATION_MODEL_V25 = '@cf/zai-org/glm-5.3-flash';

function withTimeout(promise, timeoutMs, label) {
  const ms = Math.max(1, Number(timeoutMs) || 1);
  let timer;
  try {
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
  } catch (error) {
    if (timer) clearTimeout(timer);
    throw error;
  }
}

function boundedSignal(parentSignal, timeoutMs) {
  const ms = Math.max(1, Number(timeoutMs) || 1);
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return parentSignal;
  const timeout = AbortSignal.timeout(ms);
  if (!parentSignal) return timeout;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([parentSignal, timeout]) : parentSignal;
}

function readDelta(payload) {
  if (!payload) return '';
  if (typeof payload.response === 'string') return payload.response;
  if (typeof payload.text === 'string') return payload.text;
  const choice = payload.choices?.[0];
  const content = choice?.delta?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((item) => typeof item === 'string' ? item : (item?.text || '')).join('');
  }
  if (typeof choice?.text === 'string') return choice.text;
  return '';
}

function readFinal(result) {
  if (typeof result === 'string') return result.trim();
  if (!result) return '';
  if (typeof result.response === 'string') return result.response.trim();
  if (typeof result.result === 'string') return result.result.trim();
  if (typeof result.text === 'string') return result.text.trim();
  const choice = result.choices?.[0];
  if (typeof choice?.message?.content === 'string') return choice.message.content.trim();
  if (typeof choice?.text === 'string') return choice.text.trim();
  return '';
}

function inputFor(messages, options, stream) {
  return {
    messages,
    stream,
    max_completion_tokens: options.maxTokens ?? 260,
    temperature: options.temperature ?? 0.12,
    reasoning_effort: options.reasoningEffort ?? 'low',
  };
}

async function open(ai, messages, options, stream) {
  const timeoutMs = stream ? (options.openTimeoutMs ?? 1800) : (options.fallbackTimeoutMs ?? 2600);
  const signal = boundedSignal(options.signal, timeoutMs);
  const runOptions = {};
  if (signal) runOptions.signal = signal;
  if (options.sessionAffinity) runOptions.extraHeaders = { 'x-session-affinity': options.sessionAffinity };
  return withTimeout(
    ai.run(
      GLM_CONVERSATION_MODEL_V25,
      inputFor(messages, options, stream),
      Object.keys(runOptions).length ? runOptions : undefined,
    ),
    timeoutMs + 120,
    `Workers AI ${stream ? 'GLM stream open' : 'GLM fallback'}`,
  );
}

async function* iterateStream(result, firstTokenTimeoutMs) {
  const byteStream = result && (result instanceof ReadableStream || typeof result.getReader === 'function');
  if (byteStream) {
    const reader = result.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let sawText = false;
    try {
      while (true) {
        const next = sawText
          ? await reader.read()
          : await withTimeout(reader.read(), firstTokenTimeoutMs, 'Workers AI GLM first token');
        if (next.done) break;
        pending += decoder.decode(next.value, { stream: true });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || '';
        for (const raw of lines) {
          const line = String(raw || '').trim();
          if (!line || line === 'data: [DONE]') continue;
          const body = line.startsWith('data:') ? line.slice(5).trim() : line;
          if (!body || body === '[DONE]') continue;
          try {
            const delta = readDelta(JSON.parse(body));
            if (delta) {
              sawText = true;
              yield delta;
            }
          } catch {}
        }
      }
      pending += decoder.decode();
      const tail = pending.trim();
      if (tail && tail !== 'data: [DONE]') {
        const body = tail.startsWith('data:') ? tail.slice(5).trim() : tail;
        try {
          const delta = readDelta(JSON.parse(body));
          if (delta) yield delta;
        } catch {}
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
    return;
  }

  if (result && typeof result[Symbol.asyncIterator] === 'function') {
    const iterator = result[Symbol.asyncIterator]();
    let first = true;
    while (true) {
      const next = first
        ? await withTimeout(iterator.next(), firstTokenTimeoutMs, 'Workers AI GLM first token')
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

export async function* streamGlmConversationV25(ai, messages, options = {}) {
  let yielded = false;
  let partial = '';
  try {
    const stream = await open(ai, messages, options, true);
    for await (const delta of iterateStream(stream, options.firstTokenTimeoutMs ?? 2100)) {
      const value = String(delta || '');
      if (!value) continue;
      yielded = true;
      partial += value;
      yield value;
    }
    if (yielded) return;
  } catch (error) {
    if (yielded) return;
  }

  const fallback = await open(ai, messages, options, false);
  const text = readFinal(fallback);
  if (text) {
    yield text;
    return;
  }
  throw new Error('GLM-5.3 Flash returned no text');
}

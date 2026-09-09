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

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((item) => {
    if (typeof item === 'string') return item;
    if (typeof item?.text === 'string') return item.text;
    if (typeof item?.content === 'string') return item.content;
    return '';
  }).join('');
}

function readDelta(payload) {
  if (!payload) return '';
  if (typeof payload.response === 'string') return payload.response;
  if (typeof payload.text === 'string') return payload.text;
  const choice = payload.choices?.[0];
  const delta = choice?.delta;
  const content = textFromContent(delta?.content);
  if (content) return content;
  const messageContent = textFromContent(choice?.message?.content);
  if (messageContent) return messageContent;
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
  const messageContent = textFromContent(choice?.message?.content).trim();
  if (messageContent) return messageContent;
  if (typeof choice?.text === 'string') return choice.text.trim();
  return '';
}

function inputFor(messages, options, stream) {
  return {
    messages,
    stream,
    modalities: ['text'],
    max_completion_tokens: options.maxTokens ?? 260,
    temperature: options.temperature ?? 0.12,
    reasoning_effort: options.reasoningEffort ?? 'low',
  };
}

async function open(ai, messages, options, stream) {
  // Streaming opens must be quick. A synchronous recovery gets a longer but still
  // bounded window so GLM cannot leave a telephone turn hanging for tens of seconds.
  const timeoutMs = stream
    ? (options.openTimeoutMs ?? 1800)
    : Math.max(6000, options.fallbackTimeoutMs ?? 6000);
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
    timeoutMs + 150,
    `Workers AI ${stream ? 'GLM stream open' : 'GLM fallback'}`,
  );
}

async function* iterateStream(result, options = {}) {
  const firstVisibleTimeoutMs = Math.max(700, Number(options.firstTokenTimeoutMs) || 2100);
  const idleTimeoutMs = Math.max(900, Number(options.streamIdleTimeoutMs) || 2600);
  const totalTimeoutMs = Math.max(3500, Number(options.streamTotalTimeoutMs) || 12000);
  const startedAt = Date.now();
  const firstVisibleDeadline = startedAt + firstVisibleTimeoutMs;
  const totalDeadline = startedAt + totalTimeoutMs;

  const readWithDeadline = (reader, sawText) => {
    const now = Date.now();
    const totalRemaining = totalDeadline - now;
    if (totalRemaining <= 0) throw new Error('Workers AI GLM stream total timeout');
    const visibleRemaining = firstVisibleDeadline - now;
    if (!sawText && visibleRemaining <= 0) throw new Error('Workers AI GLM visible first-token timeout');
    const waitMs = sawText
      ? Math.min(idleTimeoutMs, totalRemaining)
      : Math.min(visibleRemaining, totalRemaining);
    return withTimeout(reader.read(), waitMs, sawText ? 'Workers AI GLM stream idle' : 'Workers AI GLM visible first token');
  };

  const byteStream = result && (result instanceof ReadableStream || typeof result.getReader === 'function');
  if (byteStream) {
    const reader = result.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let sawText = false;
    try {
      while (true) {
        const next = await readWithDeadline(reader, sawText);
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
          if (delta) {
            sawText = true;
            yield delta;
          }
        } catch {}
      }
    } finally {
      // cancel() matters when GLM is still emitting reasoning-only SSE chunks.
      try { await reader.cancel(); } catch {}
      try { reader.releaseLock(); } catch {}
    }
    return;
  }

  if (result && typeof result[Symbol.asyncIterator] === 'function') {
    const iterator = result[Symbol.asyncIterator]();
    let sawText = false;
    while (true) {
      const now = Date.now();
      const totalRemaining = totalDeadline - now;
      const visibleRemaining = firstVisibleDeadline - now;
      if (totalRemaining <= 0) throw new Error('Workers AI GLM async stream total timeout');
      if (!sawText && visibleRemaining <= 0) throw new Error('Workers AI GLM async visible first-token timeout');
      const waitMs = sawText
        ? Math.min(idleTimeoutMs, totalRemaining)
        : Math.min(visibleRemaining, totalRemaining);
      const next = await withTimeout(iterator.next(), waitMs, 'Workers AI GLM async stream');
      if (next.done) break;
      const delta = readDelta(next.value);
      if (delta) {
        sawText = true;
        yield delta;
      }
    }
    return;
  }

  const text = readFinal(result);
  if (text) yield text;
}

export async function* streamGlmConversationV25(ai, messages, options = {}) {
  let yielded = false;
  try {
    const stream = await open(ai, messages, options, true);
    for await (const delta of iterateStream(stream, options)) {
      const value = String(delta || '');
      if (!value) continue;
      yielded = true;
      yield value;
    }
    if (yielded) return;
  } catch {
    // If no visible answer arrived promptly, immediately switch to a bounded complete
    // response. Do not let reasoning-only SSE traffic keep a phone call waiting.
    if (yielded) return;
  }

  const fallback = await open(ai, messages, options, false);
  const text = readFinal(fallback);
  if (text) {
    yield text;
    return;
  }
  throw new Error('GLM-5.3 Flash returned no visible text');
}

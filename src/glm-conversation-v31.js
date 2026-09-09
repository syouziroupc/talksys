export const GLM_CONVERSATION_MODEL_V31 = '@cf/zai-org/glm-5.3-flash';

function withTimeout(promise, timeoutMs, label) {
  const ms = Math.max(1, Number(timeoutMs) || 1);
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
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
  const content = textFromContent(choice?.delta?.content);
  if (content) return content;
  const messageContent = textFromContent(choice?.message?.content);
  if (messageContent) return messageContent;
  if (typeof choice?.text === 'string') return choice.text;
  return '';
}

function readFinishReason(payload) {
  return String(payload?.choices?.[0]?.finish_reason || payload?.finish_reason || '').trim();
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
    max_completion_tokens: options.maxTokens ?? 240,
    temperature: options.temperature ?? 0.12,
    reasoning_effort: options.reasoningEffort ?? 'low',
  };
}

async function open(ai, messages, options, stream) {
  // v25 used sub-2-second opening limits and then a hidden 6-second synchronous
  // minimum. That combination caused needless abort/retry cycles. v31 gives the
  // normal stream enough room to open, while keeping both paths explicitly bounded.
  const timeoutMs = stream
    ? Math.max(1800, Number(options.openTimeoutMs) || 2400)
    : Math.max(2800, Number(options.fallbackTimeoutMs) || 4300);
  const signal = boundedSignal(options.signal, timeoutMs);
  const runOptions = {};
  if (signal) runOptions.signal = signal;
  if (options.sessionAffinity) runOptions.extraHeaders = { 'x-session-affinity': options.sessionAffinity };
  return withTimeout(
    ai.run(
      GLM_CONVERSATION_MODEL_V31,
      inputFor(messages, options, stream),
      Object.keys(runOptions).length ? runOptions : undefined,
    ),
    timeoutMs + 120,
    `Workers AI ${stream ? 'GLM stream open' : 'GLM complete fallback'}`,
  );
}

async function* iterateStream(result, options = {}, state = {}) {
  const firstVisibleTimeoutMs = Math.max(1700, Number(options.firstTokenTimeoutMs) || 2500);
  const idleTimeoutMs = Math.max(1400, Number(options.streamIdleTimeoutMs) || 3000);
  const totalTimeoutMs = Math.max(5500, Number(options.streamTotalTimeoutMs) || 12000);
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
    const consumeLine = (raw) => {
      const line = String(raw || '').trim();
      if (!line || line === 'data: [DONE]') return '';
      const body = line.startsWith('data:') ? line.slice(5).trim() : line;
      if (!body || body === '[DONE]') return '';
      try {
        const payload = JSON.parse(body);
        const reason = readFinishReason(payload);
        if (reason) state.finishReason = reason;
        return readDelta(payload);
      } catch {
        return '';
      }
    };
    try {
      while (true) {
        const next = await readWithDeadline(reader, sawText);
        if (next.done) break;
        pending += decoder.decode(next.value, { stream: true });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || '';
        for (const raw of lines) {
          const delta = consumeLine(raw);
          if (!delta) continue;
          sawText = true;
          state.sawText = true;
          yield delta;
        }
      }
      pending += decoder.decode();
      const delta = consumeLine(pending);
      if (delta) {
        state.sawText = true;
        yield delta;
      }
    } finally {
      // Reasoning-only SSE must not keep the telephone turn alive after the visible
      // deadline. Cancelling releases the Workers AI stream instead of leaking it.
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
      const reason = readFinishReason(next.value);
      if (reason) state.finishReason = reason;
      const delta = readDelta(next.value);
      if (!delta) continue;
      sawText = true;
      state.sawText = true;
      yield delta;
    }
    return;
  }

  const text = readFinal(result);
  if (text) {
    state.sawText = true;
    yield text;
  }
}

function continuationMessages(messages, partial) {
  const clean = String(partial || '').trim();
  if (!clean) return messages;
  return [
    ...messages,
    { role: 'assistant', content: clean },
    { role: 'user', content: '直前の回答は途中まで届いています。同じ内容を繰り返さず、続きだけを短く完成させてください。' },
  ];
}

function removeRepeatedPrefix(partial, text) {
  const prior = String(partial || '').trim();
  const next = String(text || '').trim();
  if (!prior || !next) return next;
  if (next.startsWith(prior)) return next.slice(prior.length).trimStart();
  return next;
}

export async function* streamGlmConversationV31(ai, messages, options = {}) {
  let partial = '';
  const state = { sawText: false, finishReason: '' };
  let streamFailed = false;

  try {
    const stream = await open(ai, messages, options, true);
    for await (const delta of iterateStream(stream, options, state)) {
      const value = String(delta || '');
      if (!value) continue;
      partial += value;
      yield value;
    }
    if (partial.trim() && state.finishReason !== 'length') return;
    if (partial.trim() && !state.finishReason) return;
  } catch {
    streamFailed = true;
  }

  // Same-model recovery only. A slow/reasoning-only/empty stream must never cause a
  // model cascade. If some text already reached the user, ask GLM only for the tail.
  const fallbackMessages = continuationMessages(messages, partial);
  try {
    const fallback = await open(ai, fallbackMessages, {
      ...options,
      maxTokens: partial ? Math.min(180, options.maxTokens ?? 180) : (options.maxTokens ?? 240),
    }, false);
    const text = removeRepeatedPrefix(partial, readFinal(fallback));
    if (text) {
      yield text;
      return;
    }
  } catch (error) {
    if (!streamFailed && partial.trim()) return;
    throw error;
  }

  if (partial.trim()) return;
  throw new Error('GLM-5.3 Flash returned no visible text after bounded same-model recovery');
}

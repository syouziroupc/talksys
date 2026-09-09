export const GROK_CONVERSATION_MODEL_V29 = 'xai/grok-4.20-0309-non-reasoning';

function withTimeout(promise, timeoutMs, label) {
  const ms = Math.max(1, Number(timeoutMs) || 1);
  let timer;
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
  const delta = textFromContent(choice?.delta?.content);
  if (delta) return delta;
  const message = textFromContent(choice?.message?.content);
  if (message) return message;
  return typeof choice?.text === 'string' ? choice.text : '';
}

function readFinal(result) {
  if (typeof result === 'string') return result.trim();
  if (!result) return '';
  if (typeof result.response === 'string') return result.response.trim();
  if (typeof result.text === 'string') return result.text.trim();
  if (typeof result.result === 'string') return result.result.trim();
  const root = result.result && typeof result.result === 'object' ? result.result : result;
  const choice = root?.choices?.[0] || result?.choices?.[0];
  const message = textFromContent(choice?.message?.content).trim();
  if (message) return message;
  return typeof choice?.text === 'string' ? choice.text.trim() : '';
}

function requestFor(messages, options, stream) {
  const request = {
    messages,
    stream,
    max_completion_tokens: options.maxTokens ?? 240,
    temperature: options.temperature ?? 0.12,
  };
  if (stream) request.stream_options = { include_usage: true };
  return request;
}

async function open(ai, messages, options, stream) {
  const timeoutMs = stream
    ? (options.openTimeoutMs ?? 1600)
    : (options.retryTimeoutMs ?? 3000);
  const signal = boundedSignal(options.signal, timeoutMs);
  const runOptions = {};
  if (signal) runOptions.signal = signal;
  if (options.sessionAffinity) runOptions.extraHeaders = { 'x-session-affinity': options.sessionAffinity };
  return withTimeout(
    ai.run(
      GROK_CONVERSATION_MODEL_V29,
      requestFor(messages, options, stream),
      Object.keys(runOptions).length ? runOptions : undefined,
    ),
    timeoutMs + 180,
    `TalkSys Grok ${stream ? 'stream' : 'retry'}`,
  );
}

function looksComplete(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (/[。！？!?」』）)】]$/.test(value)) return true;
  return /(です|ます|でした|ません|ください|ですね|ですよ|でしょう|と思います|できます|あります|ありません)$/.test(value);
}

async function* iterateStream(result, options = {}) {
  const firstTokenTimeoutMs = Math.max(500, Number(options.firstTokenTimeoutMs) || 1900);
  const idleTimeoutMs = Math.max(700, Number(options.streamIdleTimeoutMs) || 2600);
  const totalTimeoutMs = Math.max(2800, Number(options.streamTotalTimeoutMs) || 10000);
  const deadline = Date.now() + totalTimeoutMs;
  let sawText = false;

  const nextWithDeadline = (reader) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Grok stream total timeout');
    return withTimeout(
      reader.read(),
      Math.min(sawText ? idleTimeoutMs : firstTokenTimeoutMs, remaining),
      sawText ? 'Grok stream idle' : 'Grok first visible token',
    );
  };

  if (result && (result instanceof ReadableStream || typeof result.getReader === 'function')) {
    const reader = result.getReader();
    const decoder = new TextDecoder();
    let pending = '';
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
        const next = await nextWithDeadline(reader);
        if (next.done) break;
        pending += decoder.decode(next.value, { stream: true });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || '';
        for (const line of lines) yield* consume(line);
      }
      pending += decoder.decode();
      if (pending.trim()) yield* consume(pending);
    } finally {
      try { await reader.cancel(); } catch {}
      try { reader.releaseLock(); } catch {}
    }
    return;
  }

  if (result && typeof result[Symbol.asyncIterator] === 'function') {
    const iterator = result[Symbol.asyncIterator]();
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Grok async stream total timeout');
      const next = await withTimeout(
        iterator.next(),
        Math.min(sawText ? idleTimeoutMs : firstTokenTimeoutMs, remaining),
        sawText ? 'Grok async stream idle' : 'Grok async first visible token',
      );
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

export async function* streamGrokConversationV29(ai, messages, options = {}) {
  options.onModelAttempt?.(GROK_CONVERSATION_MODEL_V29);
  let yielded = false;
  let partial = '';
  let firstError = null;

  try {
    const stream = await open(ai, messages, options, true);
    for await (const delta of iterateStream(stream, options)) {
      const value = String(delta || '');
      if (!value) continue;
      yielded = true;
      partial += value;
      if (partial.length === value.length) options.onModelSelected?.(GROK_CONVERSATION_MODEL_V29);
      yield value;
    }
    if (yielded) {
      if (!looksComplete(partial)) yield '。';
      return;
    }
  } catch (error) {
    firstError = error;
    if (yielded) {
      if (!looksComplete(partial)) yield '。';
      return;
    }
  }

  options.onModelRetry?.(GROK_CONVERSATION_MODEL_V29);
  try {
    const retry = await open(ai, messages, options, false);
    const text = readFinal(retry);
    if (!text) throw new Error('Grok retry returned no visible text');
    options.onModelSelected?.(GROK_CONVERSATION_MODEL_V29);
    yield text;
    return;
  } catch (retryError) {
    throw retryError || firstError || new Error('Grok produced no visible text');
  }
}

export const __test = { readDelta, readFinal, looksComplete };

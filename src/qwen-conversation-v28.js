export const TALKSYS_CONVERSATION_MODEL_V28 = '@cf/qwen/qwen3.8-27b';

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

function requestFor(messages, options, stream) {
  return {
    messages,
    stream,
    max_completion_tokens: options.maxTokens ?? 240,
    temperature: options.temperature ?? 0.14,
    reasoning_effort: null,
    chat_template_kwargs: {
      enable_thinking: false,
      clear_thinking: true,
    },
  };
}

async function open(ai, messages, options, stream) {
  const timeoutMs = stream
    ? (options.openTimeoutMs ?? 1600)
    : (options.retryTimeoutMs ?? 2800);
  const signal = boundedSignal(options.signal, timeoutMs);
  const runOptions = {};
  if (signal) runOptions.signal = signal;
  if (options.sessionAffinity) runOptions.extraHeaders = { 'x-session-affinity': options.sessionAffinity };
  return withTimeout(
    ai.run(
      TALKSYS_CONVERSATION_MODEL_V28,
      requestFor(messages, options, stream),
      Object.keys(runOptions).length ? runOptions : undefined,
    ),
    timeoutMs + 160,
    `TalkSys Qwen ${stream ? 'stream' : 'retry'}`,
  );
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
  if (typeof result.result === 'string') return result.result.trim();
  if (typeof result.text === 'string') return result.text.trim();
  const root = result.result && typeof result.result === 'object' ? result.result : result;
  const choice = root?.choices?.[0] || result?.choices?.[0];
  const message = textFromContent(choice?.message?.content).trim();
  if (message) return message;
  return typeof choice?.text === 'string' ? choice.text.trim() : '';
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
  const totalTimeoutMs = Math.max(2600, Number(options.streamTotalTimeoutMs) || 10000);
  const deadline = Date.now() + totalTimeoutMs;
  let sawText = false;

  const readNext = (reader) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Qwen stream total timeout');
    return withTimeout(
      reader.read(),
      Math.min(sawText ? idleTimeoutMs : firstTokenTimeoutMs, remaining),
      sawText ? 'Qwen stream idle' : 'Qwen first token',
    );
  };

  const byteStream = result && (typeof result.getReader === 'function' || (typeof ReadableStream !== 'undefined' && result instanceof ReadableStream));
  if (byteStream) {
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
        const next = await readNext(reader);
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
      if (remaining <= 0) throw new Error('Qwen async stream total timeout');
      const next = await withTimeout(
        iterator.next(),
        Math.min(sawText ? idleTimeoutMs : firstTokenTimeoutMs, remaining),
        sawText ? 'Qwen async stream idle' : 'Qwen async first token',
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

  const final = readFinal(result);
  if (final) yield final;
}

function continuationMessages(messages, partial) {
  return [
    ...(Array.isArray(messages) ? messages : []),
    { role: 'assistant', content: String(partial || '').trim() },
    { role: 'user', content: '直前の回答が途中で切れました。同じ内容を繰り返さず、自然な続きだけを短く完成させてください。' },
  ];
}

export async function* streamQwenConversationV28(ai, messages, options = {}) {
  let partial = '';
  let streamError = null;

  try {
    const stream = await open(ai, messages, options, true);
    for await (const delta of iterateStream(stream, options)) {
      const value = String(delta || '');
      if (!value) continue;
      partial += value;
      yield value;
    }
    if (partial && looksComplete(partial)) return;
  } catch (error) {
    streamError = error;
  }

  try {
    const retryMessages = partial ? continuationMessages(messages, partial) : messages;
    const retry = await open(ai, retryMessages, {
      ...options,
      maxTokens: partial ? Math.min(160, Number(options.maxTokens) || 160) : options.maxTokens,
    }, false);
    const text = readFinal(retry);
    if (text) {
      yield text;
      return;
    }
  } catch (error) {
    streamError = error;
  }

  if (partial) {
    if (!looksComplete(partial)) yield '。';
    return;
  }
  throw streamError || new Error('Qwen produced no visible text');
}

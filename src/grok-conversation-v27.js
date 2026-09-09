export const GROK_CONVERSATION_MODEL_V27 = 'xai/grok-4.20-0309-non-reasoning';
export const GROK_FALLBACK_MODEL_V27 = '@cf/zai-org/glm-5.3-flash';
export const GROK_EMERGENCY_MODEL_V27 = '@cf/qwen/qwen3.8-27b';

let grokBlockedUntil = 0;

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
  const deltaContent = textFromContent(choice?.delta?.content);
  if (deltaContent) return deltaContent;
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
  const root = result.result && typeof result.result === 'object' ? result.result : result;
  const choice = root?.choices?.[0] || result?.choices?.[0];
  const messageContent = textFromContent(choice?.message?.content).trim();
  if (messageContent) return messageContent;
  if (typeof choice?.text === 'string') return choice.text.trim();
  return '';
}

function requestFor(model, messages, options, stream) {
  const request = {
    messages,
    stream,
    max_completion_tokens: options.maxTokens ?? 240,
    temperature: options.temperature ?? 0.12,
  };
  if (stream && model === GROK_CONVERSATION_MODEL_V27) {
    request.stream_options = { include_usage: true };
  }
  if (model === GROK_EMERGENCY_MODEL_V27) {
    request.reasoning_effort = null;
    request.chat_template_kwargs = { enable_thinking: false, clear_thinking: true };
  }
  if (model === GROK_FALLBACK_MODEL_V27) {
    request.modalities = ['text'];
    request.reasoning_effort = options.reasoningEffort ?? 'low';
  }
  return request;
}

function isUnifiedBillingFailure(error) {
  const text = String(error?.message || error || '');
  return /(?:^|\D)2021(?:\D|$)|Insufficient AI Gateway credits|Unified Billing/i.test(text);
}

async function open(ai, model, messages, options, stream) {
  const primary = model === GROK_CONVERSATION_MODEL_V27;
  const timeoutMs = stream
    ? (options.openTimeoutMs ?? (primary ? 1600 : 1800))
    : (options.fallbackTimeoutMs ?? (primary ? 2600 : 3000));
  const signal = boundedSignal(options.signal, timeoutMs);
  const runOptions = {};
  if (signal) runOptions.signal = signal;
  if (options.sessionAffinity) runOptions.extraHeaders = { 'x-session-affinity': options.sessionAffinity };
  return withTimeout(
    ai.run(
      model,
      requestFor(model, messages, options, stream),
      Object.keys(runOptions).length ? runOptions : undefined,
    ),
    timeoutMs + 180,
    `${model} ${stream ? 'stream open' : 'fallback'}`,
  );
}

function looksComplete(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (/[。！？!?」』）)】]$/.test(value)) return true;
  return /(です|ます|でした|ません|ください|ですね|ですよ|でしょう|と思います|できます|あります|ありません)$/.test(value);
}

async function* iterateStream(result, options = {}) {
  const firstTokenTimeoutMs = Math.max(500, Number(options.firstTokenTimeoutMs) || 1800);
  const idleTimeoutMs = Math.max(700, Number(options.streamIdleTimeoutMs) || 2400);
  const totalTimeoutMs = Math.max(2800, Number(options.streamTotalTimeoutMs) || 10000);
  const startedAt = Date.now();
  const totalDeadline = startedAt + totalTimeoutMs;
  let sawText = false;

  const nextWithDeadline = (reader) => {
    const remaining = totalDeadline - Date.now();
    if (remaining <= 0) throw new Error('conversation stream total timeout');
    return withTimeout(
      reader.read(),
      Math.min(sawText ? idleTimeoutMs : firstTokenTimeoutMs, remaining),
      sawText ? 'conversation stream idle' : 'conversation first visible token',
    );
  };

  const byteStream = result && (result instanceof ReadableStream || typeof result.getReader === 'function');
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
      const remaining = totalDeadline - Date.now();
      if (remaining <= 0) throw new Error('conversation async stream total timeout');
      const next = await withTimeout(
        iterator.next(),
        Math.min(sawText ? idleTimeoutMs : firstTokenTimeoutMs, remaining),
        sawText ? 'conversation async stream idle' : 'conversation async first visible token',
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

export async function* streamGrokConversationV27(ai, messages, options = {}) {
  const models = [
    GROK_CONVERSATION_MODEL_V27,
    GROK_FALLBACK_MODEL_V27,
    GROK_EMERGENCY_MODEL_V27,
  ];
  let lastError = null;

  for (const model of models) {
    if (model === GROK_CONVERSATION_MODEL_V27 && Date.now() < grokBlockedUntil) continue;
    options.onModelAttempt?.(model);
    let yielded = false;
    let partial = '';
    try {
      const stream = await open(ai, model, messages, options, true);
      for await (const delta of iterateStream(stream, options)) {
        const value = String(delta || '');
        if (!value) continue;
        yielded = true;
        partial += value;
        if (partial.length === value.length) options.onModelSelected?.(model);
        yield value;
      }
      if (yielded) {
        if (!looksComplete(partial)) yield '。';
        return;
      }

      const fallback = await open(ai, model, messages, options, false);
      const text = readFinal(fallback);
      if (text) {
        options.onModelSelected?.(model);
        yield text;
        return;
      }
      lastError = new Error(`${model} returned no visible text`);
    } catch (error) {
      lastError = error;
      if (model === GROK_CONVERSATION_MODEL_V27 && isUnifiedBillingFailure(error)) {
        // Avoid adding the same failed third-party billing round trip to every utterance.
        // A new isolate or five-minute expiry automatically probes Grok again.
        grokBlockedUntil = Date.now() + 5 * 60 * 1000;
      }
      if (yielded) {
        if (!looksComplete(partial)) yield '。';
        return;
      }
    }
  }

  throw lastError || new Error('No TalkSys v27 conversation model produced text');
}

export const LIVE_VOICE_MODEL = '@cf/qwen/qwen3.8-27b';

function readDelta(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const choice = payload.choices?.[0];
  const candidates = [
    choice?.delta?.content,
    choice?.message?.content,
    payload.response,
    payload.delta,
    payload.output_text,
    payload.text,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate;
    if (Array.isArray(candidate)) {
      const text = candidate.map((part) => typeof part === 'string' ? part : (part?.text || part?.content || '')).join('');
      if (text) return text;
    }
  }
  return '';
}

function incrementalDelta(next, full) {
  if (!next) return '';
  if (full && next.startsWith(full)) return next.slice(full.length);
  if (full && full.endsWith(next)) return '';
  return next;
}

function splitSpeechChunks(buffer, force = false) {
  const chunks = [];
  let rest = String(buffer || '');
  while (rest) {
    const sentence = rest.match(/^([\s\S]*?[。！？!?]+)/u);
    if (sentence && sentence[1].trim().length >= 3) {
      chunks.push(sentence[1].trim());
      rest = rest.slice(sentence[0].length).replace(/^\s+/, '');
      continue;
    }
    if (rest.length >= 46) {
      const commaAt = Math.max(rest.lastIndexOf('、', 46), rest.lastIndexOf('，', 46), rest.lastIndexOf(',', 46));
      if (commaAt >= 16) {
        chunks.push(rest.slice(0, commaAt + 1).trim());
        rest = rest.slice(commaAt + 1).replace(/^\s+/, '');
        continue;
      }
    }
    break;
  }
  if (force && rest.trim()) {
    chunks.push(rest.trim());
    rest = '';
  }
  return { chunks, rest };
}

function liveModelInput(input) {
  return {
    ...input,
    max_completion_tokens: Number(input?.max_completion_tokens || input?.max_tokens || 260),
    max_tokens: undefined,
    reasoning_effort: null,
    chat_template_kwargs: {
      ...(input?.chat_template_kwargs || {}),
      enable_thinking: false,
      clear_thinking: true,
    },
    stream: true,
  };
}

export async function streamWorkersAIText(ai, _model, input, options = {}) {
  const signal = options.signal;
  const stream = await ai.run(LIVE_VOICE_MODEL, liveModelInput(input), signal ? { signal } : undefined);
  if (!(stream instanceof ReadableStream)) throw new Error('Workers AI did not return a readable stream');

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let full = '';
  let speechBuffer = '';
  let sequence = 0;

  const consumePayload = (payload) => {
    const extracted = readDelta(payload);
    const delta = incrementalDelta(extracted, full);
    if (!delta) return;
    full += delta;
    speechBuffer += delta;
    options.onDelta?.(delta, full);
    const split = splitSpeechChunks(speechBuffer, false);
    speechBuffer = split.rest;
    for (const chunk of split.chunks) options.onSpeechChunk?.(chunk, sequence++);
  };

  try {
    while (true) {
      if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
      const lines = raw.split(/\r?\n/);
      raw = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try { consumePayload(JSON.parse(data)); } catch {}
      }
    }
    raw += decoder.decode();
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try { consumePayload(JSON.parse(data)); } catch {}
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  const split = splitSpeechChunks(speechBuffer, true);
  for (const chunk of split.chunks) options.onSpeechChunk?.(chunk, sequence++);
  return full.trim();
}

export { readDelta, splitSpeechChunks, liveModelInput };

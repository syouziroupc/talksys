export const LIVE_VOICE_MODEL = '@cf/qwen/qwen3.8-27b';
export const GROUNDING_VOICE_MODEL = '@cf/openai/gpt-oss-120b';

const GROUNDED_MARKER_RE = /\[(?:ウェブ検索結果|Web検索で取得した根拠)\]/i;
const GROUNDED_ANSWER_POLICY = `\n追加ルール:\n- 検索結果はシステムが取得した根拠であり、ユーザーが提示した資料ではない。「いただいた検索結果」「ご提示いただいた情報」「具体的な情報源を提示して」のように、検索責任をユーザーへ返す表現は禁止。\n- 質問にまず直接答える。検索結果に時刻表、経路、公式案内、製品仕様など質問と同義の事実があれば、質問文との完全一致を要求しない。根拠から一段階で導ける結論は答えてよい。\n- 検索結果の一部だけが不足していても、確認できた範囲は具体的に答える。証拠が本当に足りない部分だけを不明とする。\n- 検索結果が今回の質問と明らかに無関係、または検索語が会話文脈を落としている場合、その検索失敗を理由に回答全体を拒否しない。直前の会話にある目的、予算、対象商品、用途などを使い、一般的な助言・選び方・比較軸はそのまま答える。\n- 検索で裏取りできていない最新価格、在庫、営業時間、販売中かどうか、特定店舗が現在最安かどうかは断定しない。必要なら「最新の在庫までは確認できていない」と限定して述べる。\n- 購入先を聞かれた場合、検索結果に有効な販売店情報がなくても、会話文脈から適切な購入チャネルを答えてよい。例: 新品通販、家電量販店、中古PC専門店、メーカー直販。具体的な店名を挙げる場合だけ、検索根拠がある店を優先する。\n- 証拠が不足する場合でも「今の検索では裏を取れなかった」と一言添える程度にし、その後に役立つ回答を続ける。回答不能だけで終わらない。`;

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

function isGroundedInput(input) {
  return Array.isArray(input?.messages) && input.messages.some((message) => GROUNDED_MARKER_RE.test(String(message?.content || '')));
}

function withGroundedAnswerPolicy(input) {
  if (!isGroundedInput(input) || !Array.isArray(input?.messages)) return input;
  let amended = false;
  const messages = input.messages.map((message) => {
    if (!amended && message?.role === 'system') {
      amended = true;
      return { ...message, content: `${String(message.content || '')}${GROUNDED_ANSWER_POLICY}` };
    }
    return message;
  });
  if (!amended) messages.unshift({ role: 'system', content: GROUNDED_ANSWER_POLICY.trim() });
  return { ...input, messages };
}

function modelStreamInput(model, input) {
  const prepared = withGroundedAnswerPolicy(input);
  if (model === LIVE_VOICE_MODEL) return liveModelInput(prepared);
  return {
    ...prepared,
    stream: true,
  };
}

async function openStream(ai, requestedModel, input, signal) {
  const grounded = isGroundedInput(input);
  const preferred = grounded ? GROUNDING_VOICE_MODEL : (requestedModel || LIVE_VOICE_MODEL);
  const candidates = [...new Set([preferred, requestedModel, LIVE_VOICE_MODEL].filter(Boolean))];
  let lastError;
  for (const model of candidates) {
    try {
      const stream = await ai.run(model, modelStreamInput(model, input), signal ? { signal } : undefined);
      if (!(stream instanceof ReadableStream)) throw new Error('Workers AI did not return a readable stream');
      return { model, stream };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('No Workers AI streaming model was available');
}

export async function streamWorkersAIText(ai, requestedModel, input, options = {}) {
  const signal = options.signal;
  const opened = await openStream(ai, requestedModel, input, signal);
  const stream = opened.stream;
  options.onModel?.(opened.model);

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

export { readDelta, splitSpeechChunks, liveModelInput, modelStreamInput, isGroundedInput, withGroundedAnswerPolicy };

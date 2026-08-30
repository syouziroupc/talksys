import { extractText } from './voice-helpers.js';
import { webSearch, formatSearchContext } from './web-search.js';
import { rerankSearchResults } from './search-rerank.js';

export const PRIMARY_CONVERSATION_MODEL = 'openai/gpt-5.4-mini';
export const FALLBACK_CONVERSATION_MODEL = '@cf/nvidia/nemotron-3-120b-a12b';

function readDelta(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const candidates = [
    payload?.choices?.[0]?.delta?.content,
    payload?.choices?.[0]?.message?.content,
    payload?.delta,
    payload?.response,
    payload?.output_text,
    payload?.text,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value) return value;
    if (Array.isArray(value)) {
      const joined = value.map((part) => typeof part === 'string' ? part : (part?.text || part?.content || '')).join('');
      if (joined) return joined;
    }
  }
  return '';
}

function extractResponsesText(value, depth = 0) {
  if (depth > 8 || value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    const direct = value.map((item) => extractResponsesText(item, depth + 1)).filter(Boolean).join('');
    return direct.trim();
  }
  if (typeof value !== 'object') return '';
  const candidates = [
    value.output_text,
    value.text,
    value.content,
    value.message?.content,
    value.result?.output_text,
    value.result?.text,
    value.result?.output,
    value.output,
    value.response,
    value.choices?.[0]?.message?.content,
  ];
  for (const candidate of candidates) {
    if (candidate === value) continue;
    const text = extractResponsesText(candidate, depth + 1);
    if (text) return text;
  }
  return '';
}

async function* parseSse(stream, signal) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let payload;
        try { payload = JSON.parse(data); } catch { continue; }
        const next = readDelta(payload);
        if (!next) continue;
        const delta = full && next.startsWith(full) ? next.slice(full.length) : next;
        if (!delta || (full && full.endsWith(delta))) continue;
        full += delta;
        yield delta;
      }
    }
    buffer += decoder.decode();
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function primaryChatInput(messages, maxTokens = 360) {
  return {
    messages,
    max_completion_tokens: maxTokens,
    reasoning_effort: 'low',
    stream: true,
  };
}

function fallbackChatInput(messages, maxTokens = 360) {
  return {
    messages,
    max_completion_tokens: maxTokens,
    temperature: 0.28,
    top_p: 0.9,
    stream: true,
  };
}

export async function* streamCloudflareConversation(ai, messages, options = {}) {
  const signal = options.signal;
  const maxTokens = options.maxTokens || 360;
  let stream;
  let provider = 'unified';
  try {
    stream = await ai.run(
      PRIMARY_CONVERSATION_MODEL,
      primaryChatInput(messages, maxTokens),
      { gateway: { id: 'default' }, ...(signal ? { signal } : {}) },
    );
    if (!(stream instanceof ReadableStream)) {
      const text = extractResponsesText(stream) || extractText(stream);
      if (text) yield text;
      return;
    }
  } catch {
    provider = 'workers-ai';
  }

  if (provider === 'workers-ai') {
    stream = await ai.run(
      FALLBACK_CONVERSATION_MODEL,
      fallbackChatInput(messages, maxTokens),
      signal ? { signal } : undefined,
    );
  }

  if (!(stream instanceof ReadableStream)) {
    const text = extractResponsesText(stream) || extractText(stream);
    if (text) yield text;
    return;
  }
  yield* parseSse(stream, signal);
}

function recentConversation(messages) {
  if (!Array.isArray(messages)) return '';
  return messages.slice(-10)
    .map((item) => `${item.role === 'assistant' ? 'AI' : 'ユーザー'}: ${String(item.content || '').replace(/\s+/g, ' ').slice(0, 500)}`)
    .join('\n')
    .slice(0, 5000);
}

function groundedInput(question, history, systemPrompt) {
  return [
    systemPrompt,
    '',
    '[直近の会話]',
    recentConversation(history) || '(なし)',
    '',
    '[今回の質問]',
    question,
  ].join('\n');
}

export async function answerWithCloudflareWebSearch(ai, question, history, systemPrompt, options = {}) {
  const signal = options.signal;
  const input = groundedInput(question, history, systemPrompt);
  try {
    const result = await ai.run(
      PRIMARY_CONVERSATION_MODEL,
      {
        input,
        instructions: '外部事実は必ずWeb検索結果に基づいて回答する。検索で確認できない事実は推測しない。日本語で自然に答える。',
        max_output_tokens: 520,
        reasoning: { effort: 'low' },
        tools: [{
          type: 'web_search_preview',
          search_context_size: 'medium',
          user_location: { type: 'approximate', country: 'JP', timezone: 'Asia/Tokyo' },
        }],
        store: false,
      },
      { gateway: { id: 'default' }, ...(signal ? { signal } : {}) },
    );
    const text = extractResponsesText(result) || extractText(result);
    if (text) return { text, provider: 'gpt-5.4-mini-web-search', nativeSearch: true };
  } catch {
    // Unified Billing may not be funded. Use a keyless Workers AI fallback below.
  }

  const raw = await webSearch(question, { limit: 8, timeoutMs: 2800 });
  const ranked = await rerankSearchResults(ai, question, raw, 5);
  const searchContext = formatSearchContext(ranked);
  if (!searchContext) return {
    text: '確認できる検索結果を取得できませんでした。推測では答えません。',
    provider: 'workers-ai-search-fallback',
    nativeSearch: false,
    sources: [],
  };

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-8).map((item) => ({ role: item.role, content: item.content })),
    {
      role: 'user',
      content: `${question}\n\n[検索結果]\n${searchContext}\n\n検索結果に書かれていない外部事実は補わず、日本語で2〜4文で答えてください。`,
    },
  ];
  let text = '';
  for await (const delta of streamCloudflareConversation(ai, messages, { signal, maxTokens: 480 })) text += delta;
  return {
    text: text.trim() || '検索結果から確実な回答を作れませんでした。',
    provider: 'workers-ai-search-fallback',
    nativeSearch: false,
    sources: ranked.slice(0, 4),
  };
}

export { extractResponsesText, readDelta };

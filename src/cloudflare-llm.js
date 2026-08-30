import { extractText } from './voice-helpers.js';
import { webSearch, formatSearchContext } from './web-search.js';
import { rerankSearchResults } from './search-rerank.js';

export const PRIMARY_CONVERSATION_MODEL = '@cf/openai/gpt-oss-120b';
export const FALLBACK_CONVERSATION_MODEL = '@cf/qwen/qwen3.8-27b';

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

function readFinal(value, depth = 0) {
  if (depth > 8 || value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map((item) => readFinal(item, depth + 1)).filter(Boolean).join('').trim();
  if (typeof value !== 'object') return '';
  const candidates = [
    value.response,
    value.choices?.[0]?.message?.content,
    value.output_text,
    value.text,
    value.content,
    value.result,
    value.output,
  ];
  for (const candidate of candidates) {
    if (candidate === value) continue;
    const text = readFinal(candidate, depth + 1);
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
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function modelInput(model, messages, maxTokens) {
  if (model === FALLBACK_CONVERSATION_MODEL) {
    return {
      messages,
      max_tokens: maxTokens,
      temperature: 0.25,
      top_p: 0.9,
      stream: true,
      chat_template_kwargs: { enable_thinking: false, clear_thinking: true },
    };
  }
  return {
    messages,
    max_tokens: maxTokens,
    temperature: 0.28,
    top_p: 0.9,
    stream: true,
  };
}

async function openModelStream(ai, model, messages, maxTokens, signal) {
  return ai.run(model, modelInput(model, messages, maxTokens), signal ? { signal } : undefined);
}

export async function* streamCloudflareConversation(ai, messages, options = {}) {
  const signal = options.signal;
  const maxTokens = options.maxTokens || 420;
  let result;
  try {
    result = await openModelStream(ai, PRIMARY_CONVERSATION_MODEL, messages, maxTokens, signal);
  } catch {
    result = await openModelStream(ai, FALLBACK_CONVERSATION_MODEL, messages, maxTokens, signal);
  }
  if (!(result instanceof ReadableStream)) {
    const text = readFinal(result) || extractText(result);
    if (text) yield text;
    return;
  }
  yield* parseSse(result, signal);
}

export async function answerWithCloudflareWebSearch(ai, question, history, systemPrompt, options = {}) {
  const signal = options.signal;
  const raw = await webSearch(question, { limit: 12, timeoutMs: 3600, enrichPages: true });
  const ranked = await rerankSearchResults(ai, question, raw, 6);
  const searchContext = formatSearchContext(ranked);
  if (!searchContext) {
    return {
      text: '確認できる検索結果を取得できませんでした。推測では答えません。',
      provider: 'cloudflare-workers-ai-grounded-search',
      nativeSearch: false,
      sources: [],
    };
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-10).map((item) => ({ role: item.role, content: item.content })),
    {
      role: 'user',
      content: `${question}\n\n[Web検索で取得した根拠]\n${searchContext}\n\n必ず上の根拠だけで答えてください。根拠同士が食い違う場合は、その点を明示してください。検索結果にない固有名詞・数値・日付・価格・法令・仕様をモデル知識から補わないでください。日本語で2〜5文。`,
    },
  ];
  let text = '';
  for await (const delta of streamCloudflareConversation(ai, messages, { signal, maxTokens: 560 })) text += delta;
  return {
    text: text.trim() || '検索結果から確実な回答を作れませんでした。',
    provider: 'cloudflare-workers-ai-grounded-search',
    nativeSearch: false,
    sources: ranked.slice(0, 5),
  };
}

export { readFinal, readDelta };

import { extractText } from './voice-helpers.js';
import { formatSearchContext } from './web-search.js';
import { runDeepSearch } from './search-orchestrator.js';

export const LIVE_CONVERSATION_MODEL = '@cf/qwen/qwen3.8-27b';
export const QUALITY_CONVERSATION_MODEL = '@cf/zai-org/glm-5.3-flash';
export const GROUNDING_CONVERSATION_MODEL = '@cf/deepseek-ai/deepseek-v4-pro-0813';
export const GROUNDING_FALLBACK_MODEL = '@cf/openai/gpt-oss-120b';

// Compatibility aliases used by health checks and older code paths.
export const PRIMARY_CONVERSATION_MODEL = GROUNDING_CONVERSATION_MODEL;
export const FALLBACK_CONVERSATION_MODEL = LIVE_CONVERSATION_MODEL;

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

async function* parseSse(stream, signal, metrics) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  const consumeLine = function* (line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let payload;
    try { payload = JSON.parse(data); } catch { return; }
    const next = readDelta(payload);
    if (!next) return;
    const delta = full && next.startsWith(full) ? next.slice(full.length) : next;
    if (!delta || (full && full.endsWith(delta))) return;
    full += delta;
    if (metrics && metrics.firstTokenAt == null) metrics.firstTokenAt = Date.now();
    yield delta;
  };

  try {
    while (true) {
      if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) yield* consumeLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield* consumeLine(buffer);
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function modelInput(model, messages, maxTokens, temperature = 0.3) {
  const common = {
    messages,
    temperature,
    top_p: 0.9,
    stream: true,
  };

  if (model === LIVE_CONVERSATION_MODEL) {
    return {
      ...common,
      max_completion_tokens: maxTokens,
      reasoning_effort: null,
      chat_template_kwargs: {
        enable_thinking: false,
        clear_thinking: true,
      },
    };
  }

  if (model === QUALITY_CONVERSATION_MODEL) {
    return {
      ...common,
      max_completion_tokens: maxTokens,
      reasoning_effort: null,
    };
  }

  return {
    ...common,
    max_completion_tokens: maxTokens,
  };
}

function runOptions(signal, sessionAffinity) {
  const options = {};
  if (signal) options.signal = signal;
  if (sessionAffinity) {
    options.extraHeaders = {
      'x-session-affinity': String(sessionAffinity).slice(0, 128),
    };
  }
  return Object.keys(options).length ? options : undefined;
}

async function openModelStream(ai, model, messages, maxTokens, options = {}) {
  return ai.run(
    model,
    modelInput(model, messages, maxTokens, options.temperature),
    runOptions(options.signal, options.sessionAffinity),
  );
}

async function* streamModelCascade(ai, models, messages, options = {}) {
  const maxTokens = options.maxTokens || 420;
  let result;
  let chosenModel = '';
  let lastError;

  for (const model of models) {
    try {
      result = await openModelStream(ai, model, messages, maxTokens, options);
      chosenModel = model;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!chosenModel) throw lastError || new Error('No Cloudflare conversation model was available');

  options.onModel?.(chosenModel);

  if (!(result instanceof ReadableStream)) {
    const text = readFinal(result) || extractText(result);
    if (text) yield text;
    return;
  }

  yield* parseSse(result, options.signal);
}

export function streamCloudflareLiveConversation(ai, messages, options = {}) {
  return streamModelCascade(ai, [LIVE_CONVERSATION_MODEL], messages, {
    ...options,
    maxTokens: options.maxTokens || 320,
    temperature: options.temperature ?? 0.38,
  });
}

export function streamCloudflareQualityConversation(ai, messages, options = {}) {
  return streamModelCascade(ai, [QUALITY_CONVERSATION_MODEL, LIVE_CONVERSATION_MODEL], messages, {
    ...options,
    maxTokens: options.maxTokens || 440,
    temperature: options.temperature ?? 0.34,
  });
}

export function streamCloudflareGroundedConversation(ai, messages, options = {}) {
  return streamModelCascade(
    ai,
    [GROUNDING_CONVERSATION_MODEL, GROUNDING_FALLBACK_MODEL, QUALITY_CONVERSATION_MODEL, LIVE_CONVERSATION_MODEL],
    messages,
    {
      ...options,
      maxTokens: options.maxTokens || 680,
      temperature: options.temperature ?? 0.12,
    },
  );
}

// Legacy default remains the highest-accuracy path. Voice turns select an explicit tier.
export function streamCloudflareConversation(ai, messages, options = {}) {
  const tier = options.tier || 'grounded';
  if (tier === 'live') return streamCloudflareLiveConversation(ai, messages, options);
  if (tier === 'quality') return streamCloudflareQualityConversation(ai, messages, options);
  return streamCloudflareGroundedConversation(ai, messages, options);
}

async function benchmarkOne(ai, model, prompt, sessionAffinity) {
  const startedAt = Date.now();
  const metrics = { firstTokenAt: null };
  try {
    const result = await openModelStream(
      ai,
      model,
      [
        {
          role: 'system',
          content: '日本語の自然な電話会話として、結論を最初に言い、その後に短い理由を添えてください。Markdownは使わない。',
        },
        { role: 'user', content: prompt },
      ],
      180,
      { temperature: 0.25, sessionAffinity },
    );

    let text = '';
    if (result instanceof ReadableStream) {
      for await (const delta of parseSse(result, undefined, metrics)) text += delta;
    } else {
      metrics.firstTokenAt = Date.now();
      text = readFinal(result) || extractText(result);
    }
    const endedAt = Date.now();
    return {
      model,
      ok: Boolean(text.trim()),
      ttftMs: metrics.firstTokenAt == null ? null : metrics.firstTokenAt - startedAt,
      totalMs: endedAt - startedAt,
      sample: text.trim().slice(0, 220),
    };
  } catch (error) {
    return {
      model,
      ok: false,
      ttftMs: null,
      totalMs: Date.now() - startedAt,
      error: String(error?.message || error).slice(0, 300),
    };
  }
}

export async function benchmarkVoiceModels(ai, options = {}) {
  const prompt = String(options.prompt || '友人から「仕事を続けるか転職するか迷っている」と相談された。電話で自然に返事をして。').slice(0, 500);
  const sessionAffinity = options.sessionAffinity || `talksys-bench-${crypto.randomUUID()}`;
  const models = [LIVE_CONVERSATION_MODEL, QUALITY_CONVERSATION_MODEL];
  const results = [];
  for (const model of models) results.push(await benchmarkOne(ai, model, prompt, sessionAffinity));
  return {
    prompt,
    results,
    recommendedByLatency: results.filter((item) => item.ok && item.ttftMs != null).sort((a, b) => a.ttftMs - b.ttftMs)[0]?.model || null,
  };
}

export async function answerWithCloudflareWebSearch(ai, question, history, systemPrompt, options = {}) {
  const signal = options.signal;
  const deepSearch = await runDeepSearch(ai, question, history, signal, { timeoutMs: 4000 });
  const ranked = deepSearch.results || [];
  const resolvedQuestion = deepSearch.plan?.resolvedQuestion || question;
  const searchContext = formatSearchContext(ranked);
  const evidence = searchContext || '今の検索では、今回の質問を直接裏付ける現在情報を取得できなかった。現在価格・在庫・時刻・法令・固有の最新事実は断定しないこと。';

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-16).map((item) => ({ role: item.role, content: item.content })),
    {
      role: 'user',
      content: `${question}\n\n[システムが会話文脈から解決した検索課題]\n${resolvedQuestion}\n\n[Web検索で取得した根拠]\n${evidence}\n\n回答ルール:\n- 現在の価格、在庫、日時、時刻表、法律、人物、製品の現行仕様など変化し得る事実は上の検索根拠から確認できた範囲だけ答える。\n- 一方で、質問が購入先、おすすめ、比較、選び方、一般的な判断を求めている場合は、会話中の予算・用途・地域などと安定した一般知識・論理的比較を使って役立つ結論まで答えてよい。\n- 検索が不十分でも回答全体を拒否しない。未確認なのは未確認の部分だけに限定する。\n- 検索結果はシステムが取得したものなので、「いただいた検索結果」「ご提示いただいた情報」「別の情報源を提示して」とユーザーに責任を返さない。\n- 電話で自然に聞ける日本語で、まず結論、その後に重要な根拠を1〜3点だけ補足する。URLは読み上げない。`,
    },
  ];
  let text = '';
  let model = '';
  for await (const delta of streamCloudflareGroundedConversation(ai, messages, {
    signal,
    maxTokens: 720,
    sessionAffinity: options.sessionAffinity,
    onModel: (value) => { model = value; },
  })) text += delta;
  return {
    text: text.trim() || '今の検索では現在情報の裏付けが十分ではありませんでした。ただ、確認できる範囲の選び方や比較なら続けられます。',
    provider: 'cloudflare-workers-ai-contextual-deep-search',
    nativeSearch: false,
    model,
    resolvedQuestion,
    queries: deepSearch.plan?.queries || [question],
    planned: Boolean(deepSearch.plan?.planned),
    sources: ranked.slice(0, 6),
  };
}

export { readFinal, readDelta, modelInput };

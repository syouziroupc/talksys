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

function modelInput(model, messages, maxTokens, temperature = 0.3, stream = true) {
  const common = {
    messages,
    temperature,
    top_p: 0.9,
    stream,
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
    modelInput(model, messages, maxTokens, options.temperature, true),
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

async function runNonStreamingCascade(ai, models, messages, options = {}) {
  const maxTokens = options.maxTokens || 720;
  let lastError;
  for (const model of models) {
    try {
      const result = await ai.run(
        model,
        modelInput(model, messages, maxTokens, options.temperature ?? 0.12, false),
        runOptions(options.signal, options.sessionAffinity),
      );
      const text = readFinal(result) || extractText(result);
      if (text) return { text: text.trim(), model };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return { text: '', model: '' };
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

const EVASIVE_SEARCH_RE = /(ご提示いただいた|いただいた検索結果|情報源を提示|ページや情報があれば|改めてご提示|根拠に基づいた回答を.*できません|回答を差し上げることができません|現時点では.*答え.*できません|今の検索では.*裏付けが十分ではありません|確認できる範囲の選び方や比較なら続けられます)/i;
const SHOPPING_INTENT_RE = /(どこで買|買うなら|購入先|販売店|店舗|店で買|おすすめ.*店|家電量販店|中古.*店)/i;

export function isEvasiveGroundedAnswer(text) {
  const value = String(text || '').trim();
  if (!value) return true;
  if (EVASIVE_SEARCH_RE.test(value)) return true;
  if (value.length < 24 && /(不明|わかりません|確認できません|情報がありません)/.test(value)) return true;
  return false;
}

function sourceCandidateNames(results) {
  const names = [];
  const seen = new Set();
  for (const item of results || []) {
    let title = String(item?.title || '').replace(/\s+/g, ' ').trim();
    if (!title) continue;
    title = title.replace(/\s*[|｜].*$/, '').replace(/\s*[-–—]\s*公式.*$/i, '').slice(0, 80).trim();
    if (title.length < 3 || seen.has(title)) continue;
    if (!/(店|店舗|ショップ|パソコン|PC|家電|ヤマダ|エディオン|ケーズ|ビック|ヨドバシ|ジョーシン|中古|公式)/i.test(title)) continue;
    seen.add(title);
    names.push(title);
    if (names.length >= 4) break;
  }
  return names;
}

function deterministicRescue(question, ranked) {
  const candidates = sourceCandidateNames(ranked);
  if (SHOPPING_INTENT_RE.test(String(question || ''))) {
    if (candidates.length) {
      return `候補を絞るなら、検索で拾えた中では${candidates.join('、')}をまず比べるのがいいです。店頭在庫やその日の価格までは変わるので、そこだけ確認して、保証と総額で決めるのが安全です。`;
    }
    return '買う場所で迷っているなら、保証重視なら家電量販店、価格重視なら中古パソコン専門店、機種を決め打ちするならメーカー直販や大手通販の順で比べるのがいいです。具体的な店名まで取れない場合でも、そこで回答を止めずに条件を絞って探し直します。';
  }
  return '';
}

function buildGroundedMessages(question, history, systemPrompt, resolvedQuestion, evidence) {
  return [
    { role: 'system', content: systemPrompt },
    ...history.slice(-18).map((item) => ({ role: item.role, content: item.content })),
    {
      role: 'user',
      content: `${question}\n\n[システムが会話文脈から解決した検索課題]\n${resolvedQuestion}\n\n[Web検索で取得した根拠]\n${evidence}\n\n回答ルール:\n- まず質問そのものに具体的に答える。検索の成否の説明から始めない。\n- 現在の価格、在庫、日時、時刻表、法律、人物、製品の現行仕様など変化し得る事実は上の検索根拠から確認できた範囲だけ答える。\n- 購入先、おすすめ、比較、選び方では、検索結果のタイトルに実在候補が出ていれば候補名として使ってよい。価格・在庫は別途確認扱いにする。\n- 会話中の予算・用途・地域などと安定した一般知識・論理的比較を使って役立つ結論まで答える。\n- 検索が不十分でも回答全体を拒否しない。未確認なのは変化し得る具体的事実だけに限定する。\n- 「いただいた検索結果」「ご提示いただいた情報」「別の情報源を提示して」など、検索責任をユーザーへ返す表現は禁止。\n- 「今の検索では裏付けが十分ではない」だけで回答を終えるのは禁止。\n- 電話で自然に聞ける日本語で、短い文を使い、まず結論、その後に重要な根拠を1〜3点だけ補足する。URLは読み上げない。`,
    },
  ];
}

export async function answerWithCloudflareWebSearch(ai, question, history, systemPrompt, options = {}) {
  const signal = options.signal;
  const deepSearch = await runDeepSearch(ai, question, history, signal, { timeoutMs: 7600 });
  const ranked = deepSearch.results || [];
  const resolvedQuestion = deepSearch.plan?.resolvedQuestion || question;
  const searchContext = formatSearchContext(ranked);
  const evidence = searchContext || '今回の取得では直接のWeb根拠が取れなかった。現在価格・在庫・営業時間など変化する具体的事実は作らない。ただし質問への一般的な判断や購入チャネルの比較は必ず続けること。';
  const messages = buildGroundedMessages(question, history, systemPrompt, resolvedQuestion, evidence);
  const models = [GROUNDING_CONVERSATION_MODEL, GROUNDING_FALLBACK_MODEL, QUALITY_CONVERSATION_MODEL, LIVE_CONVERSATION_MODEL];

  let answer = await runNonStreamingCascade(ai, models, messages, {
    signal,
    maxTokens: 780,
    temperature: 0.1,
    sessionAffinity: options.sessionAffinity,
  });

  let repaired = false;
  if (isEvasiveGroundedAnswer(answer.text)) {
    const repairMessages = [
      ...messages,
      { role: 'assistant', content: answer.text || '(空の回答)' },
      {
        role: 'user',
        content: 'この回答は検索失敗の説明に逃げていて会話として役に立ちません。質問に直接答え直してください。検索結果に候補名があれば候補として挙げ、変動する価格・在庫だけ未確認としてください。候補名がなくても購入チャネルや選び方を具体化してください。「情報が足りないので答えられない」で終わることは禁止です。',
      },
    ];
    const repairedAnswer = await runNonStreamingCascade(ai, [GROUNDING_FALLBACK_MODEL, GROUNDING_CONVERSATION_MODEL, QUALITY_CONVERSATION_MODEL, LIVE_CONVERSATION_MODEL], repairMessages, {
      signal,
      maxTokens: 720,
      temperature: 0.16,
      sessionAffinity: options.sessionAffinity,
    });
    if (repairedAnswer.text && !isEvasiveGroundedAnswer(repairedAnswer.text)) {
      answer = repairedAnswer;
      repaired = true;
    }
  }

  if (isEvasiveGroundedAnswer(answer.text)) {
    const rescue = deterministicRescue(resolvedQuestion || question, ranked);
    if (rescue) {
      answer = { text: rescue, model: answer.model || GROUNDING_FALLBACK_MODEL };
      repaired = true;
    }
  }

  return {
    text: answer.text.trim() || '確認できた範囲から、まず実用的な選択肢を絞って答えます。',
    provider: 'cloudflare-workers-ai-contextual-deep-search-v17',
    nativeSearch: false,
    model: answer.model,
    resolvedQuestion,
    queries: deepSearch.plan?.queries || [question],
    planned: Boolean(deepSearch.plan?.planned),
    recovered: Boolean(deepSearch.recovered),
    evidenceUseful: Boolean(deepSearch.evidenceUseful),
    answerRepaired: repaired,
    sources: ranked.slice(0, 8),
  };
}

export { readFinal, readDelta, modelInput, runNonStreamingCascade };

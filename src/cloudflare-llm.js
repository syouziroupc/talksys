import { runDeepSearch } from './search-orchestrator.js';
import { formatSearchContext } from './web-search.js';

export const LIVE_CONVERSATION_MODEL = '@cf/qwen/qwen3.8-27b';
export const QUALITY_CONVERSATION_MODEL = '@cf/zai-org/glm-5.3-flash';
export const GROUNDING_CONVERSATION_MODEL = '@cf/deepseek-ai/deepseek-v4-pro-0813';
export const GROUNDING_FALLBACK_MODEL = '@cf/openai/gpt-oss-120b';
export const FALLBACK_CONVERSATION_MODEL = LIVE_CONVERSATION_MODEL;

function isOpenAICompatible(model) {
  return model === LIVE_CONVERSATION_MODEL
    || model === QUALITY_CONVERSATION_MODEL
    || model === GROUNDING_CONVERSATION_MODEL
    || model === GROUNDING_FALLBACK_MODEL;
}

function readFinal(result) {
  if (typeof result === 'string') return result.trim();
  if (!result) return '';
  if (typeof result.response === 'string') return result.response.trim();
  if (typeof result.result === 'string') return result.result.trim();
  if (typeof result.text === 'string') return result.text.trim();
  const choice = result.choices?.[0];
  if (typeof choice?.message?.content === 'string') return choice.message.content.trim();
  if (typeof choice?.text === 'string') return choice.text.trim();
  return '';
}

function readDelta(payload) {
  if (!payload) return '';
  if (typeof payload.response === 'string') return payload.response;
  if (typeof payload.text === 'string') return payload.text;
  const choice = payload.choices?.[0];
  const content = choice?.delta?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((item) => typeof item === 'string' ? item : (item?.text || '')).join('');
  }
  if (typeof choice?.text === 'string') return choice.text;
  return '';
}

export function modelInput(model, messages, maxTokens = 320, temperature = 0.2, stream = true) {
  const base = {
    messages,
    stream,
    max_completion_tokens: maxTokens,
    temperature,
  };
  if (model === LIVE_CONVERSATION_MODEL) {
    base.reasoning_effort = null;
    base.chat_template_kwargs = { enable_thinking: false, clear_thinking: true };
  }
  return base;
}

async function openModel(ai, model, messages, options = {}) {
  const input = modelInput(
    model,
    messages,
    options.maxTokens ?? 320,
    options.temperature ?? 0.2,
    options.stream !== false,
  );
  const runOptions = {};
  if (options.signal) runOptions.signal = options.signal;
  if (options.sessionAffinity) runOptions.extraHeaders = { 'x-session-affinity': options.sessionAffinity };
  return ai.run(model, input, Object.keys(runOptions).length ? runOptions : undefined);
}

async function readStreamChunk(reader, timeoutMs = 0) {
  if (!(timeoutMs > 0)) return reader.read();
  let timer;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Workers AI live stream first-token timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function* streamResult(result, options = {}) {
  const byteStream = result && (result instanceof ReadableStream || typeof result.getReader === 'function');
  if (byteStream) {
    const reader = result.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let sawText = false;

    const consumeLine = function* (raw) {
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
        const { value, done } = await readStreamChunk(reader, sawText ? 0 : (options.firstTokenTimeoutMs ?? 4500));
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || '';
        for (const line of lines) yield* consumeLine(line);
      }
      pending += decoder.decode();
      if (pending.trim()) yield* consumeLine(pending);
    } finally {
      try { reader.releaseLock(); } catch {}
    }
    return;
  }

  if (result && typeof result[Symbol.asyncIterator] === 'function') {
    for await (const event of result) {
      const delta = readDelta(event);
      if (delta) yield delta;
    }
    return;
  }

  const final = readFinal(result);
  if (final) yield final;
}

async function* streamCascade(ai, models, messages, options = {}) {
  let lastError = null;
  for (const model of [...new Set(models.filter(Boolean))]) {
    let yielded = false;
    try {
      const result = await openModel(ai, model, messages, { ...options, stream: true });
      try {
        for await (const delta of streamResult(result, { firstTokenTimeoutMs: options.firstTokenTimeoutMs ?? 4500 })) {
          yielded = true;
          yield delta;
        }
      } catch (error) {
        lastError = error;
        if (yielded) return;
      }
      if (yielded) return;

      // Streaming transport can fail independently of inference. Never end a voice turn silently:
      // retry the same fast model once as a bounded non-streaming request.
      const fallback = await openModel(ai, model, messages, { ...options, stream: false });
      const text = readFinal(fallback);
      if (text) {
        yield text;
        return;
      }
      lastError = new Error(`Workers AI returned an empty response for ${model}`);
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  throw new Error('No Workers AI conversation model produced text');
}

export function streamCloudflareLiveConversation(ai, messages, options = {}) {
  return streamCascade(ai, [LIVE_CONVERSATION_MODEL], messages, options);
}

export function streamCloudflareQualityConversation(ai, messages, options = {}) {
  return streamCascade(ai, [QUALITY_CONVERSATION_MODEL, LIVE_CONVERSATION_MODEL], messages, options);
}

export function streamCloudflareGroundedConversation(ai, messages, options = {}) {
  return streamCascade(ai, [GROUNDING_CONVERSATION_MODEL, GROUNDING_FALLBACK_MODEL, QUALITY_CONVERSATION_MODEL, LIVE_CONVERSATION_MODEL], messages, options);
}

function timedSignal(parentSignal, timeoutMs) {
  const ms = Math.max(0, Number(timeoutMs) || 0);
  if (!(ms > 0) || typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return parentSignal;
  const timeoutSignal = AbortSignal.timeout(ms);
  if (!parentSignal) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([parentSignal, timeoutSignal]);
  return parentSignal;
}

async function awaitWithTimeout(promise, timeoutMs, label = 'operation') {
  const ms = Math.max(0, Number(timeoutMs) || 0);
  if (!(ms > 0)) return promise;
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runNonStreamingCascade(ai, models, messages, options = {}) {
  let lastError = null;
  const perModelTimeoutMs = Math.max(0, Math.min(12000, Number(options.perModelTimeoutMs) || 0));
  for (const model of [...new Set(models.filter(Boolean))]) {
    try {
      const modelSignal = timedSignal(options.signal, perModelTimeoutMs);
      const result = await awaitWithTimeout(
        openModel(ai, model, messages, { ...options, signal: modelSignal, stream: false }),
        perModelTimeoutMs ? perModelTimeoutMs + 150 : 0,
        `Workers AI ${model}`,
      );
      const text = readFinal(result);
      if (text) return { text, model };
      lastError = new Error(`Workers AI returned an empty response for ${model}`);
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return { text: '', model: null };
}

const BENCH_PROMPTS = [
  'ユーザーが「明日の予定を整理したい」と言いました。自然な日本語で2文だけ返してください。',
  '3万円前後の中古ノートPCを買う人への注意点を、電話で話すように3文以内で答えてください。',
  '相手が「今日はちょっと疲れた」と言いました。過剰に励まさず自然な会話を返してください。',
];

export async function benchmarkVoiceModels(ai, options = {}) {
  const prompt = String(options.prompt || '').trim() || BENCH_PROMPTS[0];
  const models = [LIVE_CONVERSATION_MODEL, QUALITY_CONVERSATION_MODEL, GROUNDING_CONVERSATION_MODEL, GROUNDING_FALLBACK_MODEL];
  const out = [];
  for (const model of models) {
    const started = Date.now();
    try {
      const response = await runNonStreamingCascade(ai, [model], [
        { role: 'system', content: '電話で自然に聞ける日本語で簡潔に答える。' },
        { role: 'user', content: prompt },
      ], {
        maxTokens: 220,
        temperature: 0.15,
        sessionAffinity: options.sessionAffinity,
      });
      out.push({ model, ok: Boolean(response.text), elapsedMs: Date.now() - started, text: response.text });
    } catch (error) {
      out.push({ model, ok: false, elapsedMs: Date.now() - started, error: String(error?.message || error).slice(0, 400) });
    }
  }
  return { prompt, results: out };
}

const EVASIVE_RE = /(ご提示いただいた検索結果|いただいた検索結果|ご提示いただいた情報|ページや情報があれば|具体的な情報源を提示|別の情報源を提示|改めてご提示|回答を差し上げることができません|根拠に基づいた回答.*できません|現時点では.*答え.*できません)/i;
const WEAK_ONLY_RE = /(今の検索では|今回の検索では|検索結果では).{0,35}(裏付け|確認|情報).{0,35}(十分では|できません|ありません)/i;
const SHOPPING_INTENT_RE = /(どこで買|買うなら|購入先|販売店|店舗|店で|おすすめ.*店|どこがいい)/i;

export function isEvasiveGroundedAnswer(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return true;
  if (EVASIVE_RE.test(value)) return true;
  if (WEAK_ONLY_RE.test(value) && value.length < 240) return true;
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
      content: `${question}\n\n[システムが会話文脈から解決した検索課題]\n${resolvedQuestion}\n\n[Web検索で取得した根拠]\n${evidence}\n\n回答ルール:\n- まず質問そのものに具体的に答える。検索の成否の説明から始めない。\n- 現在の価格、在庫、日時、時刻表、法律、人物、製品の現行仕様など変化し得る事実は上の検索根拠から確認できた範囲だけ答える。\n- 購入先、おすすめ、比較、選び方では、検索結果のタイトルに実在候補が出ていれば候補名として使ってよい。ただし表記を勝手に短縮・改名しない。\n- 会話中の予算・用途・地域などと安定した一般知識・論理的比較を使って役立つ結論まで答える。\n- 検索が不十分でも回答全体を拒否しない。未確認なのは変化し得る具体的事実だけに限定する。\n- 「いただいた検索結果」「ご提示いただいた情報」「別の情報源を提示して」など、検索責任をユーザーへ返す表現は禁止。\n- 「今の検索では裏付けが十分ではない」だけで回答を終えるのは禁止。\n- 電話で自然に聞ける日本語で、短い文を使い、まず結論、その後に重要な根拠を1〜3点だけ補足する。URLは読み上げない。`,
    },
  ];
}

export async function answerWithCloudflareWebSearch(ai, question, history, systemPrompt, options = {}) {
  const totalStarted = Date.now();
  const signal = options.signal;
  const deepSearch = await runDeepSearch(ai, question, history, signal, { timeoutMs: 4400 });
  const ranked = deepSearch.results || [];
  const resolvedQuestion = deepSearch.plan?.resolvedQuestion || question;
  const searchContext = formatSearchContext(ranked);
  const evidence = searchContext || '今回の取得では直接のWeb根拠が取れなかった。現在価格・在庫・営業時間など変化する具体的事実は作らない。ただし質問への一般的な判断や購入チャネルの比較は必ず続けること。';
  const messages = buildGroundedMessages(question, history, systemPrompt, resolvedQuestion, evidence);

  const answerStarted = Date.now();
  let answer;
  try {
    // Use one reliable high-capacity grounded attempt first. A slower model is only a bounded fallback.
    answer = await runNonStreamingCascade(ai, [GROUNDING_FALLBACK_MODEL, GROUNDING_CONVERSATION_MODEL], messages, {
      signal,
      maxTokens: 680,
      temperature: 0.08,
      perModelTimeoutMs: 3800,
      sessionAffinity: options.sessionAffinity,
    });
  } catch {
    answer = { text: '', model: null };
  }
  const answerMs = Date.now() - answerStarted;

  let repaired = false;
  if (isEvasiveGroundedAnswer(answer.text)) {
    const rescue = deterministicRescue(resolvedQuestion || question, ranked);
    if (rescue) {
      answer = { text: rescue, model: answer.model || GROUNDING_FALLBACK_MODEL };
      repaired = true;
    }
  }

  return {
    text: String(answer.text || '').trim() || '確認できた範囲から、まず実用的な選択肢を絞って答えます。',
    provider: 'cloudflare-workers-ai-bounded-contextual-search-v18',
    nativeSearch: false,
    model: answer.model,
    resolvedQuestion,
    queries: deepSearch.plan?.queries || [question],
    planned: Boolean(deepSearch.plan?.planned),
    recovered: Boolean(deepSearch.recovered),
    rounds: Number(deepSearch.rounds) || 1,
    coverage: deepSearch.coverage || null,
    evidenceUseful: Boolean(deepSearch.evidenceUseful),
    answerRepaired: repaired,
    sources: ranked.slice(0, 12),
    timings: {
      ...(deepSearch.timings || {}),
      answerMs,
      beforeAuditMs: Date.now() - totalStarted,
    },
  };
}

export { readFinal, readDelta, streamResult };

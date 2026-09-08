from pathlib import Path
import re


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one match, found {count}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1))


def regex_replace_once(path, pattern, replacement, flags=0):
    p = Path(path)
    text = p.read_text()
    new, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f'{path}: regex expected one match, found {count}: {pattern[:120]!r}')
    p.write_text(new)


# 1) Restore the Workers AI streaming contract. ReadableStream is itself async iterable,
# so it must be parsed as SSE bytes BEFORE the generic async-iterator branch.
replace_once(
    'src/cloudflare-llm.js',
    "  if (options.sessionAffinity) runOptions.headers = { 'x-session-affinity': options.sessionAffinity };\n",
    "  if (options.sessionAffinity) runOptions.extraHeaders = { 'x-session-affinity': options.sessionAffinity };\n",
)

stream_result = r'''async function readStreamChunk(reader, timeoutMs = 0) {
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
'''
regex_replace_once(
    'src/cloudflare-llm.js',
    r"async function\* streamResult\(result\) \{[\s\S]*?\n\}\n\nasync function\* streamCascade",
    stream_result + "\nasync function* streamCascade",
)

stream_cascade = r'''async function* streamCascade(ai, models, messages, options = {}) {
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
'''
regex_replace_once(
    'src/cloudflare-llm.js',
    r"async function\* streamCascade\(ai, models, messages, options = \{\}\) \{[\s\S]*?\n\}\n\nexport function streamCloudflareLiveConversation",
    stream_cascade + "\nexport function streamCloudflareLiveConversation",
)
replace_once(
    'src/cloudflare-llm.js',
    'export { readFinal, readDelta };\n',
    'export { readFinal, readDelta, streamResult };\n',
)

# 2) Normal conversation is latency-first. Only explicit factual/current/search turns use deep search.
replace_once('src/worker-v14.js', "const VOICE_REVISION = 'cloudflare-live-v18.2';\n", "const VOICE_REVISION = 'cloudflare-live-v18.3';\n")

insert_after = '''function needsQualityConversation(text) {\n  const value = String(text || '').trim();\n  return value.length >= 52 || QUALITY_INTENT_RE.test(value);\n}\n'''
quick_fn = '''function needsQualityConversation(text) {\n  const value = String(text || '').trim();\n  return value.length >= 52 || QUALITY_INTENT_RE.test(value);\n}\n\nfunction quickCasualReply(text) {\n  const value = String(text || '').trim().replace(/[！!。．.]+$/u, '');\n  if (/^(こんにちは|こんにちわ|やあ|どうも)$/u.test(value)) return 'こんにちは。どうしました？';\n  if (/^(おはよう|おはようございます)$/u.test(value)) return 'おはようございます。どうしました？';\n  if (/^(こんばんは)$/u.test(value)) return 'こんばんは。どうしました？';\n  if (/^(ありがとう|ありがとうございます|どうもありがとう)$/u.test(value)) return 'どういたしまして。';\n  if (/^(元気|元気ですか|お元気ですか)$/u.test(value)) return '元気ですよ。ありがとうございます。';\n  return '';\n}\n'''
replace_once('src/worker-v14.js', insert_after, quick_fn)

old_onturn = '''  async onTurn(transcript, context) {\n    const affinity = sessionAffinity(context);\n\n    if (shouldDeepSearch(transcript, [])) return this.searchResponse(transcript, context);\n\n    const quality = needsQualityConversation(transcript);\n    const messages = [\n      { role: 'system', content: quality ? QUALITY_SYSTEM_PROMPT : CASUAL_SYSTEM_PROMPT },\n      { role: 'user', content: transcript },\n    ];\n\n    if (quality) {\n      return this.trackAssistant(\n        streamCloudflareQualityConversation(this.env.AI, messages, {\n          signal: context.signal,\n          maxTokens: 480,\n          sessionAffinity: affinity,\n        }),\n        context,\n        'quality',\n      );\n    }\n\n    return this.trackAssistant(\n      streamCloudflareLiveConversation(this.env.AI, messages, {\n        signal: context.signal,\n        maxTokens: 320,\n        sessionAffinity: affinity,\n      }),\n      context,\n      'live',\n    );\n  }\n'''
new_onturn = '''  async onTurn(transcript, context) {\n    const affinity = sessionAffinity(context);\n\n    // Accuracy-first work is isolated to web research. Ordinary conversation never waits for\n    // planning, reranking, auditing, or the slower quality model.\n    if (shouldDeepSearch(transcript, [])) return this.searchResponse(transcript, context);\n\n    const quick = quickCasualReply(transcript);\n    if (quick) {\n      return this.trackAssistant((async function* () { yield quick; })(), context, 'instant-local');\n    }\n\n    const messages = [\n      { role: 'system', content: CASUAL_SYSTEM_PROMPT },\n      { role: 'user', content: transcript },\n    ];\n\n    return this.trackAssistant(\n      streamCloudflareLiveConversation(this.env.AI, messages, {\n        signal: context.signal,\n        maxTokens: 320,\n        firstTokenTimeoutMs: 4500,\n        sessionAffinity: affinity,\n      }),\n      context,\n      'live-fast',\n    );\n  }\n'''
replace_once('src/worker-v14.js', old_onturn, new_onturn)

replace_once(
    'src/worker-v14.js',
    "        conversationPersistence: 'isolated-page-session-no-context',\n",
    "        conversationPersistence: 'warm-transport-only-no-prompt-history',\n",
)
replace_once(
    'src/worker-v14.js',
    "        llmRouting: 'live / quality / verified-two-pass-grounded-search',\n",
    "        llmRouting: 'instant-local / live-fast / verified-two-pass-grounded-search',\n        normalConversationLiveOnly: true,\n        casualFastPath: true,\n        searchPrecisionOnly: true,\n",
)

# 3) Reuse the warm Durable Object transport. Server prompts still ignore stored history,
# so this does not reintroduce prior-conversation context.
regex_replace_once(
    'src/cloudflare-live-client.js',
    r"  const AGENT_ID = .*?;\n  const AGENT_PATH = '/agents/talk-sys-voice-agent/' \+ AGENT_ID;\n",
    "  const AGENT_PATH = '/agents/talk-sys-voice-agent/default';\n",
)

# 4) Update textual regression contracts.
for path in ['tests/voice-llm-contract.test.mjs', 'tests/gemini-live-contract.test.mjs']:
    replace_once(path, "cloudflare-live-v18\\.2", "cloudflare-live-v18\\.3")

replace_once(
    'tests/voice-llm-contract.test.mjs',
    "  assert.match(liveClient, /crypto\\.randomUUID/);\n",
    "  assert.match(liveClient, /talk-sys-voice-agent\\/default/);\n  assert.doesNotMatch(liveClient, /crypto\\.randomUUID/);\n",
)
replace_once(
    'tests/voice-llm-contract.test.mjs',
    "  assert.match(worker, /typedSpeechVoiceOutput: true/);\n",
    "  assert.match(worker, /typedSpeechVoiceOutput: true/);\n  assert.match(worker, /normalConversationLiveOnly: true/);\n  assert.match(worker, /casualFastPath: true/);\n  assert.match(worker, /searchPrecisionOnly: true/);\n  assert.match(cloudflareLlm, /result instanceof ReadableStream \\|\\| typeof result\\.getReader === 'function'/);\n  assert.match(cloudflareLlm, /extraHeaders/);\n",
)

replace_once(
    'tests/gemini-live-contract.test.mjs',
    "  assert.match(workerSource, /needsQualityConversation/);\n",
    "  assert.match(workerSource, /normalConversationLiveOnly: true/);\n  assert.match(workerSource, /casualFastPath: true/);\n",
)
replace_once(
    'tests/gemini-live-contract.test.mjs',
    "  assert.match(CLOUDFLARE_LIVE_CLIENT, /crypto\\.randomUUID/);\n  assert.match(CLOUDFLARE_LIVE_CLIENT, /talk-sys-voice-agent\\/' \\+ AGENT_ID/);\n",
    "  assert.match(CLOUDFLARE_LIVE_CLIENT, /talk-sys-voice-agent\\/default/);\n  assert.doesNotMatch(CLOUDFLARE_LIVE_CLIENT, /crypto\\.randomUUID/);\n",
)

print('v18.3 fast live patch applied')

from pathlib import Path
import re


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one match, got {count}: {old[:140]!r}')
    p.write_text(text.replace(old, new, 1))


def regex_replace_once(path, pattern, replacement, flags=0):
    p = Path(path)
    text = p.read_text()
    new_text, count = re.subn(pattern, lambda _m: replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f'{path}: regex expected one match, got {count}: {pattern[:140]!r}')
    p.write_text(new_text)


# -----------------------------------------------------------------------------
# worker: connection-scoped short-term conversation context for BOTH chat/search.
# -----------------------------------------------------------------------------
replace_once('src/worker-v14.js', "const VOICE_REVISION = 'cloudflare-live-v18.4';", "const VOICE_REVISION = 'cloudflare-live-v18.5';")
replace_once(
    'src/worker-v14.js',
    '以前の発話内容は参照せず、今回の発話だけを独立した質問として扱ってください。省略されていて対象が特定できない場合は、過去会話から補わず短く確認してください。',
    '同じ接続の直近会話履歴が渡された場合は、その文脈を使って「それ」「さっきの」「調べて」「どこがいい？」などの省略を自然に解決してください。ただし過去のassistant発言は事実根拠ではありません。ユーザーの訂正や最新の発言を優先し、外部確認が必要な事実は検索経路に任せてください。',
)

session_anchor = '''function sessionAffinity(context) {\n  return `talksys-${String(context?.connection?.id || 'default').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 96)}`;\n}\n\n'''
session_new = session_anchor + '''const CONTEXT_TTL_MS = 30 * 60 * 1000;\nconst CONTEXT_MAX_MESSAGES = 8;\n\nfunction conversationKey(context) {\n  return String(context?.connection?.id || 'default').slice(0, 160);\n}\n\nfunction compactHistory(messages) {\n  return (Array.isArray(messages) ? messages : [])\n    .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && String(item.content || '').trim())\n    .slice(-CONTEXT_MAX_MESSAGES)\n    .map((item) => ({ role: item.role, content: String(item.content).slice(0, 1200) }));\n}\n\n'''
replace_once('src/worker-v14.js', session_anchor, session_new)

replace_once(
    'src/worker-v14.js',
    "  assistantSpeechAt = 0;\n\n  createTranscriber() {",
    "  assistantSpeechAt = 0;\n  conversationMemory = new Map();\n\n  getConversationHistory(context) {\n    const key = conversationKey(context);\n    const entry = this.conversationMemory.get(key);\n    if (!entry) return [];\n    if (Date.now() - entry.updatedAt > CONTEXT_TTL_MS) {\n      this.conversationMemory.delete(key);\n      return [];\n    }\n    return compactHistory(entry.messages);\n  }\n\n  rememberConversationTurn(context, userText, assistantText) {\n    const user = String(userText || '').trim();\n    const assistant = cleanSpeechText(assistantText);\n    if (!user && !assistant) return;\n    const key = conversationKey(context);\n    const prior = this.getConversationHistory(context);\n    const messages = [...prior];\n    if (user) messages.push({ role: 'user', content: user.slice(0, 1200) });\n    if (assistant) messages.push({ role: 'assistant', content: assistant.slice(0, 1200) });\n    this.conversationMemory.set(key, { updatedAt: Date.now(), messages: compactHistory(messages) });\n  }\n\n  createTranscriber() {",
)

new_track = '''  trackAssistant(iterable, context, tier, userText = '') {\n    const self = this;\n    return (async function* () {\n      self.currentAssistantText = '';\n      self.assistantSpeechAt = Date.now();\n      try {\n        context?.connection?.send(JSON.stringify({ type: 'model_route', tier }));\n      } catch {}\n      try {\n        for await (const delta of iterable) {\n          const value = String(delta || '');\n          if (!value) continue;\n          self.currentAssistantText += value;\n          yield value;\n        }\n      } finally {\n        const clean = cleanSpeechText(self.currentAssistantText);\n        if (clean) self.lastAssistantText = clean;\n        self.rememberConversationTurn(context, userText, clean);\n        self.currentAssistantText = '';\n        self.assistantSpeechAt = Date.now();\n      }\n    })();\n  }\n\n'''
regex_replace_once('src/worker-v14.js', r"  trackAssistant\(iterable, context, tier\) \{[\s\S]*?\n  \}\n\n(?=  searchResponse)", new_track)

new_search_response = '''  searchResponse(transcript, context, history) {\n    const self = this;\n    return this.trackAssistant((async function* () {\n      try { context.connection.send(JSON.stringify({ type: 'search_status', phase: 'planning', searched: true })); } catch {}\n\n      let searchSettled = false;\n      let secondProgressTimer = null;\n      const searchPromise = answerWithVerifiedWebSearch(\n        self.env.AI,\n        transcript,\n        history,\n        GROUNDED_SYSTEM_PROMPT,\n        {\n          signal: context.signal,\n          sessionAffinity: sessionAffinity(context),\n        },\n      ).finally(() => {\n        searchSettled = true;\n        if (secondProgressTimer) clearTimeout(secondProgressTimer);\n      });\n      const fillerPromise = generateSearchFiller(self.env.AI, transcript, history, context.signal);\n      secondProgressTimer = setTimeout(() => {\n        if (searchSettled || context.signal?.aborted) return;\n        try {\n          context.connection.send(JSON.stringify({\n            type: 'search_status',\n            phase: 'searching',\n            searched: true,\n            waitPhrase: '候補を絞って情報を照合しています。もう少しお待ちください。',\n          }));\n        } catch {}\n      }, 5500);\n\n      const first = await Promise.race([\n        searchPromise.then((result) => ({ type: 'result', result })),\n        fillerPromise.then((text) => ({ type: 'filler', text })).catch(() => ({ type: 'filler', text: '' })),\n      ]);\n\n      let result;\n      if (first.type === 'filler') {\n        const filler = cleanSpeechText(first.text);\n        if (filler && !context.signal?.aborted) {\n          try { context.connection.send(JSON.stringify({ type: 'search_status', phase: 'searching', searched: true, waitPhrase: filler })); } catch {}\n        }\n        result = await searchPromise;\n      } else {\n        result = first.result;\n      }\n\n      try {\n        context.connection.send(JSON.stringify({\n          type: 'search_status',\n          phase: 'done',\n          searched: true,\n          provider: result.provider,\n          model: result.model,\n          planned: Boolean(result.planned),\n          resolvedQuestion: result.resolvedQuestion || transcript,\n          queries: Array.isArray(result.queries) ? result.queries.slice(0, 12) : [],\n          rounds: Number(result.rounds) || 1,\n          evidenceUseful: Boolean(result.evidenceUseful),\n          auditPassed: Boolean(result.auditPassed),\n          timings: result.timings || null,\n          sources: Array.isArray(result.sources) ? result.sources.slice(0, 12).map((item) => ({ title: item.title, url: item.url })) : [],\n        }));\n      } catch {}\n\n      yield String(result.text || '確認できた範囲を先に答えます。');\n    })(), context, 'verified-deep-search-v18', transcript);\n  }\n\n'''
regex_replace_once('src/worker-v14.js', r"  searchResponse\(transcript, context\) \{[\s\S]*?\n  \}\n\n(?=  async onTurn)", new_search_response)

new_onturn = '''  async onTurn(transcript, context) {\n    const affinity = sessionAffinity(context);\n    const history = this.getConversationHistory(context);\n\n    // Precision-first work is isolated to web research. Context itself is shared across turns.\n    if (shouldDeepSearch(transcript, history)) return this.searchResponse(transcript, context, history);\n\n    const quick = quickCasualReply(transcript);\n    if (quick) {\n      return this.trackAssistant((async function* () { yield quick; })(), context, 'instant-local', transcript);\n    }\n\n    const messages = [\n      { role: 'system', content: CASUAL_SYSTEM_PROMPT },\n      ...history,\n      { role: 'user', content: transcript },\n    ];\n\n    return this.trackAssistant(\n      streamCloudflareLiveConversation(this.env.AI, messages, {\n        signal: context.signal,\n        maxTokens: 320,\n        firstTokenTimeoutMs: 4500,\n        sessionAffinity: affinity,\n      }),\n      context,\n      'live-fast',\n      transcript,\n    );\n  }\n'''
regex_replace_once('src/worker-v14.js', r"  async onTurn\(transcript, context\) \{[\s\S]*?\n  \}\n(?=\}\n\nfunction serveScript)", new_onturn)

replace_once('src/worker-v14.js', "conversationPersistence: 'warm-transport-only-no-prompt-history',", "conversationPersistence: 'connection-scoped-short-term-context',")
replace_once('src/worker-v14.js', 'sharedTypedAndVoiceHistory: false,', 'sharedTypedAndVoiceHistory: true,')
replace_once('src/worker-v14.js', 'crossTurnContext: false,', 'crossTurnContext: true,')
replace_once('src/worker-v14.js', 'crossSessionContext: false,', 'crossSessionContext: false,\n        conversationContextMaxMessages: CONTEXT_MAX_MESSAGES,\n        conversationContextTtlMs: CONTEXT_TTL_MS,')
replace_once('src/worker-v14.js', "llmRouting: 'instant-local / live-fast / verified-two-pass-grounded-search',", "llmRouting: 'instant-local / contextual-live-fast / bounded-contextual-grounded-search',")
replace_once('src/worker-v14.js', 'searchSecondProgressSpeechMs: 8000,', 'searchSecondProgressSpeechMs: 5500,')

# -----------------------------------------------------------------------------
# web search: route/travel directions are external facts, not casual guessing.
# -----------------------------------------------------------------------------
replace_once(
    'src/web-search.js',
    "const EXPLICIT_SEARCH_RE = /(検索して|検索|調べて|調べる|ウェブで|ネットで|最新情報)/i;\n",
    "const EXPLICIT_SEARCH_RE = /(検索して|検索|調べて|調べる|ウェブで|ネットで|最新情報)/i;\nconst ROUTE_QUERY_RE = /(?:から.{1,48}(?:まで|へ).{0,36}(?:行|行き|アクセス|交通|電車|列車|新幹線|特急|乗り換え|経路|どうやって)|(?:行き方|経路|乗り換え|どうやって|どう行けば).{0,32}(?:行|行く|行け|着))/i;\n",
)
replace_once(
    'src/web-search.js',
    '  if (EXPLICIT_SEARCH_RE.test(value) || CURRENT_RE.test(value)) return true;\n',
    '  if (EXPLICIT_SEARCH_RE.test(value) || CURRENT_RE.test(value) || ROUTE_QUERY_RE.test(value)) return true;\n',
)

# -----------------------------------------------------------------------------
# search orchestration: prioritize user corrections, reject dictionary-meta search,
# and bound filler generation so the bridge speech always arrives quickly.
# -----------------------------------------------------------------------------
replace_once('src/search-orchestrator.js', 'export const SEARCH_FILLER_MIN_DELAY_MS = 650;', 'export const SEARCH_FILLER_MIN_DELAY_MS = 320;')
replace_once(
    'src/search-orchestrator.js',
    "const HIGH_VERIFICATION_RE = /(価格|値段|在庫|営業時間|今日|現在|最新|販売中|発売|法律|制度|時刻|予定|日程|店|店舗|販売店|買う|購入先|どこで買)/i;\n",
    "const HIGH_VERIFICATION_RE = /(価格|値段|在庫|営業時間|今日|現在|最新|販売中|発売|法律|制度|時刻|予定|日程|店|店舗|販売店|買う|購入先|どこで買|行き方|経路|乗り換え|交通)/i;\nconst GENERIC_RESEARCH_COMMAND_RE = /^(?:ちょっと)?(?:調べて(?:ごらん|みて|くれ|ください)?|検索して(?:みて|くれ|ください)?|確認して(?:みて|くれ|ください)?)[。！!？?]*$/i;\nconst BAD_PROGRESS_TOPIC_RE = /^(?:検索内容(?:が)?不明|検索内容|内容不明|不明|ご相談の内容|今回の内容|質問内容)$/i;\n",
)

new_heuristic = '''export function heuristicContextQuery(transcript, history) {\n  const current = cleanQuery(transcript);\n  if (!current) return '';\n  const dependent = looksContextDependentFollowup(current) || GENERIC_RESEARCH_COMMAND_RE.test(current);\n  if (current.length >= 48 && !dependent) return current;\n\n  const useful = usefulHistoryForFallback(history);\n  const userContext = useful\n    .filter((item) => item.role === 'user')\n    .map((item) => cleanQuery(item.content))\n    .filter(Boolean)\n    .slice(-4)\n    .join(' ');\n  const fallbackContext = userContext || useful\n    .map((item) => cleanQuery(item.content))\n    .filter(Boolean)\n    .slice(-3)\n    .join(' ');\n\n  if (!fallbackContext) return current;\n  return cleanQuery(`${fallbackContext} ${current}`);\n}\n'''
regex_replace_once('src/search-orchestrator.js', r"export function heuristicContextQuery\(transcript, history\) \{[\s\S]*?\n\}\n(?=\nexport function shouldDeepSearch)", new_heuristic)

replace_once(
    'src/search-orchestrator.js',
    '- 「それ」「どこがいい？」「調べてくれない？」「別府市内なら？」などの省略は直前のuser/assistant会話から対象だけ復元する。assistantの過去回答は事実根拠にはしない。',
    '- 「それ」「どこがいい？」「調べてごらん」「調べてくれない？」「別府市内なら？」などの省略は直前の会話から対象だけ復元する。「調べる」という語の辞書的意味を検索してはいけない。assistantの過去回答は事実根拠にはせず、ユーザーの訂正を最優先する。',
)

# Generic research commands must keep the contextual fallback question even if the planner drifts.
replace_once(
    'src/search-orchestrator.js',
    '      const resolvedQuestion = planned.resolvedQuestion || fallbackQuestion;\n      const deterministic = buildDeterministicSearchQueries(resolvedQuestion, history);\n      const queries = uniqueQueries([\n        ...planned.queries.slice(0, 4),\n        ...deterministic,\n        ...planned.queries.slice(4),\n        resolvedQuestion,\n      ], SEARCH_MAX_QUERIES);\n',
    "      const genericCommand = GENERIC_RESEARCH_COMMAND_RE.test(cleanQuery(transcript));\n      const resolvedQuestion = genericCommand ? fallbackQuestion : (planned.resolvedQuestion || fallbackQuestion);\n      const deterministic = buildDeterministicSearchQueries(resolvedQuestion, history);\n      const plannedQueries = genericCommand\n        ? planned.queries.filter((query) => {\n            const compact = cleanQuery(query);\n            const signals = (resolvedQuestion.match(/[一-龠々ヶ]{2,}|[ァ-ヶー]{2,}|[A-Za-z0-9-]{3,}/g) || []).slice(-12);\n            return signals.some((signal) => compact.includes(signal));\n          })\n        : planned.queries;\n      const queries = uniqueQueries([\n        ...plannedQueries.slice(0, 4),\n        ...deterministic,\n        ...plannedQueries.slice(4),\n        resolvedQuestion,\n      ], SEARCH_MAX_QUERIES);\n",
)

new_sanitize_topic = '''function sanitizeProgressTopic(value) {\n  const topic = String(value || '')\n    .replace(/[\\r\\n\\t]+/g, ' ')\n    .replace(/[「」『』"']/g, '')\n    .replace(/^(?:検索対象|トピック|topic)[:：]\\s*/i, '')\n    .replace(/(?:について)?検索(?:しています|中です)?[。！!]?$/u, '')\n    .replace(/\\s+/g, ' ')\n    .trim()\n    .slice(0, 52);\n  return BAD_PROGRESS_TOPIC_RE.test(topic) ? '' : topic;\n}\n'''
regex_replace_once('src/search-orchestrator.js', r"function sanitizeProgressTopic\(value\) \{[\s\S]*?\n\}\n(?=\nfunction fallbackProgressTopic)", new_sanitize_topic)

new_generate_filler = '''export async function generateSearchFiller(ai, transcript, history, signal) {\n  const current = cleanQuery(transcript);\n  const fallback = fallbackProgressTopic(transcript, history);\n  const recent = recentConversation(history, 8);\n  const contextualCommand = GENERIC_RESEARCH_COMMAND_RE.test(current) && Boolean(recent);\n\n  const modelPromise = ai?.run\n    ? ai.run(SEARCH_FILLER_MODEL, {\n        messages: [\n          {\n            role: 'system',\n            content: '検索本体は別処理です。あなたは待ち時間の案内だけ担当します。直前の会話と今回の発話から、今確認している対象を日本語で12〜32文字程度に要約してください。回答・推測・店名の新規生成は禁止。「検索内容が不明」「ご相談の内容」のような曖昧語は禁止。「調べて」が今回の発話なら、その語の意味ではなく直前の話題を要約してください。検索対象の短い名詞句だけを返してください。',\n          },\n          {\n            role: 'user',\n            content: `直近の会話:\\n${recent || '(なし)'}\\n\\n今回の発話:\\n${String(transcript || '').slice(0, 800)}`,\n          },\n        ],\n        max_completion_tokens: 64,\n        temperature: 0,\n        reasoning_effort: null,\n        chat_template_kwargs: { enable_thinking: false, clear_thinking: true },\n      }, signal ? { signal } : undefined).catch(() => null)\n    : Promise.resolve(null);\n\n  const result = await Promise.race([\n    modelPromise,\n    wait(620, signal).then(() => null).catch(() => null),\n  ]);\n  await wait(SEARCH_FILLER_MIN_DELAY_MS, signal).catch(() => null);\n\n  const topic = sanitizeProgressTopic(extractText(result));\n  if (!topic && contextualCommand) return '前の話を踏まえて確認しています。少し待ってください。';\n  const chosen = topic || fallback;\n  const phrase = `今、${chosen}について検索しています。少しお待ちください。`;\n  return sanitizeFiller(phrase) || (contextualCommand\n    ? '前の話を踏まえて確認しています。少し待ってください。'\n    : `今、${fallback.slice(0, 52)}について検索しています。少しお待ちください。`);\n}\n'''
regex_replace_once('src/search-orchestrator.js', r"export async function generateSearchFiller\(ai, transcript, history, signal\) \{[\s\S]*?\n\}\n(?=\nexport \{ parsePlannerJson)", new_generate_filler)
replace_once(
    'src/search-orchestrator.js',
    "    '検索をかけます。少し待ってください。',\n",
    "    '検索をかけます。少し待ってください。',\n    '前の話を踏まえて確認しています。少し待ってください。',\n",
)

# -----------------------------------------------------------------------------
# client: typed and normal replies get an automatic device-TTS backup even when
# server TTS fails silently (no explicit error event).
# -----------------------------------------------------------------------------
replace_once('src/cloudflare-live-client.js', '  let deviceUtterance = null;\n', '  let deviceUtterance = null;\n  let ttsFallbackTimer = null;\n')
replace_once(
    'src/cloudflare-live-client.js',
    "  function setStatus(text) { if (status) status.textContent = text || ''; }\n\n",
    "  function setStatus(text) { if (status) status.textContent = text || ''; }\n\n  function clearTtsFallbackTimer() {\n    if (!ttsFallbackTimer) return;\n    clearTimeout(ttsFallbackTimer);\n    ttsFallbackTimer = null;\n  }\n\n",
)
replace_once(
    'src/cloudflare-live-client.js',
    "    streamText = '';\n    currentAssistantText = '';\n    serverAudioThisTurn = false;\n",
    "    clearTtsFallbackTimer();\n    streamText = '';\n    currentAssistantText = '';\n    serverAudioThisTurn = false;\n",
)
replace_once(
    'src/cloudflare-live-client.js',
    "    if ((desiredCall || typedVoiceOutput) && ttsFailedThisTurn && !serverAudioThisTurn && value) setTimeout(() => speakJapaneseFallback(value), 120);\n",
    "    clearTtsFallbackTimer();\n    if ((desiredCall || typedVoiceOutput) && !serverAudioThisTurn && value) {\n      const delay = ttsFailedThisTurn ? 120 : 650;\n      ttsFallbackTimer = setTimeout(() => {\n        ttsFallbackTimer = null;\n        if (!serverAudioThisTurn && !playing && !deviceSpeaking) speakJapaneseFallback(value);\n      }, delay);\n    }\n",
)
replace_once(
    'src/cloudflare-live-client.js',
    '  function stopPlayback(interruptServer = false) {\n    playbackQueue = [];\n',
    '  function stopPlayback(interruptServer = false) {\n    clearTtsFallbackTimer();\n    playbackQueue = [];\n',
)
replace_once(
    'src/cloudflare-live-client.js',
    '  function queueAudio(buffer) {\n    if (!(desiredCall || typedVoiceOutput)) {\n',
    '  function queueAudio(buffer) {\n    clearTtsFallbackTimer();\n    if (!(desiredCall || typedVoiceOutput)) {\n',
)

# -----------------------------------------------------------------------------
# tests: reverse the old "forget every turn" contract and cover the screenshot.
# -----------------------------------------------------------------------------
for path in ['tests/voice-llm-contract.test.mjs', 'tests/gemini-live-contract.test.mjs']:
    p = Path(path)
    text = p.read_text().replace('cloudflare-live-v18\\.4', 'cloudflare-live-v18\\.5')
    p.write_text(text)

regex_replace_once(
    'tests/voice-llm-contract.test.mjs',
    r"test\('each turn is self-contained and prior conversation cannot trigger search', \(\) => \{[\s\S]*?\n\}\);",
    '''test('recent conversation context is connection-scoped and feeds both search and normal chat', () => {\n  assert.match(worker, /conversationMemory = new Map/);\n  assert.match(worker, /getConversationHistory\(context\)/);\n  assert.match(worker, /CONTEXT_MAX_MESSAGES = 8/);\n  assert.match(worker, /CONTEXT_TTL_MS = 30 \* 60 \* 1000/);\n  assert.match(worker, /shouldDeepSearch\(transcript, history\)/);\n  assert.match(worker, /answerWithVerifiedWebSearch[\\s\\S]*?transcript,[\\s\\n]*history/);\n  assert.match(worker, /generateSearchFiller\(self\.env\.AI, transcript, history/);\n  assert.match(worker, /\.\.\.history,[\\s\\n]*\{ role: 'user', content: transcript \}/);\n  assert.match(worker, /crossTurnContext: true/);\n  assert.match(worker, /crossSessionContext: false/);\n  assert.match(liveClient, /talk-sys-voice-agent\\/default/);\n});''',
)
replace_once(
    'tests/voice-llm-contract.test.mjs',
    "  assert.match(worker, /searchSecondProgressSpeechMs: 8000/);",
    "  assert.match(worker, /searchSecondProgressSpeechMs: 5500/);",
)
replace_once(
    'tests/voice-llm-contract.test.mjs',
    "  assert.match(worker, /crossTurnContext: false/);",
    "  assert.match(worker, /crossTurnContext: true/);",
)
replace_once(
    'tests/voice-llm-contract.test.mjs',
    "  assert.match(liveClient, /desiredCall \\|\\| typedVoiceOutput/);\n",
    "  assert.match(liveClient, /desiredCall \\|\\| typedVoiceOutput/);\n  assert.match(liveClient, /ttsFallbackTimer/);\n  assert.match(liveClient, /!serverAudioThisTurn && !playing && !deviceSpeaking/);\n",
)

# web-search behavior regression.
p = Path('tests/web-search.test.mjs')
text = p.read_text()
needle = "test('knowledge questions still search', () => {"
insert = '''test('travel route questions search instead of guessing from model memory', () => {\n  assert.equal(needsWebSearch('東京から前橋まで行きたいんだけど、どうやって行こうか悩んでる'), true);\n  assert.equal(needsWebSearch('新宿から松本まで電車でどう行けばいい？'), true);\n});\n\n'''
if insert not in text:
    if needle not in text:
        raise SystemExit('tests/web-search.test.mjs insertion anchor not found')
    text = text.replace(needle, insert + needle, 1)
p.write_text(text)

Path('tests/contextual-conversation-regression.test.mjs').write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { heuristicContextQuery, shouldDeepSearch, sanitizeFiller } from '../src/search-orchestrator.js';

const worker = await readFile(new URL('../src/worker-v14.js', import.meta.url), 'utf8');
const client = await readFile(new URL('../src/cloudflare-live-client.js', import.meta.url), 'utf8');
const orchestrator = await readFile(new URL('../src/search-orchestrator.js', import.meta.url), 'utf8');

const history = [
  { role: 'user', content: '東京から前橋まで行かないとなんだけど、どうやって行こうか悩んでる' },
  { role: 'assistant', content: '新幹線か特急あずさが定番ですね。' },
  { role: 'user', content: 'あずさは前橋行かないよ' },
  { role: 'assistant', content: 'あずさは前橋には行かないんですか。' },
];

test('generic research instruction resolves against recent user context, not the word 調べる', () => {
  const resolved = heuristicContextQuery('調べてごらん', history);
  assert.match(resolved, /東京/);
  assert.match(resolved, /前橋/);
  assert.match(resolved, /あずさ/);
  assert.match(resolved, /調べてごらん/);
  assert.equal(shouldDeepSearch('調べてごらん', history), true);
});

test('search planner explicitly forbids dictionary-meta search and prioritizes corrections', () => {
  assert.match(orchestrator, /「調べる」という語の辞書的意味を検索してはいけない/);
  assert.match(orchestrator, /ユーザーの訂正を最優先/);
  assert.match(orchestrator, /GENERIC_RESEARCH_COMMAND_RE/);
});

test('search filler rejects unknown-topic nonsense and has contextual bridge fallback', () => {
  assert.equal(sanitizeFiller('前の話を踏まえて確認しています。少し待ってください。'), '前の話を踏まえて確認しています。少し待ってください。');
  assert.match(orchestrator, /BAD_PROGRESS_TOPIC_RE/);
  assert.match(orchestrator, /検索内容(?:が)?不明/);
  assert.match(orchestrator, /Promise\.race\(\[/);
});

test('normal conversation keeps recent history and audio has a silent-failure fallback', () => {
  assert.match(worker, /\.\.\.history/);
  assert.match(worker, /rememberConversationTurn/);
  assert.match(client, /ttsFallbackTimer/);
  assert.match(client, /const delay = ttsFailedThisTurn \? 120 : 650/);
  assert.match(client, /speakJapaneseFallback\(value\)/);
});
''')

print('v18.5 contextual conversation repair patch applied')

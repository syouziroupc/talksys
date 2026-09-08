from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one match, found {count}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1))


# UI copy: no history carryover, typed input gets spoken replies.
replace_once(
    'src/index.js',
    '      <p>最新情報や店・価格・制度などは、会話の文脈を引き継いで複数回検索してから答えます。検索中は少し待つ場合があります。</p>\n',
    '      <p>最新情報や店・価格・制度など、今回の質問だけで外部確認が必要な内容を検索します。以前の会話内容は次の質問へ引き継ぎません。</p>\n',
)
replace_once(
    'src/index.js',
    '    <section id="chat" class="chat" aria-live="polite"><div class="msg assistant">通話ボタンを押して話せます。外で話せないときは、下の文字入力を発話として同じ会話に送れます。</div></section>\n',
    '    <section id="chat" class="chat" aria-live="polite"><div class="msg assistant">通話ボタンで話せます。外で話せないときは、下の文字入力を発話として送れます。</div></section>\n',
)
replace_once(
    'src/index.js',
    '    <div class="text-note">文字入力は「話したこと」として会話履歴に入ります。通話していない間はAI音声を再生しません。</div>\n',
    '    <div class="text-note">文字入力は「話したこと」として送ります。マイクは使わず、返事は文字と音声で再生します。以前の質問内容は次の質問へ引き継ぎません。</div>\n',
)

# Browser client: isolate every page session, allow typed input with audible output,
# keep search progress out of the answer transcript, and interrupt stale turns.
replace_once(
    'src/cloudflare-live-client.js',
    "  const AGENT_PATH = '/agents/talk-sys-voice-agent/default';\n",
    "  const AGENT_ID = (crypto.randomUUID?.() || ('session-' + Date.now() + '-' + Math.random().toString(16).slice(2))).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 96);\n  const AGENT_PATH = '/agents/talk-sys-voice-agent/' + AGENT_ID;\n",
)
replace_once(
    'src/cloudflare-live-client.js',
    "  let ttsFailedThisTurn = false;\n",
    "  let ttsFailedThisTurn = false;\n  let typedVoiceOutput = false;\n  let lastSearchWaitPhrase = '';\n",
)
replace_once(
    'src/cloudflare-live-client.js',
    "    if (desiredCall && ttsFailedThisTurn && !serverAudioThisTurn && value) setTimeout(() => speakJapaneseFallback(value), 120);\n",
    "    if ((desiredCall || typedVoiceOutput) && ttsFailedThisTurn && !serverAudioThisTurn && value) setTimeout(() => speakJapaneseFallback(value), 120);\n",
)
replace_once(
    'src/cloudflare-live-client.js',
    "    if (!desiredCall || !value || serverAudioThisTurn || deviceSpeaking) return false;\n",
    "    if (!(desiredCall || typedVoiceOutput) || !value || serverAudioThisTurn || deviceSpeaking) return false;\n",
)
replace_once(
    'src/cloudflare-live-client.js',
    "  async function playNext() {\n",
    "  async function ensurePlaybackAudio() {\n    const AudioCtor = window.AudioContext || window.webkitAudioContext;\n    if (!AudioCtor) return false;\n    audioContext = audioContext || new AudioCtor({ sampleRate: 48000 });\n    if (audioContext.state !== 'running') await audioContext.resume().catch(() => {});\n    return audioContext.state === 'running';\n  }\n\n  async function playNext() {\n",
)
replace_once(
    'src/cloudflare-live-client.js',
    "  function queueAudio(buffer) {\n    if (!desiredCall) {\n      serverAudioThisTurn = true;\n      ttsFailedThisTurn = false;\n      return;\n    }\n    serverAudioThisTurn = true;\n    ttsFailedThisTurn = false;\n    if (deviceSpeaking || deviceUtterance) cancelDeviceSpeech(false);\n    playbackQueue.push(buffer);\n    playNext();\n  }\n",
    "  function queueAudio(buffer) {\n    if (!(desiredCall || typedVoiceOutput)) {\n      serverAudioThisTurn = true;\n      ttsFailedThisTurn = false;\n      return;\n    }\n    serverAudioThisTurn = true;\n    ttsFailedThisTurn = false;\n    if (deviceSpeaking || deviceUtterance) cancelDeviceSpeech(false);\n    playbackQueue.push(buffer);\n    void ensurePlaybackAudio().then(() => playNext());\n  }\n",
)
replace_once(
    'src/cloudflare-live-client.js',
    "        else if (serverStatus === 'speaking') setStatus(desiredCall ? 'AIが話しています。途中でそのまま割り込めます。' : '文字で回答しています…');\n",
    "        else if (serverStatus === 'speaking') setStatus((desiredCall || typedVoiceOutput) ? 'AIが話しています…' : '文字で回答しています…');\n",
)
replace_once(
    'src/cloudflare-live-client.js',
    "      if (data.type === 'search_status') {\n        if (data.phase === 'planning') setStatus('検索内容を組み立てています…');\n        else if (data.phase === 'searching') setStatus('複数の情報源を確認しています…');\n        else setStatus('検索結果を検証して答えています…');\n        return;\n      }\n",
    "      if (data.type === 'search_status') {\n        if (data.phase === 'planning') {\n          lastSearchWaitPhrase = '';\n          setStatus('検索内容を確認しています…');\n        } else if (data.phase === 'searching') {\n          const phrase = String(data.waitPhrase || '').trim();\n          setStatus(phrase || '複数の情報源を確認しています…');\n          if (phrase && phrase !== lastSearchWaitPhrase && (desiredCall || typedVoiceOutput)) {\n            lastSearchWaitPhrase = phrase;\n            setTimeout(() => speakJapaneseFallback(phrase), 20);\n          }\n        } else {\n          setStatus('検索結果を検証して答えています…');\n        }\n        return;\n      }\n",
)
replace_once(
    'src/cloudflare-live-client.js',
    "    input.value = '';\n    addMessage('user', value);\n    pendingText.push(value);\n    manualStop = false;\n    connectSocket();\n    flushText();\n    setStatus(desiredCall ? '考えています…' : '発話として送信しました。文字で回答します…');\n",
    "    input.value = '';\n    stopPlayback(true);\n    typedVoiceOutput = true;\n    serverAudioThisTurn = false;\n    ttsFailedThisTurn = false;\n    lastSearchWaitPhrase = '';\n    void ensurePlaybackAudio();\n    addMessage('user', value);\n    pendingText.push(value);\n    manualStop = false;\n    connectSocket();\n    flushText();\n    setStatus('発話として送信しました。音声と文字で返答します…');\n",
)

# Server: every turn is self-contained. Search progress is a dedicated event, not answer text.
replace_once('src/worker-v14.js', "const VOICE_REVISION = 'cloudflare-live-v18.1';\n", "const VOICE_REVISION = 'cloudflare-live-v18.2';\n")
replace_once(
    'src/worker-v14.js',
    '直前の会話で共有された話題・人物・対象・ユーザーの立場を自然に引き継ぎ、「それ」「さっきの件」のような参照を文脈から扱ってください。\n',
    '以前の発話内容は参照せず、今回の発話だけを独立した質問として扱ってください。省略されていて対象が特定できない場合は、過去会話から補わず短く確認してください。\n',
)
replace_once('src/worker-v14.js', '  historyLimit: 48,\n', '  historyLimit: 4,\n')
replace_once('src/worker-v14.js', '  maxMessageCount: 1200,\n', '  maxMessageCount: 240,\n')
replace_once('src/worker-v14.js', '      contextProvider: () => this.getConversationHistory(),\n', '      contextProvider: () => [],\n')
replace_once(
    'src/worker-v14.js',
    '        context.messages,\n        GROUNDED_SYSTEM_PROMPT,\n',
    '        [],\n        GROUNDED_SYSTEM_PROMPT,\n',
)
replace_once(
    'src/worker-v14.js',
    '      const fillerPromise = generateSearchFiller(self.env.AI, transcript, context.messages, context.signal);\n',
    '      const fillerPromise = generateSearchFiller(self.env.AI, transcript, [], context.signal);\n',
)
replace_once(
    'src/worker-v14.js',
    "          try { context.connection.send(JSON.stringify({ type: 'search_status', phase: 'searching', searched: true, waitPhrase: filler })); } catch {}\n          yield `${filler}\\n`;\n",
    "          try { context.connection.send(JSON.stringify({ type: 'search_status', phase: 'searching', searched: true, waitPhrase: filler })); } catch {}\n",
)
replace_once('src/worker-v14.js', '    if (shouldDeepSearch(transcript, context.messages)) return this.searchResponse(transcript, context);\n', '    if (shouldDeepSearch(transcript, [])) return this.searchResponse(transcript, context);\n')
replace_once(
    'src/worker-v14.js',
    "    const messages = [\n      { role: 'system', content: quality ? QUALITY_SYSTEM_PROMPT : CASUAL_SYSTEM_PROMPT },\n      ...context.messages.slice(-(quality ? 18 : 16)).map((item) => ({ role: item.role, content: item.content })),\n      { role: 'user', content: transcript },\n    ];\n",
    "    const messages = [\n      { role: 'system', content: quality ? QUALITY_SYSTEM_PROMPT : CASUAL_SYSTEM_PROMPT },\n      { role: 'user', content: transcript },\n    ];\n",
)
replace_once('src/worker-v14.js', "        conversationPersistence: 'durable-object-sqlite',\n", "        conversationPersistence: 'isolated-page-session-no-context',\n")
replace_once(
    'src/worker-v14.js',
    '        sharedTypedAndVoiceHistory: true,\n',
    '        sharedTypedAndVoiceHistory: false,\n        crossTurnContext: false,\n        crossSessionContext: false,\n',
)
replace_once(
    'src/worker-v14.js',
    '        typedSpeechSilentWhenNotInCall: true,\n',
    '        typedSpeechSilentWhenNotInCall: false,\n        typedSpeechVoiceOutput: true,\n',
)

# Production verifier follows the new revision.
replace_once('.github/workflows/deploy.yml', '      EXPECTED_VOICE_REVISION: cloudflare-live-v18.1\n', '      EXPECTED_VOICE_REVISION: cloudflare-live-v18.2\n')

# Regression contracts.
replace_once('tests/voice-llm-contract.test.mjs', "/VOICE_REVISION = 'cloudflare-live-v18\\.1'/", "/VOICE_REVISION = 'cloudflare-live-v18\\.2'/")
old = """test('context-dependent follow-ups are reconstructed and routed to verified search', () => {\n  assert.match(search, /function\\s+looksContextDependentFollowup/);\n  assert.match(orchestrator, /function shouldDeepSearch|export function shouldDeepSearch/);\n  assert.match(orchestrator, /looksContextDependentFollowup\\(current\\)/);\n  assert.match(orchestrator, /heuristicContextQuery/);\n  assert.match(orchestrator, /直前のuser\\/assistant会話から対象だけ復元/);\n  assert.match(worker, /shouldDeepSearch\\(transcript, context\\.messages\\)/);\n  assert.match(worker, /answerWithVerifiedWebSearch/);\n});\n"""
new = """test('each turn is self-contained and prior conversation cannot trigger search', () => {\n  assert.match(worker, /contextProvider: \\(\\) => \\[\\]/);\n  assert.match(worker, /shouldDeepSearch\\(transcript, \\[\\]\\)/);\n  assert.match(worker, /answerWithVerifiedWebSearch[\\s\\S]*?transcript,[\\s\\n]*\\[\\]/);\n  assert.doesNotMatch(worker, /context\\.messages\\.slice/);\n  assert.match(liveClient, /crypto\\.randomUUID/);\n  assert.match(worker, /crossTurnContext: false/);\n  assert.match(worker, /crossSessionContext: false/);\n});\n"""
replace_once('tests/voice-llm-contract.test.mjs', old, new)
old = """test('search progress is spoken by the lightweight model while high-accuracy retrieval runs', () => {\n  assert.match(orchestrator, /SEARCH_FILLER_MODEL = LIVE_VOICE_MODEL/);\n  assert.match(orchestrator, /SEARCH_FILLER_MIN_DELAY_MS = 650/);\n  assert.match(orchestrator, /今、\\$\\{topic\\}について検索しています。少しお待ちください。/);\n  assert.match(orchestrator, /ai\\?\\.run/);\n  assert.match(worker, /const fillerPromise = generateSearchFiller/);\n  assert.match(worker, /searchFillerGeneratedInParallel: true/);\n});\n\ntest('typed text can simulate speech without auto-starting or playing audio', () => {\n  assert.match(index, /話したことにする/);\n  assert.match(index, /文字入力は「話したこと」として会話履歴に入ります/);\n  assert.match(liveClient, /type: 'text_message'/);\n  assert.match(liveClient, /if \\(!desiredCall\\) \\{/);\n  assert.doesNotMatch(liveClient, /setTimeout\\(\\(\\) => startCall\\(true\\)/);\n});\n"""
new = """test('search progress is a one-shot spoken status and is not duplicated into the answer transcript', () => {\n  assert.match(orchestrator, /SEARCH_FILLER_MODEL = LIVE_VOICE_MODEL/);\n  assert.match(orchestrator, /SEARCH_FILLER_MIN_DELAY_MS = 650/);\n  assert.match(worker, /waitPhrase: filler/);\n  assert.doesNotMatch(worker, /yield `\\$\\{filler\\}\\\\n`/);\n  assert.match(liveClient, /lastSearchWaitPhrase/);\n  assert.match(liveClient, /speakJapaneseFallback\\(phrase\\)/);\n});\n\ntest('typed text simulates speech and plays the reply without opening the microphone', () => {\n  assert.match(index, /話したことにする/);\n  assert.match(index, /返事は文字と音声で再生します/);\n  assert.match(liveClient, /typedVoiceOutput = true/);\n  assert.match(liveClient, /ensurePlaybackAudio/);\n  assert.match(liveClient, /desiredCall \\|\\| typedVoiceOutput/);\n  assert.doesNotMatch(liveClient, /setTimeout\\(\\(\\) => startCall\\(true\\)/);\n});\n"""
replace_once('tests/voice-llm-contract.test.mjs', old, new)
replace_once(
    'tests/voice-llm-contract.test.mjs',
    "  assert.match(worker, /screenOverlay: false/);\n});\n",
    "  assert.match(worker, /screenOverlay: false/);\n  assert.match(worker, /crossTurnContext: false/);\n  assert.match(worker, /typedSpeechVoiceOutput: true/);\n});\n",
)

replace_once('tests/gemini-live-contract.test.mjs', "/VOICE_REVISION = 'cloudflare-live-v18\\.1'/", "/VOICE_REVISION = 'cloudflare-live-v18\\.2'/")
replace_once('tests/gemini-live-contract.test.mjs', '  assert.match(workerSource, /historyLimit: 48/);\n', '  assert.match(workerSource, /historyLimit: 4/);\n')
replace_once('tests/gemini-live-contract.test.mjs', '/shouldDeepSearch\\(transcript, context\\.messages\\)/', '/shouldDeepSearch\\(transcript, \\[\\]\\)/')
old = """test('typed speech simulation is silent outside an active call and call startup is manual', () => {\n  assert.match(indexSource, /話したことにする/);\n  assert.match(indexSource, /文字入力は「話したこと」として会話履歴に入ります/);\n  assert.match(CLOUDFLARE_LIVE_CLIENT, /type: 'text_message'/);\n  assert.match(CLOUDFLARE_LIVE_CLIENT, /CALL_CONNECT_TIMEOUT_MS = 10000/);\n  assert.match(CLOUDFLARE_LIVE_CLIENT, /接続が完了しませんでした/);\n  assert.doesNotMatch(CLOUDFLARE_LIVE_CLIENT, /setTimeout\\(\\(\\) => startCall\\(true\\)/);\n  assert.match(workerSource, /typedSpeechSimulation: true/);\n  assert.match(workerSource, /typedSpeechSilentWhenNotInCall: true/);\n});\n"""
new = """test('typed speech simulation has audible replies without automatic microphone startup', () => {\n  assert.match(indexSource, /話したことにする/);\n  assert.match(indexSource, /返事は文字と音声で再生します/);\n  assert.match(CLOUDFLARE_LIVE_CLIENT, /typedVoiceOutput = true/);\n  assert.match(CLOUDFLARE_LIVE_CLIENT, /ensurePlaybackAudio/);\n  assert.match(CLOUDFLARE_LIVE_CLIENT, /CALL_CONNECT_TIMEOUT_MS = 10000/);\n  assert.doesNotMatch(CLOUDFLARE_LIVE_CLIENT, /setTimeout\\(\\(\\) => startCall\\(true\\)/);\n  assert.match(workerSource, /typedSpeechSimulation: true/);\n  assert.match(workerSource, /typedSpeechSilentWhenNotInCall: false/);\n  assert.match(workerSource, /typedSpeechVoiceOutput: true/);\n});\n"""
replace_once('tests/gemini-live-contract.test.mjs', old, new)
old = """test('same durable voice agent keeps the conversation context across the call', () => {\n  assert.match(CLOUDFLARE_LIVE_CLIENT, /AGENT_PATH = '\\/agents\\/talk-sys-voice-agent\\/default'/);\n  assert.match(CLOUDFLARE_LIVE_CLIENT, /text_message/);\n  assert.match(workerSource, /sharedTypedAndVoiceHistory: true/);\n});"""
new = """test('browser sessions are isolated and no prior conversation is reused', () => {\n  assert.match(CLOUDFLARE_LIVE_CLIENT, /crypto\\.randomUUID/);\n  assert.match(CLOUDFLARE_LIVE_CLIENT, /talk-sys-voice-agent\\/' \\+ AGENT_ID/);\n  assert.match(CLOUDFLARE_LIVE_CLIENT, /text_message/);\n  assert.match(workerSource, /sharedTypedAndVoiceHistory: false/);\n  assert.match(workerSource, /contextProvider: \\(\\) => \\[\\]/);\n  assert.doesNotMatch(workerSource, /context\\.messages\\.slice/);\n});"""
replace_once('tests/gemini-live-contract.test.mjs', old, new)

replace_once(
    'tests/worker.test.mjs',
    '  assert.match(html, /文字入力は「話したこと」として会話履歴に入ります/);\n',
    '  assert.match(html, /返事は文字と音声で再生します/);\n  assert.match(html, /以前の質問内容は次の質問へ引き継ぎません/);\n',
)

print('v18.2 patch applied')

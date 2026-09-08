from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f'expected snippet missing in {path}: {old[:100]!r}')
    p.write_text(text.replace(old, new, 1))


# Visible typed-as-spoken input for silent/outdoor testing.
replace_once(
    'src/index.js',
    '    .composer{display:none}\n',
    '    .text-note{padding:10px 18px 0;color:#71717a;font-size:12px;line-height:1.5}\n'
    '    .composer{padding:10px 18px 18px;display:flex;gap:8px;border-top:0;background:#fff}\n'
    '    .composer textarea{flex:1;min-width:0;resize:vertical;min-height:48px;max-height:140px;padding:11px 12px;border:1px solid #d4d4d8;border-radius:12px;font:inherit;line-height:1.45}\n'
    '    .composer button{border:0;border-radius:12px;background:#18181b;color:#fff;padding:0 15px;font-weight:800;cursor:pointer;white-space:nowrap}\n',
)
replace_once(
    'src/index.js',
    '    <section id="chat" class="chat" aria-live="polite"><div class="msg assistant">通話ボタンを押して、そのまま話してください。</div></section>\n    <div id="status" class="status"></div>\n    <form id="form" class="composer" aria-hidden="true"><textarea id="input" rows="1"></textarea><button id="send" type="submit">送信</button></form>\n',
    '    <section id="chat" class="chat" aria-live="polite"><div class="msg assistant">通話ボタンを押して話せます。外で話せないときは、下の文字入力を発話として同じ会話に送れます。</div></section>\n    <div id="status" class="status"></div>\n    <div class="text-note">文字入力は「話したこと」として会話履歴に入ります。通話していない間はAI音声を再生しません。</div>\n    <form id="form" class="composer"><textarea id="input" rows="2" aria-label="発話テスト入力" placeholder="ここに入力すると、話したこととして送信します"></textarea><button id="send" type="submit">話したことにする</button></form>\n',
)

# Browser client: no auto-call, text-only mode stays silent, connection cannot stick forever.
replace_once(
    'src/cloudflare-live-client.js',
    '  const DEVICE_TTS_GUARD_MS = 350;\n',
    '  const DEVICE_TTS_GUARD_MS = 350;\n  const CALL_CONNECT_TIMEOUT_MS = 10000;\n',
)
replace_once(
    'src/cloudflare-live-client.js',
    "  if (!originalVoice || !form || !input || !chat || !navigator.mediaDevices?.getUserMedia) return;\n",
    "  if (!originalVoice || !form || !input || !chat) return;\n",
)
replace_once(
    'src/cloudflare-live-client.js',
    '  let reconnectTimer = null;\n',
    '  let reconnectTimer = null;\n  let callConnectTimer = null;\n',
)
replace_once(
    'src/cloudflare-live-client.js',
    '    if (ttsFailedThisTurn && !serverAudioThisTurn && value) setTimeout(() => speakJapaneseFallback(value), 120);\n',
    '    if (desiredCall && ttsFailedThisTurn && !serverAudioThisTurn && value) setTimeout(() => speakJapaneseFallback(value), 120);\n',
)
replace_once(
    'src/cloudflare-live-client.js',
    '    if (!value || serverAudioThisTurn || deviceSpeaking) return false;\n',
    '    if (!desiredCall || !value || serverAudioThisTurn || deviceSpeaking) return false;\n',
)
replace_once(
    'src/cloudflare-live-client.js',
    '  function queueAudio(buffer) {\n    serverAudioThisTurn = true;\n',
    '  function queueAudio(buffer) {\n    if (!desiredCall) {\n      serverAudioThisTurn = true;\n      ttsFailedThisTurn = false;\n      return;\n    }\n    serverAudioThisTurn = true;\n',
)
replace_once(
    'src/cloudflare-live-client.js',
    '  async function ensureAudio() {\n    if (micReady && mediaStream && audioContext) {\n',
    "  async function ensureAudio() {\n    if (!navigator.mediaDevices?.getUserMedia) {\n      const error = new Error('microphone API unavailable');\n      error.name = 'NotSupportedError';\n      throw error;\n    }\n    if (micReady && mediaStream && audioContext) {\n",
)
replace_once(
    'src/cloudflare-live-client.js',
    "  function maybeStartCall() {\n    if (!desiredCall || !welcomed || !micReady || inCall) return;\n    sendJson({ type: 'start_call', preferred_format: 'mp3' });\n  }\n",
    "  function clearCallConnectTimeout() {\n    if (!callConnectTimer) return;\n    clearTimeout(callConnectTimer);\n    callConnectTimer = null;\n  }\n\n  function armCallConnectTimeout() {\n    clearCallConnectTimeout();\n    callConnectTimer = setTimeout(() => {\n      callConnectTimer = null;\n      if (!desiredCall || inCall) return;\n      manualStop = true;\n      desiredCall = false;\n      inCall = false;\n      mediaStream?.getTracks().forEach((track) => track.stop());\n      mediaStream = null;\n      micReady = false;\n      try { mediaSource?.disconnect(); } catch {}\n      try { workletNode?.disconnect(); } catch {}\n      mediaSource = null;\n      workletNode = null;\n      setVoiceUi();\n      setStatus('接続が完了しませんでした。通信状態を確認して、もう一度通話ボタンを押してください。');\n    }, CALL_CONNECT_TIMEOUT_MS);\n  }\n\n  function maybeStartCall() {\n    if (!desiredCall || !welcomed || !micReady || inCall) return;\n    sendJson({ type: 'start_call', preferred_format: 'mp3' });\n  }\n",
)
replace_once(
    'src/cloudflare-live-client.js',
    "        if (serverStatus === 'listening') {\n          if (desiredCall) inCall = true;\n",
    "        if (serverStatus === 'listening') {\n          if (desiredCall) {\n            inCall = true;\n            clearCallConnectTimeout();\n          }\n",
)
replace_once(
    'src/cloudflare-live-client.js',
    '  async function startCall(auto = false) {\n',
    '  async function startCall() {\n',
)
replace_once(
    'src/cloudflare-live-client.js',
    "      await ensureAudio();\n      connectSocket();\n      maybeStartCall();\n      if (audioContext?.state !== 'running' && auto) {\n        desiredCall = false;\n        setVoiceUi();\n        setStatus('通話を始めるには「リアルタイム通話」を一度押してください。');\n      }\n",
    '      await ensureAudio();\n      armCallConnectTimeout();\n      connectSocket();\n      maybeStartCall();\n',
)
replace_once(
    'src/cloudflare-live-client.js',
    '    } catch (error) {\n      desiredCall = false;\n',
    '    } catch (error) {\n      clearCallConnectTimeout();\n      desiredCall = false;\n',
)
replace_once(
    'src/cloudflare-live-client.js',
    '  function endCall() {\n    manualStop = true;\n',
    '  function endCall() {\n    clearCallConnectTimeout();\n    manualStop = true;\n',
)
replace_once(
    'src/cloudflare-live-client.js',
    "    setStatus('考えています…');\n",
    "    setStatus(desiredCall ? '考えています…' : '発話として送信しました。文字で回答します…');\n",
)
replace_once(
    'src/cloudflare-live-client.js',
    "  voice.addEventListener('click', () => desiredCall ? endCall() : startCall(false));\n",
    "  voice.addEventListener('click', () => desiredCall ? endCall() : startCall());\n",
)
replace_once(
    'src/cloudflare-live-client.js',
    '  setVoiceUi();\n  connectSocket();\n  setTimeout(() => startCall(true), 180);\n',
    "  setVoiceUi();\n  connectSocket();\n  setStatus('通話するか、文字で発話テストできます。');\n",
)

# Lightweight progress announcer runs in parallel with high-accuracy research.
replace_once(
    'src/search-orchestrator.js',
    "import { GROUNDING_VOICE_MODEL, GROUNDING_FALLBACK_MODEL } from './streaming-workers-ai.js';\n",
    "import { LIVE_VOICE_MODEL, GROUNDING_VOICE_MODEL, GROUNDING_FALLBACK_MODEL } from './streaming-workers-ai.js';\n",
)
replace_once(
    'src/search-orchestrator.js',
    "export const SEARCH_FILLER_MODEL = 'deterministic-safe-filler';\nexport const SEARCH_MAX_QUERIES = 8;\nexport const SEARCH_MAX_ROUNDS = 2;\nexport const SEARCH_FILLER_MIN_DELAY_MS = 1200;\n",
    "export const SEARCH_FILLER_MODEL = LIVE_VOICE_MODEL;\nexport const SEARCH_MAX_QUERIES = 8;\nexport const SEARCH_MAX_ROUNDS = 2;\nexport const SEARCH_FILLER_MIN_DELAY_MS = 650;\n",
)
old_tail = """function sanitizeFiller(value) {
  const text = String(value || '').replace(/[\\r\\n]+/g, ' ').replace(/\\s+/g, ' ').trim();
  const allowed = [
    '確認します。少し時間かかります。',
    '詳しく確認します。少し待ってください。',
    '検索をかけます。少し待ってください。',
  ];
  return allowed.includes(text) ? text : '';
}

function wait(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error('aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('aborted'));
    }, { once: true });
  });
}

export async function generateSearchFiller(_ai, _transcript, _history, signal) {
  await wait(SEARCH_FILLER_MIN_DELAY_MS, signal).catch(() => {});
  return '詳しく確認します。少し待ってください。';
}
"""
new_tail = """function sanitizeProgressTopic(value) {
  return String(value || '')
    .replace(/[\\r\\n\\t]+/g, ' ')
    .replace(/[「」『』\"']/g, '')
    .replace(/^(?:検索対象|トピック|topic)[:：]\\s*/i, '')
    .replace(/(?:について)?検索(?:しています|中です)?[。！!]?$/u, '')
    .replace(/\\s+/g, ' ')
    .trim()
    .slice(0, 52);
}

function fallbackProgressTopic(transcript, history) {
  const current = cleanQuery(transcript);
  const contextual = heuristicContextQuery(transcript, history);
  const source = looksContextDependentFollowup(current) ? contextual : current;
  return sanitizeProgressTopic(source || current || 'ご相談の内容') || 'ご相談の内容';
}

function sanitizeFiller(value) {
  const text = String(value || '').replace(/[\\r\\n]+/g, ' ').replace(/\\s+/g, ' ').trim();
  if (/^今、.{2,52}について検索しています。少しお待ちください。$/u.test(text)) return text;
  const allowed = [
    '確認します。少し時間かかります。',
    '詳しく確認します。少し待ってください。',
    '検索をかけます。少し待ってください。',
  ];
  return allowed.includes(text) ? text : '';
}

function wait(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error('aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('aborted'));
    }, { once: true });
  });
}

export async function generateSearchFiller(ai, transcript, history, signal) {
  const fallback = fallbackProgressTopic(transcript, history);
  const recent = recentConversation(history, 8);
  const modelPromise = ai?.run
    ? ai.run(SEARCH_FILLER_MODEL, {
        messages: [
          {
            role: 'system',
            content: '検索本体は別の高精度モデルが実行中です。あなたは待ち時間の短い案内だけ担当します。直前の会話と今回の発話から、今検索している対象を日本語で12〜32文字程度に要約してください。回答・推測・店名の新規生成は禁止。検索対象の短い名詞句だけを返してください。',
          },
          {
            role: 'user',
            content: `直近の会話:\\n${recent || '(なし)'}\\n\\n今回の発話:\\n${String(transcript || '').slice(0, 800)}`,
          },
        ],
        max_completion_tokens: 64,
        temperature: 0,
        reasoning_effort: null,
        chat_template_kwargs: { enable_thinking: false, clear_thinking: true },
      }, signal ? { signal } : undefined).catch(() => null)
    : Promise.resolve(null);

  const [result] = await Promise.all([
    modelPromise,
    wait(SEARCH_FILLER_MIN_DELAY_MS, signal).catch(() => null),
  ]);
  const topic = sanitizeProgressTopic(extractText(result)) || fallback;
  const phrase = `今、${topic}について検索しています。少しお待ちください。`;
  return sanitizeFiller(phrase) || `今、${fallback.slice(0, 52)}について検索しています。少しお待ちください。`;
}
"""
replace_once('src/search-orchestrator.js', old_tail, new_tail)

# Revision/health contract.
replace_once(
    'src/worker-v14.js',
    "const VOICE_REVISION = 'cloudflare-live-v18.0';\n",
    "const VOICE_REVISION = 'cloudflare-live-v18.1';\n",
)
replace_once(
    'src/worker-v14.js',
    '        searchFillerGeneratedInParallel: false,\n',
    '        searchFillerGeneratedInParallel: true,\n        typedSpeechSimulation: true,\n        typedSpeechSilentWhenNotInCall: true,\n        callConnectTimeoutMs: 10000,\n',
)

# Contract tests.
replace_once(
    'tests/voice-llm-contract.test.mjs',
    "  assert.match(worker, /VOICE_REVISION = 'cloudflare-live-v18\\.0'/);\n",
    "  assert.match(worker, /VOICE_REVISION = 'cloudflare-live-v18\\.1'/);\n",
)
old_test = """test('search wait speech is deterministic and cannot hallucinate an answer while retrieval runs', () => {
  assert.match(orchestrator, /SEARCH_FILLER_MODEL = 'deterministic-safe-filler'/);
  assert.match(orchestrator, /SEARCH_FILLER_MIN_DELAY_MS = 1200/);
  assert.match(orchestrator, /詳しく確認します。少し待ってください。/);
  assert.doesNotMatch(orchestrator, /ai\\.run\\(SEARCH_FILLER_MODEL/);
  assert.match(worker, /const fillerPromise = generateSearchFiller/);
});
"""
new_test = """test('search progress is spoken by the lightweight model while high-accuracy retrieval runs', () => {
  assert.match(orchestrator, /SEARCH_FILLER_MODEL = LIVE_VOICE_MODEL/);
  assert.match(orchestrator, /SEARCH_FILLER_MIN_DELAY_MS = 650/);
  assert.match(orchestrator, /今、\\$\\{topic\\}について検索しています。少しお待ちください。/);
  assert.match(orchestrator, /ai\\?\\.run/);
  assert.match(worker, /const fillerPromise = generateSearchFiller/);
  assert.match(worker, /searchFillerGeneratedInParallel: true/);
});

test('typed text can simulate speech without auto-starting or playing audio', () => {
  assert.match(index, /話したことにする/);
  assert.match(index, /文字入力は「話したこと」として会話履歴に入ります/);
  assert.match(liveClient, /type: 'text_message'/);
  assert.match(liveClient, /if \\(!desiredCall\\) \\{/);
  assert.doesNotMatch(liveClient, /setTimeout\\(\\(\\) => startCall\\(true\\)/);
});

test('call connection has a hard timeout and cannot stay stuck on connecting', () => {
  assert.match(liveClient, /CALL_CONNECT_TIMEOUT_MS = 10000/);
  assert.match(liveClient, /armCallConnectTimeout/);
  assert.match(liveClient, /clearCallConnectTimeout/);
  assert.match(liveClient, /接続が完了しませんでした/);
  assert.match(worker, /callConnectTimeoutMs: 10000/);
});
"""
replace_once('tests/voice-llm-contract.test.mjs', old_test, new_test)

old_orch_test = """test('search uses two-pass research budget and deterministic filler, not a free-writing model', async () => {
  assert.equal(SEARCH_MAX_ROUNDS, 2);
  assert.equal(SEARCH_FILLER_MODEL, 'deterministic-safe-filler');
  const ai = { async run() { throw new Error('filler must not invoke AI'); } };
  const started = Date.now();
  const filler = await generateSearchFiller(ai, '今いくら？', []);
  assert.equal(filler, '詳しく確認します。少し待ってください。');
  assert.ok(Date.now() - started >= SEARCH_FILLER_MIN_DELAY_MS - 50);
});
"""
new_orch_test = """test('search uses two-pass research budget and lightweight contextual progress speech', async () => {
  assert.equal(SEARCH_MAX_ROUNDS, 2);
  let called = false;
  const ai = {
    async run(model) {
      called = true;
      assert.equal(model, SEARCH_FILLER_MODEL);
      return { response: '3万円前後のノートパソコン購入先' };
    },
  };
  const started = Date.now();
  const filler = await generateSearchFiller(ai, 'どこで買うのがいい？', [
    { role: 'user', content: '3万円くらいのノートパソコンを探している' },
  ]);
  assert.equal(called, true);
  assert.match(filler, /^今、.+について検索しています。少しお待ちください。$/);
  assert.match(filler, /ノートパソコン/);
  assert.ok(Date.now() - started >= SEARCH_FILLER_MIN_DELAY_MS - 50);
});
"""
replace_once('tests/search-orchestrator.test.mjs', old_orch_test, new_orch_test)
replace_once(
    'tests/search-orchestrator.test.mjs',
    "  assert.equal(sanitizeFiller('詳しく確認します。少し待ってください。'), '詳しく確認します。少し待ってください。');\n",
    "  assert.equal(sanitizeFiller('詳しく確認します。少し待ってください。'), '詳しく確認します。少し待ってください。');\n  assert.equal(sanitizeFiller('今、3万円のノートパソコンについて検索しています。少しお待ちください。'), '今、3万円のノートパソコンについて検索しています。少しお待ちください。');\n",
)
replace_once(
    'tests/worker.test.mjs',
    '  assert.match(html, /検索は精度優先/);\n',
    '  assert.match(html, /検索は精度優先/);\n  assert.match(html, /話したことにする/);\n  assert.match(html, /文字入力は「話したこと」として会話履歴に入ります/);\n',
)

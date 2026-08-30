const WORKER_URL = String(process.env.WORKER_URL || '').replace(/\/$/, '');
if (!WORKER_URL) throw new Error('WORKER_URL is required');

const CONVERSATION_MODEL = 'gemini-3.1-flash-live-preview';
const TRANSCRIBE_MODEL = 'gemini-3.5-transcribe-live';
const CUSTOM_VOCABULARY = ['TalkSys','Gemini','Google Search','Cloudflare','GitHub','Windows','Wi-Fi','HIFU','WebSocket','STT','TTS'];

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function token(purpose = 'conversation') {
  const response = await fetch(WORKER_URL + '/api/gemini-live-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ purpose }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.available || !body.token) {
    throw new Error(`token(${purpose}) ${response.status}: ${JSON.stringify(body)}`);
  }
  const expected = purpose === 'transcription' ? TRANSCRIBE_MODEL : CONVERSATION_MODEL;
  if (body.model !== expected) throw new Error(`token model mismatch ${body.model} != ${expected}`);
  return body;
}

function conversationSetup({ handle = '', system = '' } = {}) {
  return {
    setup: {
      model: 'models/' + CONVERSATION_MODEL,
      generationConfig: {
        responseModalities: ['AUDIO'],
        temperature: 0.2,
        topP: 0.9,
        thinkingConfig: { thinkingLevel: 'LOW' },
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
      },
      systemInstruction: { parts: [{ text: system || '自然な日本語で短く正確に答えてください。検証可能な外部事実はGoogle Searchで確認してください。検索する場合は検索前に必ず「ちょっと調べますね。」と発話してください。' }] },
      tools: [{ googleSearch: {} }],
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
          endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
          prefixPaddingMs: 180,
          silenceDurationMs: 800,
        },
        activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
        turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY',
      },
      sessionResumption: handle ? { handle } : {},
      contextWindowCompression: { triggerTokens: '90000', slidingWindow: { targetTokens: '52000' } },
      inputAudioTranscription: { languageCodes: ['ja-JP'], customVocabulary: CUSTOM_VOCABULARY, mode: 'SMART' },
      outputAudioTranscription: {},
    },
  };
}

function transcribeSetup() {
  return {
    setup: {
      model: 'models/' + TRANSCRIBE_MODEL,
      generationConfig: { responseModalities: ['TEXT'] },
      inputAudioTranscription: { languageCodes: ['ja-JP'], customVocabulary: CUSTOM_VOCABULARY, mode: 'SMART' },
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
          endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
          prefixPaddingMs: 180,
          silenceDurationMs: 800,
        },
        turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY',
      },
    },
  };
}

async function openSession(purpose, setup, timeoutMs = 12000) {
  const t = await token(purpose);
  const ws = new WebSocket(t.endpoint + '?access_token=' + encodeURIComponent(t.token));
  const state = {
    ws,
    setup: false,
    output: '',
    input: '',
    interimInput: '',
    grounding: false,
    groundingCount: 0,
    audio: [],
    turnSeq: 0,
    handle: '',
    messages: [],
    closed: false,
  };

  await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${purpose} setup timeout`));
    }, timeoutMs);
    ws.addEventListener('open', () => ws.send(JSON.stringify(setup)));
    ws.addEventListener('message', (event) => {
      let m; try { m = JSON.parse(event.data); } catch { return; }
      state.messages.push(m);
      if (m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) state.handle = m.sessionResumptionUpdate.newHandle;
      if (m.setupComplete && !settled) {
        state.setup = true;
        settled = true;
        clearTimeout(timer);
        resolve();
      }
      ingest(state, m);
    });
    ws.addEventListener('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`${purpose} websocket error`));
      }
    });
    ws.addEventListener('close', (event) => {
      state.closed = true;
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`${purpose} closed before setup ${event.code} ${event.reason}`));
      }
    });
  });
  return state;
}

function ingest(state, m) {
  const c = m.serverContent;
  if (!c) return;
  if (c.inputTranscription?.text) state.input += String(c.inputTranscription.text);
  if (c.interimInputTranscription?.text) state.interimInput = String(c.interimInputTranscription.text);
  if (c.outputTranscription?.text) state.output += String(c.outputTranscription.text);
  const chunks = c.groundingMetadata?.groundingChunks || [];
  if (chunks.length) {
    state.grounding = true;
    state.groundingCount += chunks.length;
  }
  for (const part of c.modelTurn?.parts || []) {
    const inline = part.inlineData;
    if (inline?.data && /audio\/pcm/i.test(inline.mimeType || 'audio/pcm')) {
      state.audio.push({ data: inline.data, mimeType: inline.mimeType || 'audio/pcm;rate=24000' });
    }
  }
  if (c.turnComplete) state.turnSeq += 1;
}

function resetTurn(state) {
  state.output = '';
  state.input = '';
  state.interimInput = '';
  state.grounding = false;
  state.groundingCount = 0;
  state.audio = [];
}

async function waitFor(predicate, label, timeoutMs = 30000, stepMs = 40) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return;
    await delay(stepMs);
  }
  throw new Error(`${label} timeout`);
}

async function textTurn(state, text, timeoutMs = 30000) {
  resetTurn(state);
  const targetSeq = state.turnSeq + 1;
  state.ws.send(JSON.stringify({ realtimeInput: { text } }));
  await waitFor(() => state.turnSeq >= targetSeq || state.closed, `turn: ${text}`, timeoutMs);
  if (state.closed) throw new Error(`session closed during turn: ${text}`);
  await delay(650); // output/transcription events can arrive independently of turnComplete.
  return {
    output: state.output.trim(),
    grounding: state.grounding,
    groundingCount: state.groundingCount,
    audio: [...state.audio],
    handle: state.handle,
  };
}

function close(state, reason = 'done') {
  try { state.ws.close(1000, reason); } catch {}
}

async function verifyHealthAndAssets() {
  const response = await fetch(WORKER_URL + '/voice-health?ts=' + Date.now());
  if (!response.ok) throw new Error('voice-health ' + response.status);
  const h = await response.json();
  const required = [
    h.ok,
    h.voiceRevision === 'gemini-live-v13.1',
    h.primary === 'gemini-live',
    h.geminiLiveConfigured === true,
    h.geminiLiveModel === CONVERSATION_MODEL,
    h.dedicatedTranscriptionModel === TRANSCRIBE_MODEL,
    h.parallelHighAccuracyTranscription === true,
    h.googleSearchGrounding === true,
    h.typedChatTransport === 'realtimeInput.text',
  ];
  if (required.some((x) => !x)) throw new Error('voice-health contract failed: ' + JSON.stringify(h));
  const js = await (await fetch(WORKER_URL + '/gemini-live.js?ts=' + Date.now())).text();
  const transcribe = await (await fetch(WORKER_URL + '/gemini-transcribe.js?ts=' + Date.now())).text();
  for (const [name, source] of [['conversation', js], ['transcription', transcribe]]) {
    if (!source.includes('ja-JP') || !source.includes('audioStreamEnd')) throw new Error(`${name} asset missing Japanese/VAD contract`);
  }
  console.log(JSON.stringify({ phase: 'health', revision: h.voiceRevision, conversation: h.geminiLiveModel, transcription: h.dedicatedTranscriptionModel }));
}

async function verifyBasicNativeAudio() {
  const state = await openSession('conversation', conversationSetup({ system: '自然な日本語で答えてください。質問への直接回答と短い補足をしてください。' }));
  try {
    const r = await textTurn(state, '日本語で、1足す1はいくつですか。理由を一言だけ添えてください。');
    if (!r.output || !state.audio.length) throw new Error('native audio/basic output missing');
    if (!/[2２二]/.test(r.output)) throw new Error('unexpected basic answer: ' + r.output);
    console.log(JSON.stringify({ phase: 'basic', output: r.output, audioChunks: state.audio.length }));
  } finally { close(state); }
}

async function verifySearchAndWaitPhrase() {
  const state = await openSession('conversation', conversationSetup({
    system: '現在情報や外部事実はGoogle Searchで確認してください。検索すると決めたら、検索を始める前に必ず「ちょっと調べますね。」と発話し、その後に検索結果から答えてください。検索せずに現在情報を断定してはいけません。'
  }));
  try {
    const r = await textTurn(state, '現在の日本の内閣総理大臣は誰ですか。Google検索で確認して、根拠に基づいて答えてください。', 40000);
    if (!r.output) throw new Error('search output empty');
    if (!r.grounding) throw new Error('Google Search grounding metadata missing: ' + r.output);
    if (!/調べます/.test(r.output)) throw new Error('spoken search wait phrase missing: ' + r.output);
    console.log(JSON.stringify({ phase: 'search', grounded: r.grounding, groundingCount: r.groundingCount, output: r.output }));
  } finally { close(state); }
}

async function verifyJapaneseTranscriptionWithGeneratedAudio() {
  const speaker = await openSession('conversation', conversationSetup({ system: '指定された日本語だけを余計な説明なしで、そのまま自然に読み上げてください。' }));
  let audio;
  try {
    const r = await textTurn(speaker, '次の一文だけを読み上げてください。「TalkSysで日本語音声認識を確認します。HIFUとWi-Fiをテストします。」');
    audio = r.audio;
    if (!audio.length) throw new Error('could not generate Japanese PCM for STT test');
  } finally { close(speaker); }

  const stt = await openSession('transcription', transcribeSetup());
  try {
    for (const chunk of audio) {
      stt.ws.send(JSON.stringify({ realtimeInput: { audio: { data: chunk.data, mimeType: chunk.mimeType } } }));
      await delay(8);
    }
    stt.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    await waitFor(() => Boolean(stt.input.trim()) || stt.closed, 'dedicated Japanese transcription', 25000);
    if (stt.closed && !stt.input.trim()) throw new Error('transcription session closed without transcript');
    await delay(350);
    const text = stt.input.trim();
    if (!/(TalkSys|日本語|音声認識)/i.test(text)) throw new Error('Japanese STT core phrase missing: ' + text);
    if (!/(HIFU|Wi.?Fi)/i.test(text)) throw new Error('Japanese STT custom vocabulary missing: ' + text);
    console.log(JSON.stringify({ phase: 'japanese-stt', transcript: text, audioChunks: audio.length }));
  } finally { close(stt); }
}

async function verifyEightTurnsAndResumption() {
  const initial = await openSession('conversation', conversationSetup({ system: '日本語で自然に会話し、会話内で明示された合言葉などの短期記憶を保持してください。' }));
  let handle = '';
  try {
    const turns = [
      'この会話の合言葉は「青い時計」です。覚えてください。',
      '今日は短い会話テストです。返事は一文で。',
      'では二往復目です。自然に返してください。',
      '三往復目です。まだ会話を続けます。',
      '四往復目です。返事をしてください。',
    ];
    for (const text of turns) {
      const r = await textTurn(initial, text, 25000);
      if (!r.output) throw new Error('empty reply before resumption: ' + text);
      handle = r.handle || handle;
    }
    await waitFor(() => Boolean(initial.handle), 'session resumption handle', 7000);
    handle = initial.handle;
    if (!handle) throw new Error('session resumption handle missing');
  } finally { close(initial, 'resumption-test'); }

  await delay(500);
  const resumed = await openSession('conversation', conversationSetup({ handle, system: '日本語で自然に会話し、再開前の会話文脈を維持してください。' }));
  try {
    for (const text of ['五往復目です。続いていますか。', '六往復目です。短く返してください。']) {
      const r = await textTurn(resumed, text, 25000);
      if (!r.output) throw new Error('empty reply after resumption: ' + text);
    }
    const final = await textTurn(resumed, '最初に伝えた合言葉は何でしたか。合言葉だけ答えてください。', 25000);
    if (!/青い時計/.test(final.output)) throw new Error('conversation memory lost after 8 turns/resumption: ' + final.output);
    console.log(JSON.stringify({ phase: 'eight-turn-resumption', remembered: true, output: final.output }));
  } finally { close(resumed); }
}

await verifyHealthAndAssets();
await verifyBasicNativeAudio();
await verifySearchAndWaitPhrase();
await verifyJapaneseTranscriptionWithGeneratedAudio();
await verifyEightTurnsAndResumption();
console.log(JSON.stringify({ ok: true, worker: WORKER_URL, verified: ['native-audio','google-search','spoken-search-wait','japanese-transcription','eight-turn-resumption'] }));
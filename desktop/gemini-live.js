'use strict';

(() => {
  const MODEL = 'gemini-3.1-flash-live-preview';
  const INPUT_RATE = 16000;
  const DEFAULT_OUTPUT_RATE = 24000;
  const CHUNK_MS = 40;
  const LOCAL_END_SILENCE_MS = 560;
  const PRE_ROLL_FRAMES = 8;
  const ECHO_BARGE_THRESHOLD = 0.052;
  const ECHO_BARGE_FRAMES = 4;
  const HANDLE_KEY = 'talksys.desktop.gemini.handle.v13';
  const SESSION_ROTATE_MS = 12 * 60 * 1000;

  const CUSTOM_VOCABULARY = [
    'TalkSys','Gemini','Gemini Live','Google Search','Cloudflare','Workers','GitHub','Windows','Android','iPhone','Linux',
    'CPU','GPU','Wi-Fi','WebSocket','API','STT','TTS','HIFU','EMS','LLM','AI','Chrome','Edge','Electron','JavaScript',
    'TypeScript','Python','OpenAI','ChatGPT','Qwen','Whisper','Deepgram','Nova-3','SSD','NVMe','BIOS','UEFI','USB','HDMI',
    'Bluetooth','Ethernet','DNS','HTTP','HTTPS','JSON','REST','VAD','PCM','WAV','Docker','Kubernetes','Node.js','Git'
  ];

  const SYSTEM = [
    'あなたはTalkSysという日本語のリアルタイムPCアシスタントです。',
    '自然な日本語を基本にし、理由なく外国語や意味不明な発音へ切り替えないでください。',
    '通常は2〜5文で自然に答え、短すぎる一言回答を避けてください。音声が曖昧なら推測せず短く聞き返してください。',
    '外部事実、現在情報、人物、ニュース、価格、制度、製品仕様、技術仕様、医療・科学、比較、推薦はGoogle Searchを積極的に使い、モデル記憶だけで断定しないでください。',
    'Google Searchを使うと決めた場合、検索開始前に必ず「ちょっと調べますね。」と短く発話し、検索で確認できた情報を根拠に答えてください。',
    '検索で確認できない内容は推測で埋めないでください。URLは音読しないでください。',
    'PC画面に依存する質問だけinspect_current_screenを使ってください。画面ツール結果にない内容や未実行の操作を見た・実行したと主張しないでください。',
    '文字入力と音声入力は同じ会話として扱い、文脈を維持してください。ユーザーの割り込みを優先してください。'
  ].join('\n');

  const voice = document.getElementById('voice');
  const form = document.getElementById('form');
  const input = document.getElementById('input');
  const send = document.getElementById('send');
  const chat = document.getElementById('chat');
  const status = document.getElementById('status');
  const capture = document.getElementById('capture');
  const clear = document.getElementById('clear');
  const apiBase = document.getElementById('apiBase');
  if (!voice || !form || !input || !chat || !status || !apiBase) return;

  let base = 'https://talksys.syouziroupc.workers.dev';
  let ws = null;
  let ready = false;
  let shouldReconnect = true;
  let reconnectFailures = 0;
  let reconnectTimer = null;
  let rotateTimer = null;
  let sessionHandle = sessionStorage.getItem(HANDLE_KEY) || '';

  let audioContext = null;
  let micStream = null;
  let micSource = null;
  let worklet = null;
  let micEnabled = false;
  let noiseFloor = 0.006;
  let localSpeech = false;
  let startFrames = 0;
  let silenceMs = 0;
  let preRoll = [];
  let bargeFrames = 0;
  let audioStreamOpen = false;

  let modelSpeaking = false;
  let modelTurnComplete = true;
  let playbackEpoch = 0;
  let playbackCursor = 0;
  const playbackSources = new Set();

  let inputTranscript = '';
  let interimTranscript = '';
  let outputTranscript = '';
  let typedTurn = false;
  let turnComplete = false;
  let finalizeTimer = null;
  const grounding = new Map();
  const queuedText = [];

  function normalizeBase(value) {
    try {
      const u = new URL(String(value || base).trim());
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
      return u.toString().replace(/\/$/, '');
    } catch { return base; }
  }

  function setStatus(text) { status.textContent = text || ''; }
  function addMessage(role, text) {
    const value = String(text || '').trim();
    if (!value) return;
    const node = document.createElement('div');
    node.className = 'msg ' + role;
    node.textContent = value;
    chat.appendChild(node);
    node.scrollIntoView({ block: 'nearest' });
  }

  function addSources() {
    if (!grounding.size) return;
    const lines = [];
    for (const item of grounding.values()) {
      if (lines.length >= 5) break;
      lines.push('・' + (item.title || item.uri));
    }
    if (lines.length) addMessage('assistant', 'Google検索の出典\n' + lines.join('\n'));
  }

  function mergeText(current, incoming) {
    const next = String(incoming || '').trim();
    if (!next) return current;
    if (!current) return next;
    if (next === current || current.endsWith(next)) return current;
    if (next.startsWith(current)) return next;
    if (/^[、。！？,.!?]/.test(next)) return current + next;
    return current + ' ' + next;
  }

  function finalizeUi() {
    clearTimeout(finalizeTimer);
    finalizeTimer = null;
    if (!typedTurn) {
      const heard = inputTranscript.trim() || interimTranscript.trim();
      if (heard) addMessage('user', heard);
    }
    if (outputTranscript.trim()) addMessage('assistant', outputTranscript.trim());
    addSources();
    inputTranscript = '';
    interimTranscript = '';
    outputTranscript = '';
    grounding.clear();
    typedTurn = false;
    turnComplete = false;
  }

  function scheduleFinalize() {
    clearTimeout(finalizeTimer);
    finalizeTimer = setTimeout(finalizeUi, 520);
  }

  function bytesToBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + 0x8000)));
    return btoa(s);
  }
  function toPcm(samples) {
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const v = Math.max(-1, Math.min(1, samples[i]));
      pcm[i] = v < 0 ? v * 32768 : v * 32767;
    }
    return bytesToBase64(new Uint8Array(pcm.buffer));
  }
  function fromPcm(data) {
    const b = atob(String(data || ''));
    const out = new Float32Array(Math.floor(b.length / 2));
    for (let i = 0; i < out.length; i++) {
      let n = (b.charCodeAt(i * 2) & 255) | ((b.charCodeAt(i * 2 + 1) & 255) << 8);
      if (n & 0x8000) n -= 65536;
      out[i] = n / 32768;
    }
    return out;
  }
  function level(samples) {
    let sum = 0;
    for (const v of samples) sum += v * v;
    return Math.sqrt(sum / Math.max(1, samples.length));
  }
  function rateOf(mime) {
    const m = String(mime || '').match(/rate=(\d+)/i);
    const n = m ? Number(m[1]) : DEFAULT_OUTPUT_RATE;
    return Number.isFinite(n) && n >= 8000 && n <= 96000 ? n : DEFAULT_OUTPUT_RATE;
  }

  async function ensureAudio() {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    if (audioContext.state !== 'running') await audioContext.resume().catch(() => {});
    return audioContext;
  }

  function sendLive(message) {
    if (!ready || !ws || ws.readyState !== WebSocket.OPEN) return false;
    try { ws.send(JSON.stringify(message)); return true; } catch { return false; }
  }
  function endAudioStream() {
    if (audioStreamOpen && sendLive({ realtimeInput: { audioStreamEnd: true } })) audioStreamOpen = false;
  }

  function stopPlayback(interrupted = false) {
    playbackEpoch++;
    for (const source of playbackSources) { try { source.stop(); } catch {}; try { source.disconnect(); } catch {} }
    playbackSources.clear();
    playbackCursor = audioContext ? audioContext.currentTime : 0;
    modelSpeaking = false;
    if (interrupted) setStatus('割り込みを聞いています…');
  }

  async function playChunk(data, mimeType) {
    const ctx = await ensureAudio();
    const samples = fromPcm(data);
    if (!samples.length) return;
    if (!modelSpeaking) {
      modelSpeaking = true;
      modelTurnComplete = false;
      localSpeech = false;
      startFrames = 0;
      silenceMs = 0;
      preRoll = [];
      bargeFrames = 0;
      endAudioStream();
      setStatus('Geminiが話しています。途中で割り込めます。');
    }
    const buffer = ctx.createBuffer(1, samples.length, rateOf(mimeType));
    buffer.copyToChannel(samples, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const epoch = playbackEpoch;
    const at = Math.max(ctx.currentTime + 0.018, playbackCursor || 0);
    playbackCursor = at + buffer.duration;
    playbackSources.add(source);
    source.onended = () => {
      playbackSources.delete(source);
      try { source.disconnect(); } catch {}
      if (epoch === playbackEpoch && modelTurnComplete && playbackSources.size === 0) {
        modelSpeaking = false;
        if (micEnabled) setStatus('聞いています');
      }
    };
    source.start(at);
  }

  async function screenTool(query) {
    try {
      setStatus('画面を確認しています…');
      const result = await window.talksys.locate(String(query || '現在の画面を確認してください'), normalizeBase(apiBase.value));
      return { available: true, ...result };
    } catch (error) {
      return { available: false, reason: String(error?.message || error) };
    }
  }

  async function handleToolCall(toolCall) {
    const functionResponses = [];
    for (const call of toolCall?.functionCalls || []) {
      if (call.name === 'inspect_current_screen') {
        const result = await screenTool(call.args?.query || '現在の画面を確認してください');
        functionResponses.push({ id: call.id, name: call.name, response: { result } });
      } else functionResponses.push({ id: call.id, name: call.name, response: { error: 'unsupported_tool' } });
    }
    if (functionResponses.length) sendLive({ toolResponse: { functionResponses } });
  }

  async function onServer(message) {
    if (message.setupComplete) {
      ready = true;
      reconnectFailures = 0;
      setStatus(micEnabled ? '聞いています' : 'Gemini Live 接続済み');
      flushText();
      scheduleRotation();
      return;
    }
    if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) {
      sessionHandle = message.sessionResumptionUpdate.newHandle;
      sessionStorage.setItem(HANDLE_KEY, sessionHandle);
    }
    if (message.goAway) setTimeout(() => { try { ws?.close(1000, 'session_resumption'); } catch {} }, 120);
    if (message.toolCall) await handleToolCall(message.toolCall);

    const c = message.serverContent;
    if (!c) return;
    if (c.interrupted) {
      stopPlayback(true);
      outputTranscript = '';
      grounding.clear();
      modelTurnComplete = true;
    }
    if (c.interimInputTranscription?.text) {
      interimTranscript = String(c.interimInputTranscription.text).trim();
      if (!typedTurn && interimTranscript) setStatus('聞き取り中: ' + interimTranscript);
    }
    if (c.inputTranscription?.text) {
      inputTranscript = mergeText(inputTranscript, c.inputTranscription.text);
      interimTranscript = '';
      if (!typedTurn && inputTranscript) setStatus('聞き取り: ' + inputTranscript);
      if (turnComplete) scheduleFinalize();
    }
    if (c.outputTranscription?.text) {
      outputTranscript = mergeText(outputTranscript, c.outputTranscription.text);
      if (turnComplete) scheduleFinalize();
    }
    for (const chunk of c.groundingMetadata?.groundingChunks || []) {
      if (chunk?.web?.uri) grounding.set(chunk.web.uri, { uri: chunk.web.uri, title: String(chunk.web.title || '').trim() });
    }
    if (grounding.size) setStatus('Google検索で確認した情報から回答しています…');
    for (const part of c.modelTurn?.parts || []) {
      if (part.inlineData?.data && /audio\/pcm/i.test(part.inlineData.mimeType || 'audio/pcm')) await playChunk(part.inlineData.data, part.inlineData.mimeType);
    }
    if (c.turnComplete) {
      turnComplete = true;
      modelTurnComplete = true;
      scheduleFinalize();
      if (playbackSources.size === 0) {
        modelSpeaking = false;
        if (micEnabled) setStatus('聞いています');
      }
    }
  }

  function setupMessage() {
    return { setup: {
      model: 'models/' + MODEL,
      generationConfig: {
        responseModalities: ['AUDIO'], temperature: 0.28, topP: 0.9,
        thinkingConfig: { thinkingLevel: 'LOW' },
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
      },
      systemInstruction: { parts: [{ text: SYSTEM }] },
      tools: [
        { googleSearch: {} },
        { functionDeclarations: [{
          name: 'inspect_current_screen',
          description: '現在のPCデスクトップを確認し、質問されたUI要素や表示内容を特定する。画面依存の質問でだけ使う。',
          parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' } }, required: ['query'] }
        }] }
      ],
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false, startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH', endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
          prefixPaddingMs: 180, silenceDurationMs: 800
        },
        activityHandling: 'START_OF_ACTIVITY_INTERRUPTS', turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY'
      },
      sessionResumption: sessionHandle ? { handle: sessionHandle } : {},
      contextWindowCompression: { triggerTokens: '90000', slidingWindow: { targetTokens: '52000' } },
      inputAudioTranscription: { languageCodes: ['ja-JP'], customVocabulary: CUSTOM_VOCABULARY, mode: 'SMART' },
      outputAudioTranscription: {}
    }};
  }

  async function token() {
    const res = await fetch(normalizeBase(apiBase.value) + '/api/gemini-live-token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.available || !data.token) throw new Error(data.reason || 'Gemini token HTTP ' + res.status);
    return data;
  }

  function scheduleRotation() {
    clearTimeout(rotateTimer);
    rotateTimer = setTimeout(() => {
      if (modelSpeaking || localSpeech) { scheduleRotation(); return; }
      setStatus('会話を維持したままセッションを更新します…');
      try { ws?.close(1000, 'proactive_rotation'); } catch {}
    }, SESSION_ROTATE_MS);
  }

  async function connect() {
    if (ready && ws?.readyState === WebSocket.OPEN) return;
    clearTimeout(reconnectTimer);
    const t = await token();
    await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => { if (!settled) { settled = true; reject(new Error('Gemini Live setup timeout')); } }, 9000);
      ws = new WebSocket((t.endpoint || 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained') + '?access_token=' + encodeURIComponent(t.token));
      ws.onopen = () => ws.send(JSON.stringify(setupMessage()));
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.setupComplete && !settled) { settled = true; clearTimeout(timeout); resolve(); }
        void onServer(m);
      };
      ws.onerror = () => { if (!settled) { settled = true; clearTimeout(timeout); reject(new Error('Gemini Live WebSocket error')); } };
      ws.onclose = (ev) => {
        ready = false;
        clearTimeout(rotateTimer);
        if (!settled) { settled = true; clearTimeout(timeout); reject(new Error('Gemini Live closed ' + ev.code)); }
        if (!shouldReconnect) return;
        reconnectFailures++;
        if (ev.code === 1007 && reconnectFailures <= 2) { sessionHandle = ''; sessionStorage.removeItem(HANDLE_KEY); }
        setStatus('Gemini Live 再接続中…');
        reconnectTimer = setTimeout(() => connect().catch((e) => setStatus('再接続エラー: ' + e.message)), Math.min(2500, 300 * Math.pow(1.7, reconnectFailures)));
      };
    });
  }

  const WORKLET = "class TalkSysDesktopGeminiCapture extends AudioWorkletProcessor{constructor(){super();this.b=[];this.r=sampleRate/16000}process(i){const x=i[0];if(!x||!x[0])return true;const d=x[0];for(let p=0;p<d.length;p+=this.r){const n=Math.floor(p),f=p-n;this.b.push(n+1<d.length?d[n]*(1-f)+d[n+1]*f:(d[n]||0))}while(this.b.length>=640){const a=new Float32Array(this.b.splice(0,640));this.port.postMessage(a,[a.buffer])}return true}}registerProcessor('talksys-desktop-gemini',TalkSysDesktopGeminiCapture);";

  function sendMic(samples) {
    const ok = sendLive({ realtimeInput: { audio: { data: toPcm(samples), mimeType: 'audio/pcm;rate=16000' } } });
    if (ok) audioStreamOpen = true;
  }

  function micFrame(samples) {
    const l = level(samples);
    if (modelSpeaking) {
      preRoll.push(new Float32Array(samples)); if (preRoll.length > PRE_ROLL_FRAMES) preRoll.shift();
      const th = Math.max(ECHO_BARGE_THRESHOLD, Math.min(0.14, noiseFloor * 5));
      if (l >= th) bargeFrames++; else bargeFrames = Math.max(0, bargeFrames - 1);
      if (bargeFrames >= ECHO_BARGE_FRAMES) {
        stopPlayback(true); modelTurnComplete = true; localSpeech = true; startFrames = 2; silenceMs = 0;
        for (const f of preRoll) sendMic(f); preRoll = []; bargeFrames = 0;
      }
      return;
    }
    if (!localSpeech && l < 0.025) noiseFloor = noiseFloor * 0.985 + l * 0.015;
    const start = Math.max(0.014, noiseFloor * 2.7);
    const end = Math.max(0.009, noiseFloor * 1.65);
    if (!localSpeech) {
      preRoll.push(new Float32Array(samples)); if (preRoll.length > PRE_ROLL_FRAMES) preRoll.shift();
      if (l >= start) startFrames++; else startFrames = Math.max(0, startFrames - 1);
      if (startFrames >= 2) {
        localSpeech = true; silenceMs = 0; setStatus('聞いています…');
        for (const f of preRoll) sendMic(f); preRoll = [];
      } else sendMic(samples);
      return;
    }
    sendMic(samples);
    if (l <= end) silenceMs += CHUNK_MS; else silenceMs = 0;
    if (silenceMs >= LOCAL_END_SILENCE_MS) {
      endAudioStream(); localSpeech = false; startFrames = 0; silenceMs = 0; preRoll = []; setStatus('Geminiが考えています…');
    }
  }

  async function startMic() {
    await connect();
    const ctx = await ensureAudio();
    if (!micStream) {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      micSource = ctx.createMediaStreamSource(micStream);
      worklet = new AudioWorkletNode(ctx, 'talksys-desktop-gemini');
      worklet.port.onmessage = (e) => micFrame(e.data instanceof Float32Array ? e.data : new Float32Array(e.data));
      micSource.connect(worklet); worklet.connect(ctx.destination);
    }
    micEnabled = true;
    voice.classList.add('active');
    voice.textContent = '● Gemini Live 通話中';
    setStatus('聞いています');
  }

  function stopMic() {
    micEnabled = false; endAudioStream(); stopPlayback(false);
    micStream?.getTracks().forEach(t => t.stop()); micStream = null;
    try { micSource?.disconnect(); } catch {}; micSource = null;
    try { worklet?.disconnect(); } catch {}; worklet = null;
    voice.classList.remove('active'); voice.textContent = '☎ Gemini Liveを開始';
    setStatus(ready ? 'Gemini Live 接続済み（マイク停止）' : '');
  }

  function flushText() {
    if (!ready) return;
    while (queuedText.length) sendLive({ realtimeInput: { text: queuedText.shift() } });
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = ''; send.disabled = true; addMessage('user', text); typedTurn = true;
    inputTranscript = ''; interimTranscript = ''; outputTranscript = ''; grounding.clear(); turnComplete = false;
    stopPlayback(true); setStatus('Geminiが考えています…');
    try { if (!ready) await connect(); queuedText.push(text); flushText(); }
    catch (e) { addMessage('assistant', 'Gemini Live接続エラー: ' + e.message); }
    finally { send.disabled = false; input.focus(); }
  });
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); form.requestSubmit(); } });
  voice.addEventListener('click', () => { if (micEnabled) stopMic(); else startMic().catch(e => setStatus('マイク開始エラー: ' + e.message)); });
  capture?.addEventListener('click', async () => {
    capture.disabled = true;
    try { const r = await window.talksys.saveCapture(); setStatus(r.saved ? '保存: ' + r.filePath : '保存をキャンセルしました。'); }
    catch (e) { setStatus('キャプチャーエラー: ' + e.message); }
    finally { capture.disabled = false; }
  });
  clear?.addEventListener('click', async () => { await window.talksys.clearOverlay(); setStatus('矢印を消しました。'); });

  window.addEventListener('beforeunload', () => {
    shouldReconnect = false; clearTimeout(reconnectTimer); clearTimeout(rotateTimer); stopMic(); try { ws?.close(1000, 'desktop_close'); } catch {}
  }, { once: true });

  window.talksys.getConfig().then((config) => {
    base = normalizeBase(config.apiBase || base); apiBase.value = base;
    voice.textContent = '… Gemini Live接続中';
    connect().then(() => startMic()).catch((e) => {
      voice.textContent = '☎ Gemini Liveを再試行';
      setStatus('Gemini Liveを開始できません: ' + e.message);
    });
  }).catch(() => {
    apiBase.value = base;
    setStatus('接続設定を取得できませんでした。');
  });
})();
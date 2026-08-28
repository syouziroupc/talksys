export const GEMINI_PHONE_CLIENT = String.raw`(() => {
  'use strict';

  window.__talksysGeminiLivePrimary = true;
  window.__talksysPhoneMode = true;

  const MODEL = 'gemini-3.1-flash-live-preview';
  const TOKEN_ENDPOINT = '/api/gemini-live-token';
  const INPUT_RATE = 16000;
  const OUTPUT_RATE = 24000;
  const CHUNK_SAMPLES = 640; // 40 ms at 16 kHz
  const LOCAL_END_SILENCE_MS = 440;
  const START_FRAMES = 2;
  const BARGE_FRAMES = 3;
  const PRE_ROLL_FRAMES = 6;
  const RECONNECT_MS = 250;
  const MAX_SETUP_MS = 8000;
  const HANDLE_KEY = 'talksys.gemini.live.handle';
  const TRANSCRIPT_SETTLE_MS = 420;

  const SYSTEM_INSTRUCTION = [
    'あなたはTalkSys。電話で人と話しているような自然な日本語のリアルタイム音声アシスタントです。',
    '返答開始を速くしてください。挨拶や相づちは短く、普通の質問・相談には原則2〜5文で、直接回答に理由・補足・具体例のいずれかを加えてください。',
    'ユーザーの発話途中に先回りして答えず、意味のある区切りまで聞いてください。ユーザーが割り込んだら直ちに発話を止め、ユーザーを優先してください。',
    '外部事実、現在情報、人物、ニュース、価格、法律、制度、製品・技術仕様、医療・科学など誤る可能性がある知識質問はGoogle Searchで確認してください。記憶だけで固有名詞・数字・日付・仕様を作らないでください。',
    'Google Searchを使う場合、検索に時間がかかりそうなら本回答より先に「ちょっと調べますね。」など一言だけ自然に伝え、その後に検索結果で確認できた内容だけを答えてください。',
    '検索結果で確認できないことは推測せず、確認できないと伝えてください。検索結果が食い違う場合は断定せず不一致を説明してください。URLは音読しないでください。',
    '音声入力と文字チャットは同じ会話です。直前までの文脈を保ってください。',
    '現在のPC画面について答える必要がある時だけinspect_current_screenを使ってください。ツール結果にない画面内容や、実行していない操作を見た・実行したと主張しないでください。',
    '原則として日本語で話してください。別言語への切替はユーザーが明示的に求めた時だけです。'
  ].join('\n');

  const originalVoice = document.getElementById('voice');
  const originalForm = document.getElementById('form');
  const chat = document.getElementById('chat');
  const status = document.getElementById('status');
  if (!originalVoice || !originalForm || !chat || !status) return;

  const voice = originalVoice.cloneNode(true);
  originalVoice.replaceWith(voice);
  const form = originalForm.cloneNode(true);
  originalForm.replaceWith(form);
  const input = form.querySelector('#input');

  let ws = null;
  let liveReady = false;
  let connectPromise = null;
  let connectResolve = null;
  let connectReject = null;
  let reconnectTimer = null;
  let shouldReconnect = true;
  let legacyActivated = false;
  let closeFailures = 0;
  let sessionHandle = sessionStorage.getItem(HANDLE_KEY) || '';

  let audioContext = null;
  let micStream = null;
  let micSource = null;
  let worklet = null;
  let micEnabled = false;
  let micReady = false;
  let noiseFloor = 0.006;
  let userSpeech = false;
  let speechStartFrames = 0;
  let silenceMs = 0;
  let idlePreRoll = [];
  let bargePreRoll = [];
  let bargeCount = 0;
  let audioStreamOpen = false;

  let playbackCursor = 0;
  let playbackEpoch = 0;
  let playbackSources = new Set();
  let modelSpeaking = false;
  let modelTurnComplete = true;

  let interimInput = '';
  let finalInput = '';
  let outputTranscript = '';
  let typedTurnOpen = false;
  let pendingTyped = [];
  let transcriptTimer = null;
  let groundingSources = new Map();
  let lastMessageKey = '';

  function setStatus(text) { status.textContent = text || ''; }

  function addMessage(role, text) {
    const value = String(text || '').trim();
    if (!value) return;
    const key = role + ':' + value;
    if (key === lastMessageKey) return;
    lastMessageKey = key;
    const node = document.createElement('div');
    node.className = 'msg ' + role;
    node.textContent = value;
    chat.appendChild(node);
    node.scrollIntoView({ block: 'nearest' });
  }

  function mergeTranscript(current, incoming) {
    const next = String(incoming || '').trim();
    if (!next) return current;
    if (!current || next.startsWith(current)) return next;
    if (current.endsWith(next) || current === next) return current;
    return current + (current.endsWith(' ') || /^[、。！？,.!?]/.test(next) ? '' : ' ') + next;
  }

  function collectGrounding(metadata) {
    for (const chunk of metadata?.groundingChunks || []) {
      const web = chunk?.web;
      if (web?.uri) groundingSources.set(web.uri, { uri: web.uri, title: String(web.title || '').trim() });
    }
    if (groundingSources.size) setStatus('Google検索で確認しています…');
  }

  function renderSources() {
    if (!groundingSources.size) return;
    const node = document.createElement('div');
    node.className = 'msg assistant';
    const label = document.createElement('div');
    label.textContent = '検索出典';
    label.style.fontSize = '12px';
    label.style.fontWeight = '700';
    node.appendChild(label);
    let n = 0;
    for (const source of groundingSources.values()) {
      if (n++ >= 4) break;
      const a = document.createElement('a');
      a.href = source.uri;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = source.title || source.uri;
      a.style.display = 'block';
      a.style.fontSize = '12px';
      a.style.marginTop = '4px';
      node.appendChild(a);
    }
    chat.appendChild(node);
    node.scrollIntoView({ block: 'nearest' });
  }

  function settleTurn() {
    clearTimeout(transcriptTimer);
    transcriptTimer = null;
    if (!typedTurnOpen) {
      const userText = String(finalInput || interimInput || '').trim();
      if (userText) addMessage('user', userText);
    }
    const assistantText = String(outputTranscript || '').trim();
    if (assistantText) addMessage('assistant', assistantText);
    renderSources();
    finalInput = '';
    interimInput = '';
    outputTranscript = '';
    groundingSources.clear();
    typedTurnOpen = false;
  }

  function scheduleSettle() {
    clearTimeout(transcriptTimer);
    transcriptTimer = setTimeout(settleTurn, TRANSCRIPT_SETTLE_MS);
  }

  function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + 0x8000)));
    return btoa(binary);
  }

  function samplesToBase64(samples) {
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      const v = Math.max(-1, Math.min(1, samples[i]));
      pcm[i] = v < 0 ? v * 32768 : v * 32767;
    }
    return bytesToBase64(new Uint8Array(pcm.buffer));
  }

  function base64ToFloat(data) {
    const raw = atob(String(data || ''));
    const out = new Float32Array(Math.floor(raw.length / 2));
    for (let i = 0; i < out.length; i += 1) {
      let sample = (raw.charCodeAt(i * 2) & 255) | ((raw.charCodeAt(i * 2 + 1) & 255) << 8);
      if (sample & 0x8000) sample -= 0x10000;
      out[i] = sample / 32768;
    }
    return out;
  }

  function rms(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
    return Math.sqrt(sum / Math.max(1, samples.length));
  }

  function send(message, allowBeforeReady = false) {
    if (!ws || ws.readyState !== WebSocket.OPEN || (!liveReady && !allowBeforeReady)) return false;
    try { ws.send(JSON.stringify(message)); return true; } catch { return false; }
  }

  function endAudioStream() {
    if (!audioStreamOpen) return;
    if (send({ realtimeInput: { audioStreamEnd: true } })) audioStreamOpen = false;
  }

  function sendAudio(samples) {
    if (!liveReady || !micEnabled) return false;
    const ok = send({ realtimeInput: { audio: { data: samplesToBase64(samples), mimeType: 'audio/pcm;rate=' + INPUT_RATE } } });
    if (ok) audioStreamOpen = true;
    return ok;
  }

  function stopPlayback(interrupted) {
    playbackEpoch += 1;
    for (const source of playbackSources) {
      try { source.stop(); } catch {}
      try { source.disconnect(); } catch {}
    }
    playbackSources.clear();
    playbackCursor = audioContext ? audioContext.currentTime : 0;
    modelSpeaking = false;
    if (interrupted) setStatus('聞いています');
  }

  function maybePlaybackDone(epoch) {
    if (epoch !== playbackEpoch || playbackSources.size || !modelTurnComplete) return;
    modelSpeaking = false;
    bargePreRoll = [];
    bargeCount = 0;
    if (micEnabled) setStatus('聞いています');
  }

  async function ensureAudioContext() {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    if (audioContext.state !== 'running') await audioContext.resume().catch(() => {});
    return audioContext;
  }

  async function playAudio(base64) {
    const ctx = await ensureAudioContext();
    const samples = base64ToFloat(base64);
    if (!samples.length) return;
    if (!modelSpeaking) {
      modelSpeaking = true;
      modelTurnComplete = false;
      endAudioStream();
      setStatus('Geminiが話しています。途中でそのまま話せます。');
    }
    const buffer = ctx.createBuffer(1, samples.length, OUTPUT_RATE);
    buffer.copyToChannel(samples, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const epoch = playbackEpoch;
    const start = Math.max(ctx.currentTime + 0.012, playbackCursor || 0);
    playbackCursor = start + buffer.duration;
    playbackSources.add(source);
    source.onended = () => {
      playbackSources.delete(source);
      try { source.disconnect(); } catch {}
      maybePlaybackDone(epoch);
    };
    source.start(start);
  }

  async function inspectCurrentScreen(query) {
    const video = document.getElementById('screenVideo');
    if (!video?.srcObject || !video.videoWidth || !video.videoHeight) return { available: false, reason: 'screen_share_required' };
    try {
      const scale = Math.min(1, 1024 / video.videoWidth, 720 / video.videoHeight);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.getContext('2d', { alpha: false }).drawImage(video, 0, 0, canvas.width, canvas.height);
      const response = await fetch('/api/locate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: String(query || '現在の画面を確認してください').slice(0, 600), image: canvas.toDataURL('image/jpeg', 0.78) })
      });
      const result = await response.json();
      return response.ok ? { available: true, ...result } : { available: false, reason: result.error || 'screen_analysis_failed' };
    } catch (error) {
      return { available: false, reason: String(error?.message || error) };
    }
  }

  async function handleToolCall(toolCall) {
    const functionResponses = [];
    for (const call of toolCall?.functionCalls || []) {
      if (call.name === 'inspect_current_screen') {
        setStatus('画面を確認しています…');
        const result = await inspectCurrentScreen(call.args?.query);
        functionResponses.push({ id: call.id, name: call.name, response: { result } });
      } else {
        functionResponses.push({ id: call.id, name: call.name, response: { error: 'unsupported_tool' } });
      }
    }
    if (functionResponses.length) send({ toolResponse: { functionResponses } });
  }

  function buildSetup() {
    return { setup: {
      model: 'models/' + MODEL,
      generationConfig: {
        responseModalities: ['AUDIO'],
        temperature: 0.3,
        topP: 0.9,
        speechConfig: { languageCode: 'ja-JP' },
        thinkingConfig: { thinkingLevel: 'minimal' }
      },
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      tools: [
        { googleSearch: {} },
        { functionDeclarations: [{
          name: 'inspect_current_screen',
          description: '現在共有されているPC画面を確認する。画面に依存する質問の時だけ使う。',
          parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' } }, required: ['query'] }
        }] }
      ],
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
          endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
          prefixPaddingMs: 120,
          silenceDurationMs: 650
        },
        activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
        turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY'
      },
      sessionResumption: sessionHandle ? { handle: sessionHandle } : {},
      contextWindowCompression: { slidingWindow: {} },
      inputAudioTranscription: {},
      outputAudioTranscription: {}
    } };
  }

  function flushTypedQueue() {
    if (!liveReady || !pendingTyped.length) return;
    const queue = pendingTyped.splice(0);
    for (const text of queue) send({ realtimeInput: { text } });
  }

  async function handleServer(message) {
    if (message.setupComplete) {
      liveReady = true;
      closeFailures = 0;
      connectResolve?.();
      connectResolve = null;
      connectReject = null;
      setStatus(micEnabled ? '聞いています' : 'Gemini Live 接続済み');
      flushTypedQueue();
      return;
    }
    if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) {
      sessionHandle = message.sessionResumptionUpdate.newHandle;
      sessionStorage.setItem(HANDLE_KEY, sessionHandle);
    }
    if (message.goAway) {
      setStatus('通話を維持したまま接続を更新します…');
      setTimeout(() => { try { ws?.close(1000, 'session_resumption'); } catch {} }, 100);
    }
    if (message.toolCall) await handleToolCall(message.toolCall);
    const content = message.serverContent;
    if (!content) return;

    if (content.interrupted) {
      stopPlayback(true);
      outputTranscript = '';
      groundingSources.clear();
      modelTurnComplete = true;
    }
    if (content.interimInputTranscription?.text && !typedTurnOpen) {
      interimInput = String(content.interimInputTranscription.text || '').trim();
      if (interimInput) setStatus('聞き取り中: ' + interimInput);
    }
    if (content.inputTranscription?.text && !typedTurnOpen) {
      finalInput = mergeTranscript(finalInput, content.inputTranscription.text);
      interimInput = finalInput;
      setStatus('聞き取り: ' + finalInput);
    }
    if (content.outputTranscription?.text) outputTranscript = mergeTranscript(outputTranscript, content.outputTranscription.text);
    if (content.groundingMetadata) collectGrounding(content.groundingMetadata);
    for (const part of content.modelTurn?.parts || []) {
      if (part.inlineData?.data && /audio\/pcm/i.test(part.inlineData.mimeType || 'audio/pcm')) await playAudio(part.inlineData.data);
    }
    if (content.turnComplete) {
      modelTurnComplete = true;
      scheduleSettle();
      maybePlaybackDone(playbackEpoch);
    }
  }

  async function fetchToken() {
    const response = await fetch(TOKEN_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: '{}' });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok || !data.available || !data.token) {
      const error = new Error(data.reason || data.error || ('Gemini token HTTP ' + response.status));
      error.code = response.status === 503 ? 'not_configured' : 'token_failed';
      throw error;
    }
    return data;
  }

  async function connectLive() {
    if (legacyActivated) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return connectPromise;
    clearTimeout(reconnectTimer);
    liveReady = false;
    const token = await fetchToken();
    const endpoint = token.endpoint || 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
    connectPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Gemini Live setup timeout')), MAX_SETUP_MS);
      connectResolve = () => { clearTimeout(timer); resolve(); };
      connectReject = (error) => { clearTimeout(timer); reject(error); };
    });
    const socket = new WebSocket(endpoint + '?access_token=' + encodeURIComponent(token.token));
    ws = socket;
    socket.onopen = () => { try { socket.send(JSON.stringify(buildSetup())); } catch (error) { connectReject?.(error); } };
    socket.onmessage = (event) => { let m; try { m = JSON.parse(event.data); } catch { return; } void handleServer(m); };
    socket.onerror = () => { if (!liveReady) connectReject?.(new Error('Gemini Live WebSocket error')); };
    socket.onclose = (event) => {
      const wasReady = liveReady;
      liveReady = false;
      if (!wasReady) connectReject?.(new Error('Gemini Live closed before setup: ' + event.code));
      if (!shouldReconnect || legacyActivated) return;
      closeFailures += 1;
      if ((event.code === 1007 || event.code === 1011) && sessionHandle) {
        sessionHandle = '';
        sessionStorage.removeItem(HANDLE_KEY);
      }
      if (closeFailures >= 6) { void activateLegacy('Gemini Liveの接続が安定しません。'); return; }
      setStatus('通話を再接続しています…');
      reconnectTimer = setTimeout(() => connectLive().catch((error) => {
        if (error?.code === 'not_configured') void activateLegacy('Gemini APIキーが未設定です。');
      }), RECONNECT_MS);
    };
    return connectPromise;
  }

  const WORKLET = "class TalkSysPhoneCapture extends AudioWorkletProcessor{constructor(){super();this.buf=[];this.ratio=sampleRate/16000}process(inputs){const d=inputs[0]?.[0];if(!d)return true;for(let i=0;i<d.length;i+=this.ratio){const n=Math.floor(i),f=i-n;this.buf.push(n+1<d.length?d[n]*(1-f)+d[n+1]*f:(d[n]||0))}while(this.buf.length>=640){const a=new Float32Array(this.buf.splice(0,640));this.port.postMessage(a,[a.buffer])}return true}}registerProcessor('talksys-phone-capture',TalkSysPhoneCapture);";

  function handleMic(samples) {
    if (!micEnabled || !liveReady) return;
    const level = rms(samples);
    const startThreshold = Math.max(0.011, Math.min(0.05, noiseFloor * 2.5));
    const endThreshold = Math.max(0.007, Math.min(0.035, noiseFloor * 1.55));

    if (modelSpeaking) {
      const copy = new Float32Array(samples);
      bargePreRoll.push(copy);
      if (bargePreRoll.length > PRE_ROLL_FRAMES) bargePreRoll.shift();
      const bargeThreshold = Math.max(0.038, Math.min(0.11, noiseFloor * 3.8));
      if (level >= bargeThreshold) bargeCount += 1; else bargeCount = Math.max(0, bargeCount - 1);
      if (bargeCount < BARGE_FRAMES) return;
      stopPlayback(true);
      userSpeech = true;
      silenceMs = 0;
      speechStartFrames = START_FRAMES;
      for (const frame of bargePreRoll) sendAudio(frame);
      bargePreRoll = [];
      bargeCount = 0;
      setStatus('割り込みを聞いています…');
      return;
    }

    idlePreRoll.push(new Float32Array(samples));
    if (idlePreRoll.length > PRE_ROLL_FRAMES) idlePreRoll.shift();

    if (!userSpeech) {
      if (level < startThreshold) {
        noiseFloor = Math.max(0.0015, Math.min(0.03, noiseFloor * 0.985 + level * 0.015));
        speechStartFrames = 0;
        return;
      }
      speechStartFrames += 1;
      if (speechStartFrames < START_FRAMES) return;
      userSpeech = true;
      silenceMs = 0;
      for (const frame of idlePreRoll) sendAudio(frame);
      idlePreRoll = [];
      setStatus('聞いています…');
      return;
    }

    sendAudio(samples);
    if (level <= endThreshold) silenceMs += 40; else silenceMs = 0;
    if (silenceMs >= LOCAL_END_SILENCE_MS) {
      endAudioStream();
      userSpeech = false;
      speechStartFrames = 0;
      silenceMs = 0;
      idlePreRoll = [];
      setStatus('考えています…');
    }
  }

  async function ensureMic() {
    if (micReady && micStream && worklet) return;
    const ctx = await ensureAudioContext();
    micStream = await navigator.mediaDevices.getUserMedia({ audio: {
      channelCount: 1,
      sampleRate: { ideal: 48000 },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    } });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    micSource = ctx.createMediaStreamSource(micStream);
    worklet = new AudioWorkletNode(ctx, 'talksys-phone-capture');
    worklet.port.onmessage = (event) => handleMic(event.data instanceof Float32Array ? event.data : new Float32Array(event.data));
    micSource.connect(worklet);
    worklet.connect(ctx.destination);
    micReady = true;
  }

  async function startVoice(auto) {
    if (legacyActivated) return;
    voice.disabled = true;
    setStatus('通話を接続しています…');
    try {
      await Promise.all([connectLive(), ensureMic()]);
      micEnabled = true;
      voice.classList.add('active');
      voice.textContent = '● 通話中';
      voice.disabled = false;
      setStatus('聞いています');
    } catch (error) {
      voice.disabled = false;
      if (error?.code === 'not_configured') { await activateLegacy('Gemini APIキーが未設定です。'); return; }
      if (auto && (error?.name === 'NotAllowedError' || error?.name === 'SecurityError')) {
        voice.textContent = '☎ 通話を開始';
        setStatus('ボタンを押してマイクを許可してください。');
        return;
      }
      setStatus('通話開始エラー: ' + String(error?.message || error));
    }
  }

  function stopVoice() {
    micEnabled = false;
    endAudioStream();
    stopPlayback(false);
    micStream?.getTracks().forEach((track) => track.stop());
    micStream = null;
    micReady = false;
    try { micSource?.disconnect(); } catch {}
    try { worklet?.disconnect(); } catch {}
    micSource = null;
    worklet = null;
    userSpeech = false;
    idlePreRoll = [];
    voice.classList.remove('active');
    voice.textContent = '☎ 通話を開始';
    setStatus(liveReady ? '接続済み（マイク停止）' : '');
  }

  async function submitTyped(event) {
    if (event) { event.preventDefault(); event.stopImmediatePropagation(); }
    const value = String(input?.value || '').trim();
    if (!value || legacyActivated) return;
    if (input) input.value = '';
    addMessage('user', value);
    typedTurnOpen = true;
    finalInput = '';
    interimInput = '';
    outputTranscript = '';
    groundingSources.clear();
    stopPlayback(true);
    setStatus('Geminiが考えています…');
    try {
      if (!liveReady) await connectLive();
      pendingTyped.push(value);
      flushTypedQueue();
    } catch (error) {
      if (error?.code === 'not_configured') await activateLegacy('Gemini APIキーが未設定です。');
      else addMessage('assistant', '接続エラー: ' + String(error?.message || error));
    }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error('load failed: ' + src));
      document.body.appendChild(script);
    });
  }

  async function activateLegacy(reason) {
    if (legacyActivated) return;
    legacyActivated = true;
    shouldReconnect = false;
    clearTimeout(reconnectTimer);
    try { ws?.close(); } catch {}
    ws = null;
    stopVoice();
    window.__talksysGeminiLivePrimary = false;
    setStatus((reason || 'Gemini Liveを利用できません。') + ' 従来音声へ切り替えます。');
    const currentVoice = document.getElementById('voice');
    if (currentVoice) currentVoice.replaceWith(currentVoice.cloneNode(true));
    const currentForm = document.getElementById('form');
    if (currentForm) currentForm.replaceWith(currentForm.cloneNode(true));
    try {
      await loadScript('/voice-marker-bridge.js');
      await loadScript('/realtime-voice.js');
      await loadScript('/voice-fallback.js');
    } catch (error) {
      setStatus('フォールバック起動失敗: ' + String(error?.message || error));
    }
  }

  voice.textContent = '… 通話接続中';
  voice.addEventListener('click', async () => { if (micEnabled) stopVoice(); else await startVoice(false); });
  form.addEventListener('submit', submitTyped, true);
  input?.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) void submitTyped(event); }, true);

  window.addEventListener('beforeunload', () => {
    shouldReconnect = false;
    endAudioStream();
    stopPlayback(false);
    try { ws?.close(1000, 'page_unload'); } catch {}
    micStream?.getTracks().forEach((track) => track.stop());
  }, { once: true });

  connectLive().then(() => startVoice(true)).catch((error) => {
    if (error?.code === 'not_configured') void activateLegacy('Gemini APIキーが未設定です。');
    else {
      voice.textContent = '☎ 通話を再接続';
      setStatus('Gemini Live接続エラー: ' + String(error?.message || error));
    }
  });
})();
`;
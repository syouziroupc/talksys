export const GEMINI_LIVE_PRIMARY = String.raw`(() => {
  'use strict';

  window.__talksysGeminiLivePrimary = true;

  const MODEL = 'gemini-3.1-flash-live-preview';
  const TOKEN_ENDPOINT = '/api/gemini-live-token';
  const INPUT_RATE = 16000;
  const OUTPUT_RATE = 24000;
  const FRAME_SAMPLES = 640; // 40ms
  const END_SILENCE_MS = 480;
  const START_FRAMES = 2;
  const PREROLL_FRAMES = 6;
  const BARGE_FRAMES = 4;
  const BARGE_MIN_RMS = 0.040;
  const RESUME_KEY = 'talksys.gemini.live.resume.v13';
  const SETUP_TIMEOUT_MS = 9000;
  const TRANSCRIPT_SETTLE_MS = 320;

  const SYSTEM = [
    'あなたはTalkSysという日本語のリアルタイム音声アシスタントです。',
    'ユーザーが明示的に別言語を求めない限り、自然な日本語で会話してください。',
    '日常会話では普通の会話相手として振る舞い、質問・相談・雑談には原則2〜5文で答えてください。直接回答だけの一言で終わらず、理由、補足、具体例のどれかを最低1つ添えてください。',
    '外部事実、現在情報、人物、ニュース、価格、法律、制度、製品仕様、技術仕様、医療・科学の事実など、誤り得る知識質問ではGoogle Searchを積極的に使って確認してください。記憶だけで固有名詞、数値、日付、仕様を作らないでください。',
    'Google Searchが必要なときは、長く無言にせず、自然なら最初に「ちょっと調べますね。」と短く伝えてください。検索結果で確認できた範囲だけ回答し、確認できないことは推測しないでください。',
    '複数の検索結果が食い違う場合は断定せず、不一致を短く説明してください。URLは音読しないでください。',
    '現在のPC画面に依存する質問だけinspect_current_screenを使ってください。ツール結果に無い画面内容、見ていない表示、実行していない操作を見た・実行したと主張しないでください。',
    '音声入力と文字チャットは同じ会話です。直前までの文脈を維持してください。',
    'ユーザーが話し始めたら自分の発話を止め、割り込みを優先してください。',
  ].join('\n');

  const oldVoice = document.getElementById('voice');
  const oldForm = document.getElementById('form');
  const chat = document.getElementById('chat');
  const status = document.getElementById('status');
  if (!oldVoice || !oldForm || !chat || !status || !navigator.mediaDevices?.getUserMedia) return;

  // The page's original REST/WebSpeech listeners are removed. Gemini owns both
  // voice and typed chat so they cannot diverge into separate histories.
  const voice = oldVoice.cloneNode(true);
  oldVoice.replaceWith(voice);
  const form = oldForm.cloneNode(true);
  oldForm.replaceWith(form);
  const input = form.querySelector('#input');
  const sendButton = form.querySelector('#send');

  let ws = null;
  let setupReady = false;
  let setupPromise = null;
  let resolveSetup = null;
  let rejectSetup = null;
  let reconnectTimer = null;
  let reconnectFailures = 0;
  let keepConnected = true;
  let resumeHandle = sessionStorage.getItem(RESUME_KEY) || '';
  let legacy = false;

  let audioContext = null;
  let micStream = null;
  let micSource = null;
  let micWorklet = null;
  let micReady = false;
  let micEnabled = false;
  let micFrames = 0;

  let localSpeaking = false;
  let loudFrames = 0;
  let silenceMs = 0;
  let noiseFloor = 0.006;
  let preRoll = [];

  let modelSpeaking = false;
  let modelTurnComplete = true;
  let playbackEpoch = 0;
  let playbackCursor = 0;
  const playbackSources = new Set();
  let bargeFrames = 0;
  let bargePreRoll = [];

  let inputTranscript = '';
  let outputTranscript = '';
  let typedTurn = false;
  let transcriptTimer = null;
  let turnCompleteSeen = false;
  const sources = new Map();
  let lastMessageKey = '';
  const typedQueue = [];

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

  function addSourceCards() {
    if (!sources.size) return;
    const node = document.createElement('div');
    node.className = 'msg assistant';
    const title = document.createElement('div');
    title.textContent = 'Google検索の出典';
    title.style.fontWeight = '700';
    title.style.fontSize = '12px';
    node.appendChild(title);
    let count = 0;
    for (const item of sources.values()) {
      if (count++ >= 4) break;
      const link = document.createElement('a');
      link.href = item.uri;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = item.title || item.uri;
      link.style.display = 'block';
      link.style.fontSize = '12px';
      link.style.marginTop = '4px';
      node.appendChild(link);
    }
    chat.appendChild(node);
    node.scrollIntoView({ block: 'nearest' });
  }

  function mergeTranscript(base, fragment) {
    const text = String(fragment || '').trim();
    if (!text) return base;
    if (!base) return text;
    if (base === text || base.endsWith(text)) return base;
    if (text.startsWith(base)) return text;
    if (/^[、。！？,.!?]/.test(text)) return base + text;
    return base + (base.endsWith(' ') ? '' : ' ') + text;
  }

  function scheduleTranscriptFinalization() {
    if (!turnCompleteSeen) return;
    clearTimeout(transcriptTimer);
    transcriptTimer = setTimeout(() => {
      transcriptTimer = null;
      if (!typedTurn && inputTranscript.trim()) addMessage('user', inputTranscript);
      if (outputTranscript.trim()) addMessage('assistant', outputTranscript);
      addSourceCards();
      inputTranscript = '';
      outputTranscript = '';
      typedTurn = false;
      sources.clear();
      turnCompleteSeen = false;
    }, TRANSCRIPT_SETTLE_MS);
  }

  function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + 0x8000)));
    }
    return btoa(binary);
  }

  function pcmBase64(samples) {
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      pcm[i] = s < 0 ? s * 32768 : s * 32767;
    }
    return bytesToBase64(new Uint8Array(pcm.buffer));
  }

  function decodePcm(base64) {
    const binary = atob(String(base64 || ''));
    const out = new Float32Array(Math.floor(binary.length / 2));
    for (let i = 0; i < out.length; i++) {
      let v = (binary.charCodeAt(i * 2) & 255) | ((binary.charCodeAt(i * 2 + 1) & 255) << 8);
      if (v & 0x8000) v -= 0x10000;
      out[i] = v / 32768;
    }
    return out;
  }

  function rms(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / Math.max(1, samples.length));
  }

  function send(message) {
    if (!setupReady || !ws || ws.readyState !== WebSocket.OPEN) return false;
    try { ws.send(JSON.stringify(message)); return true; } catch { return false; }
  }

  async function ensureAudioContext() {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    if (audioContext.state !== 'running') await audioContext.resume().catch(() => {});
    return audioContext;
  }

  function endMicStream() {
    if (!localSpeaking) return;
    send({ realtimeInput: { audioStreamEnd: true } });
    localSpeaking = false;
    loudFrames = 0;
    silenceMs = 0;
    preRoll = [];
    setStatus('考えています…');
  }

  function sendAudioFrame(samples) {
    return send({ realtimeInput: { audio: { data: pcmBase64(samples), mimeType: 'audio/pcm;rate=' + INPUT_RATE } } });
  }

  function stopPlayback(interrupted = false) {
    playbackEpoch += 1;
    for (const source of playbackSources) {
      try { source.stop(); } catch {}
      try { source.disconnect(); } catch {}
    }
    playbackSources.clear();
    playbackCursor = audioContext?.currentTime || 0;
    modelSpeaking = false;
    if (interrupted) setStatus('割り込みを聞いています…');
  }

  function playbackMayBeDone(epoch) {
    if (epoch !== playbackEpoch || !modelTurnComplete || playbackSources.size) return;
    modelSpeaking = false;
    bargeFrames = 0;
    bargePreRoll = [];
    if (micEnabled) setStatus('聞いています');
  }

  async function playModelAudio(data) {
    const ctx = await ensureAudioContext();
    const samples = decodePcm(data);
    if (!samples.length) return;
    if (!modelSpeaking) {
      modelSpeaking = true;
      modelTurnComplete = false;
      localSpeaking = false;
      preRoll = [];
      loudFrames = 0;
      silenceMs = 0;
      setStatus('Geminiが話しています。途中で割り込めます。');
    }
    const buffer = ctx.createBuffer(1, samples.length, OUTPUT_RATE);
    buffer.copyToChannel(samples, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const epoch = playbackEpoch;
    const startAt = Math.max(ctx.currentTime + 0.02, playbackCursor || 0);
    playbackCursor = startAt + buffer.duration;
    playbackSources.add(source);
    source.onended = () => {
      playbackSources.delete(source);
      try { source.disconnect(); } catch {}
      playbackMayBeDone(epoch);
    };
    source.start(startAt);
  }

  function collectSources(metadata) {
    for (const chunk of metadata?.groundingChunks || []) {
      if (!chunk?.web?.uri) continue;
      sources.set(chunk.web.uri, { uri: chunk.web.uri, title: String(chunk.web.title || '').trim() });
    }
    if (sources.size) setStatus('Google検索で確認した情報から回答しています…');
  }

  async function inspectScreen(query) {
    const video = document.getElementById('screenVideo');
    const overlay = document.getElementById('overlay');
    const targetNote = document.getElementById('targetNote');
    const screenHint = document.getElementById('screenHint');
    if (!video?.srcObject || !video.videoWidth || !video.videoHeight) {
      if (screenHint) screenHint.textContent = 'Geminiが画面確認を必要としています。画面共有を開始してください。';
      return { available: false, reason: 'screen_share_required' };
    }
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
      if (!response.ok) throw new Error(result.error || 'screen analysis failed');
      if (result.found && overlay) {
        const x = Math.max(25, Math.min(975, Number(result.x) || 500));
        const y = Math.max(25, Math.min(975, Number(result.y) || 500));
        const sx = x < 500 ? Math.min(950, x + 190) : Math.max(50, x - 190);
        const sy = y < 300 ? Math.min(950, y + 165) : Math.max(50, y - 165);
        overlay.innerHTML = '<defs><marker id="gemArrow" markerWidth="40" markerHeight="40" refX="34" refY="20" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L0,40 L40,20 z" fill="#ff3b30"></path></marker></defs><line x1="' + sx + '" y1="' + sy + '" x2="' + x + '" y2="' + y + '" stroke="#ff3b30" stroke-width="16" stroke-linecap="round" marker-end="url(#gemArrow)"></line><circle cx="' + x + '" cy="' + y + '" r="34" fill="none" stroke="#ff3b30" stroke-width="13"></circle>';
        if (targetNote) targetNote.textContent = '→ ' + (result.label || 'ここです');
      }
      if (screenHint) screenHint.textContent = result.found ? 'Geminiが対象を確認しました。' : (result.note || '対象を特定できませんでした。');
      return { available: true, found: Boolean(result.found), x: result.x, y: result.y, label: result.label || '', note: result.note || '' };
    } catch (error) {
      return { available: false, reason: String(error?.message || error) };
    }
  }

  async function handleToolCall(toolCall) {
    const functionResponses = [];
    for (const call of toolCall?.functionCalls || []) {
      let result;
      if (call.name === 'inspect_current_screen') {
        setStatus('画面を確認しています…');
        result = await inspectScreen(call.args?.query);
      } else result = { error: 'unsupported_tool' };
      functionResponses.push({ id: call.id, name: call.name, response: { result } });
    }
    if (functionResponses.length) send({ toolResponse: { functionResponses } });
  }

  async function handleMessage(message) {
    if (message.setupComplete) {
      setupReady = true;
      reconnectFailures = 0;
      resolveSetup?.();
      resolveSetup = rejectSetup = null;
      setStatus(micEnabled ? '聞いています' : 'Gemini Live 接続済み');
      flushTypedQueue();
      return;
    }

    const update = message.sessionResumptionUpdate;
    if (update?.resumable && update.newHandle) {
      resumeHandle = update.newHandle;
      sessionStorage.setItem(RESUME_KEY, resumeHandle);
    }

    if (message.goAway) {
      setStatus('会話を維持したまま接続を更新します…');
      setTimeout(() => { try { ws?.close(1000, 'resume'); } catch {} }, 200);
    }

    if (message.toolCall) await handleToolCall(message.toolCall);

    const content = message.serverContent;
    if (!content) return;

    if (content.interrupted) {
      stopPlayback(true);
      outputTranscript = '';
      sources.clear();
      modelTurnComplete = true;
      turnCompleteSeen = true;
      scheduleTranscriptFinalization();
    }

    if (content.inputTranscription?.text) {
      inputTranscript = mergeTranscript(inputTranscript, content.inputTranscription.text);
      if (!typedTurn) setStatus('聞き取り: ' + inputTranscript);
      scheduleTranscriptFinalization();
    }
    if (content.outputTranscription?.text) {
      outputTranscript = mergeTranscript(outputTranscript, content.outputTranscription.text);
      scheduleTranscriptFinalization();
    }
    if (content.groundingMetadata) {
      collectSources(content.groundingMetadata);
      scheduleTranscriptFinalization();
    }

    for (const part of content.modelTurn?.parts || []) {
      if (part.inlineData?.data && /audio\/pcm/i.test(part.inlineData.mimeType || 'audio/pcm')) {
        await playModelAudio(part.inlineData.data);
      }
    }

    if (content.turnComplete) {
      modelTurnComplete = true;
      turnCompleteSeen = true;
      scheduleTranscriptFinalization();
      playbackMayBeDone(playbackEpoch);
    }
  }

  function setupMessage() {
    return {
      setup: {
        model: 'models/' + MODEL,
        generationConfig: {
          responseModalities: ['AUDIO'],
          temperature: 0.28,
          topP: 0.9,
          thinkingConfig: { thinkingLevel: 'MINIMAL' },
          speechConfig: { languageCode: 'ja-JP' }
        },
        systemInstruction: { parts: [{ text: SYSTEM }] },
        tools: [
          { googleSearch: {} },
          { functionDeclarations: [{
            name: 'inspect_current_screen',
            description: '現在共有されているPC画面を確認する。画面上の表示・ボタン・エラー・操作位置に答える必要がある時だけ使う。',
            parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' } }, required: ['query'] }
          }] }
        ],
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
            endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
            prefixPaddingMs: 120,
            silenceDurationMs: 800
          },
          activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
          turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY'
        },
        sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
        contextWindowCompression: { slidingWindow: {} },
        inputAudioTranscription: {},
        outputAudioTranscription: {}
      }
    };
  }

  async function fetchToken() {
    const response = await fetch(TOKEN_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok || !data.available || !data.token) {
      const error = new Error(data.reason || ('token HTTP ' + response.status));
      error.code = response.status === 503 ? 'not_configured' : 'token_failed';
      throw error;
    }
    return data;
  }

  async function connect() {
    if (legacy) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return setupPromise;
    clearTimeout(reconnectTimer);
    setupReady = false;
    const token = await fetchToken();
    setupPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Gemini Live setup timeout')), SETUP_TIMEOUT_MS);
      resolveSetup = () => { clearTimeout(timer); resolve(); };
      rejectSetup = (error) => { clearTimeout(timer); reject(error); };
    });
    const socket = new WebSocket(token.endpoint + '?access_token=' + encodeURIComponent(token.token));
    ws = socket;
    socket.onopen = () => {
      try { socket.send(JSON.stringify(setupMessage())); } catch (error) { rejectSetup?.(error); }
    };
    socket.onmessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      void handleMessage(message);
    };
    socket.onerror = () => { if (!setupReady) rejectSetup?.(new Error('Gemini Live WebSocket error')); };
    socket.onclose = (event) => {
      const wasReady = setupReady;
      setupReady = false;
      if (!wasReady) rejectSetup?.(new Error('Gemini Live closed before setup: ' + event.code));
      if (!keepConnected || legacy) return;
      reconnectFailures += 1;
      if (event.code === 1007) {
        resumeHandle = '';
        sessionStorage.removeItem(RESUME_KEY);
      }
      if (reconnectFailures >= 5) { void activateLegacy('Gemini Liveの再接続に失敗しました。'); return; }
      setStatus('Gemini Live 再接続中…');
      reconnectTimer = setTimeout(() => connect().catch((e) => {
        if (e?.code === 'not_configured') void activateLegacy('Gemini APIキーが未設定です。');
      }), 400);
    };
    return setupPromise;
  }

  const WORKLET = "class TalkSysGeminiCapture extends AudioWorkletProcessor{constructor(){super();this.b=[];this.r=sampleRate/16000}process(i){const x=i[0];if(!x||!x[0])return true;const d=x[0];for(let p=0;p<d.length;p+=this.r){const n=Math.floor(p),f=p-n;this.b.push(n+1<d.length?d[n]*(1-f)+d[n+1]*f:(d[n]||0))}while(this.b.length>=640){const a=new Float32Array(this.b.splice(0,640));this.port.postMessage(a,[a.buffer])}return true}}registerProcessor('talksys-gemini-capture',TalkSysGeminiCapture);";

  function handleNormalMic(samples, level) {
    const startThreshold = Math.max(0.012, Math.min(0.06, noiseFloor * 2.6));
    const endThreshold = Math.max(0.008, Math.min(startThreshold * 0.7, noiseFloor * 1.7));

    if (!localSpeaking) {
      if (level < 0.025) noiseFloor = noiseFloor * 0.98 + level * 0.02;
      preRoll.push(new Float32Array(samples));
      if (preRoll.length > PREROLL_FRAMES) preRoll.shift();
      if (level >= startThreshold) loudFrames += 1;
      else loudFrames = 0;
      if (loudFrames < START_FRAMES) return;
      localSpeaking = true;
      silenceMs = 0;
      for (const frame of preRoll) sendAudioFrame(frame);
      preRoll = [];
      setStatus('話しています…');
      return;
    }

    sendAudioFrame(samples);
    if (level <= endThreshold) silenceMs += 40;
    else silenceMs = 0;
    if (silenceMs >= END_SILENCE_MS) endMicStream();
  }

  function handleBargeMic(samples, level) {
    bargePreRoll.push(new Float32Array(samples));
    if (bargePreRoll.length > PREROLL_FRAMES) bargePreRoll.shift();
    const threshold = Math.max(BARGE_MIN_RMS, Math.min(0.13, noiseFloor * 4.2));
    if (level >= threshold) bargeFrames += 1;
    else bargeFrames = Math.max(0, bargeFrames - 1);
    if (bargeFrames < BARGE_FRAMES) return;
    stopPlayback(true);
    modelTurnComplete = true;
    localSpeaking = true;
    silenceMs = 0;
    loudFrames = START_FRAMES;
    for (const frame of bargePreRoll) sendAudioFrame(frame);
    bargePreRoll = [];
    bargeFrames = 0;
  }

  async function ensureMic() {
    if (micReady && micStream && micWorklet) return;
    const ctx = await ensureAudioContext();
    micStream = await navigator.mediaDevices.getUserMedia({ audio: {
      channelCount: 1,
      sampleRate: { ideal: 48000 },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false
    }});
    const module = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    try { await ctx.audioWorklet.addModule(module); } finally { URL.revokeObjectURL(module); }
    micSource = ctx.createMediaStreamSource(micStream);
    micWorklet = new AudioWorkletNode(ctx, 'talksys-gemini-capture');
    micWorklet.port.onmessage = (event) => {
      if (!micEnabled || !setupReady) return;
      const samples = event.data instanceof Float32Array ? event.data : new Float32Array(event.data);
      const level = rms(samples);
      micFrames += 1;
      if (modelSpeaking) handleBargeMic(samples, level);
      else handleNormalMic(samples, level);
    };
    micSource.connect(micWorklet);
    micWorklet.connect(ctx.destination);
    micReady = true;
  }

  async function startVoice(auto = false) {
    if (legacy) return;
    voice.disabled = true;
    setStatus('Gemini Liveとマイクを準備しています…');
    try {
      await Promise.all([connect(), ensureMic()]);
      micEnabled = true;
      voice.disabled = false;
      voice.classList.add('active');
      voice.textContent = '● Gemini Live 通話中';
      setStatus('聞いています');
    } catch (error) {
      voice.disabled = false;
      if (error?.code === 'not_configured') { await activateLegacy('Gemini APIキーが未設定です。'); return; }
      if (auto && (error?.name === 'NotAllowedError' || error?.name === 'SecurityError')) {
        voice.textContent = '☎ Gemini Liveを開始';
        setStatus('通話を始めるにはボタンを押してマイクを許可してください。');
        return;
      }
      voice.textContent = '☎ Gemini Liveを再接続';
      setStatus('Gemini Live開始エラー: ' + String(error?.message || error));
    }
  }

  function stopVoice() {
    if (localSpeaking) endMicStream();
    micEnabled = false;
    stopPlayback(false);
    micStream?.getTracks().forEach((track) => track.stop());
    micStream = null;
    micReady = false;
    try { micSource?.disconnect(); } catch {}
    try { micWorklet?.disconnect(); } catch {}
    micSource = micWorklet = null;
    voice.classList.remove('active');
    voice.textContent = '☎ Gemini Liveを開始';
    setStatus('Gemini Live 接続済み（マイク停止）');
  }

  function flushTypedQueue() {
    if (!setupReady) return;
    while (typedQueue.length) {
      const text = typedQueue.shift();
      send({ realtimeInput: { text } });
    }
  }

  async function submitTyped(event) {
    event?.preventDefault();
    event?.stopImmediatePropagation();
    const value = String(input?.value || '').trim();
    if (!value || legacy) return;
    if (input) input.value = '';
    addMessage('user', value);
    typedTurn = true;
    inputTranscript = '';
    outputTranscript = '';
    sources.clear();
    turnCompleteSeen = false;
    clearTimeout(transcriptTimer);
    stopPlayback(true);
    setStatus('Geminiが考えています…');
    if (sendButton) sendButton.disabled = true;
    try {
      if (!setupReady) await connect();
      typedQueue.push(value);
      flushTypedQueue();
    } catch (error) {
      if (error?.code === 'not_configured') await activateLegacy('Gemini APIキーが未設定です。');
      else addMessage('assistant', 'Gemini Live接続エラー: ' + String(error?.message || error));
    } finally {
      if (sendButton) sendButton.disabled = false;
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
    if (legacy) return;
    legacy = true;
    keepConnected = false;
    clearTimeout(reconnectTimer);
    try { ws?.close(); } catch {}
    ws = null;
    stopVoice();
    window.__talksysGeminiLivePrimary = false;
    setStatus((reason || 'Gemini Liveを利用できません。') + ' 従来音声へ切り替えます。');
    const v = document.getElementById('voice');
    if (v) v.replaceWith(v.cloneNode(true));
    const f = document.getElementById('form');
    if (f) f.replaceWith(f.cloneNode(true));
    try {
      await loadScript('/voice-marker-bridge.js');
      await loadScript('/realtime-voice.js');
      await loadScript('/voice-fallback.js');
    } catch (error) {
      setStatus('フォールバック音声も起動できません: ' + String(error?.message || error));
    }
  }

  voice.textContent = '… Gemini Live接続中';
  voice.addEventListener('click', () => { if (micEnabled) stopVoice(); else void startVoice(false); });
  form.addEventListener('submit', submitTyped, true);
  input?.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) void submitTyped(event); }, true);

  window.addEventListener('beforeunload', () => {
    keepConnected = false;
    if (localSpeaking) endMicStream();
    stopPlayback(false);
    try { ws?.close(1000, 'page_unload'); } catch {}
    micStream?.getTracks().forEach((track) => track.stop());
  }, { once: true });

  // Preconnect removes most of the first-turn handshake. Mic autostart may still
  // require one user gesture depending on browser permission/autoplay policy.
  connect().then(() => startVoice(true)).catch((error) => {
    if (error?.code === 'not_configured') void activateLegacy('Gemini APIキーが未設定です。');
    else { voice.textContent = '☎ Gemini Liveを再接続'; setStatus('Gemini Live接続エラー: ' + String(error?.message || error)); }
  });
})();
`;
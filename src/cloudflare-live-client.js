export const CLOUDFLARE_LIVE_CLIENT = String.raw`(() => {
  'use strict';

  const AGENT_PATH = '/agents/talk-sys-voice-agent/default';
  const CHUNK_SAMPLES = 640; // 40 ms at 16 kHz
  const BARGE_THRESHOLD = 0.035;
  const BARGE_FRAMES = 3;
  const DEVICE_TTS_GUARD_MS = 350;
  const CALL_CONNECT_TIMEOUT_MS = 10000;

  const originalVoice = document.getElementById('voice');
  const form = document.getElementById('form');
  const input = document.getElementById('input');
  const status = document.getElementById('status');
  const chat = document.getElementById('chat');
  if (!originalVoice || !form || !input || !chat) return;

  const voice = originalVoice.cloneNode(true);
  voice.disabled = false;
  originalVoice.replaceWith(voice);

  let socket = null;
  let welcomed = false;
  let desiredCall = false;
  let inCall = false;
  let manualStop = false;
  let reconnectTimer = null;
  let callConnectTimer = null;
  let audioContext = null;
  let mediaStream = null;
  let mediaSource = null;
  let workletNode = null;
  let micReady = false;
  let serverStatus = 'idle';
  let playbackQueue = [];
  let playbackSource = null;
  let playing = false;
  let bargeFrames = 0;
  let pendingText = [];
  let streamNode = null;
  let streamText = '';
  let currentAssistantText = '';
  let lastAdded = '';
  let serverAudioThisTurn = false;
  let ttsFailedThisTurn = false;
  let typedVoiceOutput = false;
  let lastSearchWaitPhrase = '';
  let deviceSpeaking = false;
  let deviceGuardUntil = 0;
  let deviceUtterance = null;

  function setStatus(text) { if (status) status.textContent = text || ''; }

  function addMessage(role, text) {
    const value = String(text || '').trim();
    if (!value) return;
    const key = role + ':' + value;
    if (key === lastAdded) return;
    lastAdded = key;
    const node = document.createElement('div');
    node.className = 'msg ' + role;
    node.textContent = value;
    chat.appendChild(node);
    node.scrollIntoView({ block: 'nearest' });
  }

  function beginAssistantStream() {
    if (streamNode) return;
    streamText = '';
    currentAssistantText = '';
    serverAudioThisTurn = false;
    ttsFailedThisTurn = false;
    streamNode = document.createElement('div');
    streamNode.className = 'msg assistant';
    chat.appendChild(streamNode);
    streamNode.scrollIntoView({ block: 'nearest' });
  }

  function appendAssistantDelta(delta) {
    if (!delta) return;
    beginAssistantStream();
    streamText += delta;
    currentAssistantText = streamText;
    streamNode.textContent = streamText;
    streamNode.scrollIntoView({ block: 'nearest' });
  }

  function finishAssistantStream(finalText) {
    const value = String(finalText || streamText || '').trim();
    currentAssistantText = value;
    if (streamNode) {
      streamNode.textContent = value;
      streamNode = null;
      streamText = '';
      if (value) lastAdded = 'assistant:' + value;
    } else if (value) addMessage('assistant', value);
    if ((desiredCall || typedVoiceOutput) && ttsFailedThisTurn && !serverAudioThisTurn && value) setTimeout(() => speakJapaneseFallback(value), 120);
  }

  function setVoiceUi() {
    voice.classList.toggle('active', desiredCall && inCall);
    voice.textContent = desiredCall ? (inCall ? '● 通話中' : '… 接続中') : '☎ リアルタイム通話';
  }

  function wsUrl() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return protocol + '//' + location.host + AGENT_PATH;
  }

  function sendJson(data) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(data));
    return true;
  }

  function flushText() {
    if (!welcomed || !socket || socket.readyState !== WebSocket.OPEN) return;
    while (pendingText.length) sendJson({ type: 'text_message', text: pendingText.shift() });
  }

  function floatToPcm(samples) {
    const buffer = new ArrayBuffer(samples.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < samples.length; i += 1) {
      const value = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
    }
    return buffer;
  }

  function rms(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
    return Math.sqrt(sum / Math.max(1, samples.length));
  }

  function pickJapaneseVoice() {
    if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) return null;
    const voices = speechSynthesis.getVoices().filter((item) => /^ja(?:-|_)/i.test(item.lang || ''));
    if (!voices.length) return null;
    return voices.find((item) => /Google|Microsoft|Nanami|Keita|Kyoko|Otoya|Japanese/i.test(item.name || '')) || voices[0];
  }

  function cancelDeviceSpeech(interrupted = false) {
    if (!deviceSpeaking && !deviceUtterance) return;
    try { speechSynthesis.cancel(); } catch {}
    deviceSpeaking = false;
    deviceUtterance = null;
    deviceGuardUntil = Date.now() + DEVICE_TTS_GUARD_MS;
    if (interrupted) sendJson({ type: 'interrupt' });
  }

  function speakJapaneseFallback(text) {
    const value = String(text || '').replace(/https?:\/\/\S+/g, 'リンク').replace(/[*_#>\x60~]/g, '').replace(/\s+/g, ' ').trim();
    if (!(desiredCall || typedVoiceOutput) || !value || serverAudioThisTurn || deviceSpeaking) return false;
    const selected = pickJapaneseVoice();
    if (!selected) {
      setStatus('サーバー音声に失敗しました。端末に日本語音声がありません。');
      return false;
    }
    try {
      speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(value);
      utterance.voice = selected;
      utterance.lang = selected.lang || 'ja-JP';
      utterance.rate = 0.98;
      utterance.pitch = 1;
      utterance.volume = 1;
      deviceUtterance = utterance;
      utterance.onstart = () => {
        if (deviceUtterance !== utterance) return;
        deviceSpeaking = true;
        setStatus('AIが話しています。途中で割り込めます。');
      };
      const done = () => {
        if (deviceUtterance !== utterance) return;
        deviceUtterance = null;
        deviceSpeaking = false;
        deviceGuardUntil = Date.now() + DEVICE_TTS_GUARD_MS;
        if (desiredCall) setTimeout(() => { if (!deviceSpeaking && desiredCall) setStatus('聞いています'); }, DEVICE_TTS_GUARD_MS);
      };
      utterance.onend = done;
      utterance.onerror = done;
      speechSynthesis.speak(utterance);
      return true;
    } catch {
      deviceSpeaking = false;
      deviceUtterance = null;
      return false;
    }
  }

  function stopPlayback(interruptServer = false) {
    playbackQueue = [];
    playing = false;
    if (playbackSource) {
      try { playbackSource.stop(); } catch {}
      try { playbackSource.disconnect(); } catch {}
      playbackSource = null;
    }
    if (deviceSpeaking || deviceUtterance) cancelDeviceSpeech(false);
    if (interruptServer) sendJson({ type: 'interrupt' });
  }

  async function ensurePlaybackAudio() {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return false;
    audioContext = audioContext || new AudioCtor({ sampleRate: 48000 });
    if (audioContext.state !== 'running') await audioContext.resume().catch(() => {});
    return audioContext.state === 'running';
  }

  async function playNext() {
    if (playing || !playbackQueue.length || !audioContext) return;
    playing = true;
    const bytes = playbackQueue.shift();
    try {
      if (audioContext.state !== 'running') await audioContext.resume();
      const decoded = await audioContext.decodeAudioData(bytes.slice(0));
      const source = audioContext.createBufferSource();
      source.buffer = decoded;
      const compressor = audioContext.createDynamicsCompressor();
      compressor.threshold.value = -24;
      compressor.knee.value = 18;
      compressor.ratio.value = 3;
      compressor.attack.value = 0.006;
      compressor.release.value = 0.18;
      const speechGain = audioContext.createGain();
      speechGain.gain.value = 1.12;
      source.connect(compressor);
      compressor.connect(speechGain);
      speechGain.connect(audioContext.destination);
      playbackSource = source;
      source.onended = () => {
        if (playbackSource === source) playbackSource = null;
        playing = false;
        bargeFrames = 0;
        playNext();
      };
      source.start();
    } catch {
      playing = false;
      setStatus('サーバー音声の再生に失敗しました。');
      ttsFailedThisTurn = true;
      playNext();
    }
  }

  function queueAudio(buffer) {
    if (!(desiredCall || typedVoiceOutput)) {
      serverAudioThisTurn = true;
      ttsFailedThisTurn = false;
      return;
    }
    serverAudioThisTurn = true;
    ttsFailedThisTurn = false;
    if (deviceSpeaking || deviceUtterance) cancelDeviceSpeech(false);
    playbackQueue.push(buffer);
    void ensurePlaybackAudio().then(() => playNext());
  }

  const WORKLET = "class TalkSysCF18Capture extends AudioWorkletProcessor{constructor(){super();this.b=[];this.r=sampleRate/16000}process(inputs){const i=inputs[0];if(!i||!i[0])return true;const d=i[0];for(let n=0;n<d.length;n+=this.r){const a=Math.floor(n),f=n-a;this.b.push(a+1<d.length?d[a]*(1-f)+d[a+1]*f:d[a]||0)}while(this.b.length>=640){const x=new Float32Array(this.b.splice(0,640));this.port.postMessage(x,[x.buffer])}return true}}registerProcessor('talksys-cf18-capture',TalkSysCF18Capture);";

  async function ensureAudio() {
    if (!navigator.mediaDevices?.getUserMedia) {
      const error = new Error('microphone API unavailable');
      error.name = 'NotSupportedError';
      throw error;
    }
    if (micReady && mediaStream && audioContext) {
      if (audioContext.state !== 'running') await audioContext.resume().catch(() => {});
      return;
    }
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: { ideal: 48000 },
      },
    });
    audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    try { await audioContext.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    mediaSource = audioContext.createMediaStreamSource(mediaStream);
    workletNode = new AudioWorkletNode(audioContext, 'talksys-cf18-capture');
    workletNode.port.onmessage = (event) => {
      const samples = event.data instanceof Float32Array ? event.data : new Float32Array(event.data);
      const level = rms(samples);
      const assistantSpeaking = playing || serverStatus === 'speaking' || deviceSpeaking || Date.now() < deviceGuardUntil;
      if (assistantSpeaking) {
        if (level >= BARGE_THRESHOLD) bargeFrames += 1;
        else bargeFrames = Math.max(0, bargeFrames - 1);
        if (bargeFrames < BARGE_FRAMES) return; // Never send the assistant's own audio to STT.
        bargeFrames = 0;
        stopPlayback(true);
        cancelDeviceSpeech(false);
        deviceGuardUntil = 0;
        setStatus('割り込みを聞いています…');
        sendJson({ type: 'start_of_speech' });
      }
      if (inCall && socket?.readyState === WebSocket.OPEN) socket.send(floatToPcm(samples));
    };
    mediaSource.connect(workletNode);
    workletNode.connect(audioContext.destination);
    await audioContext.resume().catch(() => {});
    micReady = true;
  }

  function clearCallConnectTimeout() {
    if (!callConnectTimer) return;
    clearTimeout(callConnectTimer);
    callConnectTimer = null;
  }

  function armCallConnectTimeout() {
    clearCallConnectTimeout();
    callConnectTimer = setTimeout(() => {
      callConnectTimer = null;
      if (!desiredCall || inCall) return;
      manualStop = true;
      desiredCall = false;
      inCall = false;
      mediaStream?.getTracks().forEach((track) => track.stop());
      mediaStream = null;
      micReady = false;
      try { mediaSource?.disconnect(); } catch {}
      try { workletNode?.disconnect(); } catch {}
      mediaSource = null;
      workletNode = null;
      setVoiceUi();
      setStatus('接続が完了しませんでした。通信状態を確認して、もう一度通話ボタンを押してください。');
    }, CALL_CONNECT_TIMEOUT_MS);
  }

  function maybeStartCall() {
    if (!desiredCall || !welcomed || !micReady || inCall) return;
    sendJson({ type: 'start_call', preferred_format: 'mp3' });
  }

  function handleTtsError(message) {
    if (!/tts|speech|音声合成/i.test(String(message || ''))) return false;
    ttsFailedThisTurn = true;
    if (currentAssistantText && !serverAudioThisTurn) setTimeout(() => speakJapaneseFallback(currentAssistantText), 180);
    return true;
  }

  function connectSocket() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    clearTimeout(reconnectTimer);
    welcomed = false;
    socket = new WebSocket(wsUrl());
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => sendJson({ type: 'hello', protocol_version: 1 });
    socket.onmessage = async (event) => {
      if (event.data instanceof ArrayBuffer) { queueAudio(event.data); return; }
      if (event.data instanceof Blob) { queueAudio(await event.data.arrayBuffer()); return; }
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.type === 'welcome') {
        welcomed = true;
        flushText();
        maybeStartCall();
        return;
      }
      if (data.type === 'status') {
        serverStatus = data.status || 'idle';
        if (serverStatus === 'listening') {
          if (desiredCall) {
            inCall = true;
            clearCallConnectTimeout();
          }
          setStatus(desiredCall ? '聞いています' : '');
        } else if (serverStatus === 'thinking') setStatus('考えています…');
        else if (serverStatus === 'speaking') setStatus((desiredCall || typedVoiceOutput) ? 'AIが話しています…' : '文字で回答しています…');
        else if (serverStatus === 'idle') inCall = false;
        setVoiceUi();
        return;
      }
      if (data.type === 'transcript_interim') { if (data.text) setStatus('聞き取り: ' + data.text); return; }
      if (data.type === 'transcript_start' && data.role === 'assistant') { beginAssistantStream(); return; }
      if (data.type === 'transcript_delta') { appendAssistantDelta(String(data.text || '')); return; }
      if (data.type === 'transcript_end') { finishAssistantStream(data.text); return; }
      if (data.type === 'transcript' && data.text) {
        if (data.role === 'assistant') finishAssistantStream(data.text);
        else addMessage('user', data.text);
        return;
      }
      if (data.type === 'playback_interrupt') { stopPlayback(false); return; }
      if (data.type === 'search_status') {
        if (data.phase === 'planning') {
          lastSearchWaitPhrase = '';
          setStatus('検索内容を確認しています…');
        } else if (data.phase === 'searching') {
          const phrase = String(data.waitPhrase || '').trim();
          setStatus(phrase || '複数の情報源を確認しています…');
          if (phrase && phrase !== lastSearchWaitPhrase && (desiredCall || typedVoiceOutput)) {
            lastSearchWaitPhrase = phrase;
            setTimeout(() => speakJapaneseFallback(phrase), 20);
          }
        } else {
          setStatus('検索結果を検証して答えています…');
        }
        return;
      }
      if (data.type === 'completion_outcome' && data.code === 'model_error') setStatus('AI応答を再試行してください。');
      if (data.type === 'error') {
        if (!handleTtsError(data.message)) setStatus('音声エラー: ' + (data.message || '不明なエラー'));
      }
    };
    socket.onclose = () => {
      welcomed = false;
      inCall = false;
      setVoiceUi();
      if ((desiredCall || pendingText.length) && !manualStop) {
        setStatus('再接続中…');
        reconnectTimer = setTimeout(connectSocket, 650);
      }
    };
    socket.onerror = () => setStatus('リアルタイム接続を再確認しています…');
  }

  async function startCall() {
    manualStop = false;
    desiredCall = true;
    setVoiceUi();
    try {
      setStatus('マイクを準備しています…');
      await ensureAudio();
      armCallConnectTimeout();
      connectSocket();
      maybeStartCall();
    } catch (error) {
      clearCallConnectTimeout();
      desiredCall = false;
      setVoiceUi();
      const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
      setStatus(denied ? 'マイクを許可してから通話ボタンを押してください。' : 'マイクを開始できませんでした。');
    }
  }

  function endCall() {
    clearCallConnectTimeout();
    manualStop = true;
    desiredCall = false;
    if (inCall) sendJson({ type: 'end_call' });
    inCall = false;
    stopPlayback(false);
    cancelDeviceSpeech(false);
    mediaStream?.getTracks().forEach((track) => track.stop());
    mediaStream = null;
    micReady = false;
    try { mediaSource?.disconnect(); } catch {}
    try { workletNode?.disconnect(); } catch {}
    mediaSource = null;
    workletNode = null;
    setStatus('');
    setVoiceUi();
  }

  function submitText(event) {
    if (event) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    const value = String(input.value || '').trim();
    if (!value) return false;
    input.value = '';
    stopPlayback(true);
    typedVoiceOutput = true;
    serverAudioThisTurn = false;
    ttsFailedThisTurn = false;
    lastSearchWaitPhrase = '';
    void ensurePlaybackAudio();
    addMessage('user', value);
    pendingText.push(value);
    manualStop = false;
    connectSocket();
    flushText();
    setStatus('発話として送信しました。音声と文字で返答します…');
    return false;
  }

  form.addEventListener('submit', submitText, true);
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    submitText(event);
  }, true);

  voice.addEventListener('click', () => desiredCall ? endCall() : startCall());
  if ('speechSynthesis' in window) {
    try { speechSynthesis.getVoices(); } catch {}
    window.addEventListener('voiceschanged', () => { try { speechSynthesis.getVoices(); } catch {} });
  }
  window.addEventListener('beforeunload', () => {
    manualStop = true;
    endCall();
    try { socket?.close(); } catch {}
  }, { once: true });

  setVoiceUi();
  connectSocket();
  setStatus('通話するか、文字で発話テストできます。');
})();
`;

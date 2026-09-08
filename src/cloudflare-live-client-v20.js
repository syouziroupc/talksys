export const CLOUDFLARE_LIVE_CLIENT_V20 = String.raw`(() => {
  'use strict';

  const AGENT_PATH = '/agents/talk-sys-voice-agent/default';
  const TARGET_RATE = 16000;
  const CHUNK_SAMPLES = 640; // 40 ms at 16 kHz
  const CALL_CONNECT_TIMEOUT_MS = 10000;
  const PLAYBACK_TAIL_GUARD_MS = 700;
  const MIC_ACTIVITY_THRESHOLD = 0.008;
  const MIC_ACTIVITY_FRAMES = 2;

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
  let captureNode = null;
  let captureSilenceGain = null;
  let micReady = false;
  let micActivityFrames = 0;
  let micLastActiveAt = 0;
  let micWatchTimer = null;
  let micSettings = {};

  let playbackQueue = [];
  let playbackSource = null;
  let playing = false;
  let playbackGuardUntil = 0;
  let pendingText = [];
  let streamNode = null;
  let streamText = '';
  let currentAssistantText = '';
  let lastAdded = '';
  let serverAudioThisTurn = false;
  let typedVoiceOutput = false;
  let lastSearchWaitPhrase = '';
  let deviceSpeaking = false;
  let deviceUtterance = null;
  let ttsFallbackTimer = null;

  function setStatus(text) { if (status) status.textContent = text || ''; }

  function dispatch(name, detail) {
    try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch {}
  }

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
    clearTimeout(ttsFallbackTimer);
    ttsFallbackTimer = null;
    streamText = '';
    currentAssistantText = '';
    serverAudioThisTurn = false;
    streamNode = document.createElement('div');
    streamNode.className = 'msg assistant';
    chat.appendChild(streamNode);
    streamNode.scrollIntoView({ block: 'nearest' });
  }

  function appendAssistantDelta(delta) {
    const value = String(delta || '');
    if (!value) return;
    beginAssistantStream();
    streamText += value;
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

    clearTimeout(ttsFallbackTimer);
    ttsFallbackTimer = null;
    if ((desiredCall || typedVoiceOutput) && !serverAudioThisTurn && value) {
      ttsFallbackTimer = setTimeout(() => {
        ttsFallbackTimer = null;
        if (!serverAudioThisTurn && !playing && !deviceSpeaking) speakJapaneseFallback(value);
      }, 500);
    }
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

  function assistantAudioActive() {
    return playing || deviceSpeaking || Date.now() < playbackGuardUntil;
  }

  function handleMicFrame(samples) {
    const level = rms(samples);
    if (level >= MIC_ACTIVITY_THRESHOLD) {
      micActivityFrames += 1;
      if (micActivityFrames >= MIC_ACTIVITY_FRAMES) micLastActiveAt = Date.now();
    } else {
      micActivityFrames = 0;
    }

    // Strict half-duplex while AI audio is audible. Browser AEC remains enabled,
    // but no far-end speaker audio is ever forwarded to STT. This trades barge-in
    // for reliable speakerphone behavior and prevents TalkSys from answering itself.
    if (assistantAudioActive()) return;
    if (inCall && socket?.readyState === WebSocket.OPEN) socket.send(floatToPcm(samples));
  }

  function pickJapaneseVoice() {
    if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) return null;
    const voices = speechSynthesis.getVoices().filter((item) => /^ja(?:-|_)/i.test(item.lang || ''));
    if (!voices.length) return null;
    return voices.find((item) => /Google|Microsoft|Nanami|Keita|Kyoko|Otoya|Japanese/i.test(item.name || '')) || voices[0];
  }

  function cancelDeviceSpeech() {
    try { speechSynthesis.cancel(); } catch {}
    deviceSpeaking = false;
    deviceUtterance = null;
    playbackGuardUntil = Date.now() + PLAYBACK_TAIL_GUARD_MS;
  }

  function speakJapaneseFallback(text) {
    const value = String(text || '')
      .replace(/https?:\/\/\S+/g, 'リンク')
      .replace(/[*_#>\x60~]/g, '')
      .replace(/[•●▪■◆◇▶▷→⇒]/g, '、')
      .replace(/\s+/g, ' ')
      .trim();
    if (!(desiredCall || typedVoiceOutput) || !value || serverAudioThisTurn || deviceSpeaking) return false;
    const selected = pickJapaneseVoice();
    if (!selected) return false;
    try {
      speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(value);
      utterance.voice = selected;
      utterance.lang = selected.lang || 'ja-JP';
      utterance.rate = 0.95;
      utterance.pitch = 1;
      utterance.volume = 1;
      deviceUtterance = utterance;
      utterance.onstart = () => {
        if (deviceUtterance !== utterance) return;
        deviceSpeaking = true;
        playbackGuardUntil = Number.POSITIVE_INFINITY;
        setStatus('AIが話しています…');
      };
      const done = () => {
        if (deviceUtterance !== utterance) return;
        deviceUtterance = null;
        deviceSpeaking = false;
        playbackGuardUntil = Date.now() + PLAYBACK_TAIL_GUARD_MS;
        if (desiredCall) setTimeout(() => {
          if (!assistantAudioActive() && desiredCall) setStatus('聞いています');
        }, PLAYBACK_TAIL_GUARD_MS);
      };
      utterance.onend = done;
      utterance.onerror = done;
      speechSynthesis.speak(utterance);
      return true;
    } catch {
      deviceSpeaking = false;
      deviceUtterance = null;
      playbackGuardUntil = Date.now() + PLAYBACK_TAIL_GUARD_MS;
      return false;
    }
  }

  function stopPlayback(interruptServer = false) {
    clearTimeout(ttsFallbackTimer);
    ttsFallbackTimer = null;
    playbackQueue = [];
    playing = false;
    if (playbackSource) {
      try { playbackSource.stop(); } catch {}
      try { playbackSource.disconnect(); } catch {}
      playbackSource = null;
    }
    if (deviceSpeaking || deviceUtterance) cancelDeviceSpeech();
    playbackGuardUntil = Date.now() + PLAYBACK_TAIL_GUARD_MS;
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
    playbackGuardUntil = Number.POSITIVE_INFINITY;
    const bytes = playbackQueue.shift();
    try {
      if (audioContext.state !== 'running') await audioContext.resume();
      const decoded = await audioContext.decodeAudioData(bytes.slice(0));
      const source = audioContext.createBufferSource();
      source.buffer = decoded;
      const highpass = audioContext.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 90;
      const presence = audioContext.createBiquadFilter();
      presence.type = 'peaking';
      presence.frequency.value = 2800;
      presence.Q.value = 0.9;
      presence.gain.value = 2.0;
      const compressor = audioContext.createDynamicsCompressor();
      compressor.threshold.value = -22;
      compressor.knee.value = 16;
      compressor.ratio.value = 2.6;
      compressor.attack.value = 0.006;
      compressor.release.value = 0.2;
      const gain = audioContext.createGain();
      gain.gain.value = 1.05;
      source.connect(highpass);
      highpass.connect(presence);
      presence.connect(compressor);
      compressor.connect(gain);
      gain.connect(audioContext.destination);
      playbackSource = source;
      source.onended = () => {
        if (playbackSource === source) playbackSource = null;
        playing = false;
        playbackGuardUntil = Date.now() + PLAYBACK_TAIL_GUARD_MS;
        if (playbackQueue.length) void playNext();
        else if (desiredCall) setTimeout(() => {
          if (!assistantAudioActive() && desiredCall) setStatus('聞いています');
        }, PLAYBACK_TAIL_GUARD_MS);
      };
      source.start();
    } catch {
      playing = false;
      playbackGuardUntil = Date.now() + PLAYBACK_TAIL_GUARD_MS;
      if (playbackQueue.length) void playNext();
    }
  }

  function queueAudio(buffer) {
    clearTimeout(ttsFallbackTimer);
    ttsFallbackTimer = null;
    serverAudioThisTurn = true;
    if (!(desiredCall || typedVoiceOutput)) return;
    if (deviceSpeaking || deviceUtterance) cancelDeviceSpeech();
    playbackQueue.push(buffer);
    void ensurePlaybackAudio().then(() => playNext());
  }

  function makeWorkletSource() {
    return "class TalkSysV20Capture extends AudioWorkletProcessor{constructor(){super();this.b=[];this.p=0;this.step=sampleRate/16000}process(inputs){const i=inputs[0];if(!i||!i[0])return true;const d=i[0];let p=this.p;while(p<d.length){const a=Math.floor(p),f=p-a;this.b.push(a+1<d.length?d[a]*(1-f)+d[a+1]*f:(d[a]||0));p+=this.step}this.p=p-d.length;while(this.b.length>=640){const x=new Float32Array(this.b.splice(0,640));this.port.postMessage(x,[x.buffer])}return true}}registerProcessor('talksys-v20-capture',TalkSysV20Capture);";
  }

  function connectCaptureSilently(node) {
    captureSilenceGain = audioContext.createGain();
    captureSilenceGain.gain.value = 0;
    node.connect(captureSilenceGain);
    captureSilenceGain.connect(audioContext.destination);
  }

  async function createWorkletCapture() {
    if (!audioContext?.audioWorklet || typeof AudioWorkletNode === 'undefined') return false;
    const url = URL.createObjectURL(new Blob([makeWorkletSource()], { type: 'text/javascript' }));
    try {
      await audioContext.audioWorklet.addModule(url);
    } catch {
      return false;
    } finally {
      URL.revokeObjectURL(url);
    }
    const node = new AudioWorkletNode(audioContext, 'talksys-v20-capture');
    node.port.onmessage = (event) => {
      const samples = event.data instanceof Float32Array ? event.data : new Float32Array(event.data);
      handleMicFrame(samples);
    };
    mediaSource.connect(node);
    connectCaptureSilently(node);
    captureNode = node;
    return true;
  }

  function createScriptProcessorCapture() {
    if (!audioContext?.createScriptProcessor) return false;
    const node = audioContext.createScriptProcessor(2048, 1, 1);
    const pending = [];
    let phase = 0;
    const step = audioContext.sampleRate / TARGET_RATE;
    node.onaudioprocess = (event) => {
      const inputData = event.inputBuffer?.getChannelData(0);
      if (!inputData) return;
      let p = phase;
      while (p < inputData.length) {
        const a = Math.floor(p);
        const f = p - a;
        pending.push(a + 1 < inputData.length ? inputData[a] * (1 - f) + inputData[a + 1] * f : (inputData[a] || 0));
        p += step;
      }
      phase = p - inputData.length;
      while (pending.length >= CHUNK_SAMPLES) handleMicFrame(new Float32Array(pending.splice(0, CHUNK_SAMPLES)));
    };
    mediaSource.connect(node);
    connectCaptureSilently(node);
    captureNode = node;
    return true;
  }

  function clearMicWatch() {
    if (micWatchTimer) clearTimeout(micWatchTimer);
    micWatchTimer = null;
  }

  function armMicWatch() {
    clearMicWatch();
    const baseline = Date.now();
    micWatchTimer = setTimeout(() => {
      micWatchTimer = null;
      if (!desiredCall || !micReady || assistantAudioActive()) return;
      if (micLastActiveAt < baseline) {
        setStatus('マイクは接続済みですが入力が小さいようです。端末のマイク権限と入力先を確認してください。');
      }
    }, 5000);
  }

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

    const supported = navigator.mediaDevices.getSupportedConstraints?.() || {};
    const constraints = { channelCount: 1 };
    if (supported.echoCancellation !== false) constraints.echoCancellation = true;
    if (supported.noiseSuppression) constraints.noiseSuppression = true;
    if (supported.autoGainControl) constraints.autoGainControl = true;
    if (supported.sampleRate) constraints.sampleRate = { ideal: 48000 };

    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
    const track = mediaStream.getAudioTracks()[0];
    if (!track || track.readyState !== 'live') throw new Error('microphone track unavailable');
    micSettings = track.getSettings?.() || {};

    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) throw new Error('AudioContext unavailable');
    audioContext = audioContext || new AudioCtor({ sampleRate: 48000 });
    await audioContext.resume().catch(() => {});
    if (audioContext.state !== 'running') throw new Error('AudioContext is suspended');

    mediaSource = audioContext.createMediaStreamSource(mediaStream);
    const workletOk = await createWorkletCapture();
    if (!workletOk && !createScriptProcessorCapture()) throw new Error('No microphone capture processor available');

    micReady = true;
    micLastActiveAt = Date.now();
    armMicWatch();
    dispatch('talksys-mic-ready', { settings: micSettings, capture: workletOk ? 'audio-worklet' : 'script-processor' });
  }

  function cleanupAudio() {
    clearMicWatch();
    try { mediaStream?.getTracks().forEach((track) => track.stop()); } catch {}
    try { mediaSource?.disconnect(); } catch {}
    try { captureNode?.disconnect(); } catch {}
    try { captureSilenceGain?.disconnect(); } catch {}
    mediaStream = null;
    mediaSource = null;
    captureNode = null;
    captureSilenceGain = null;
    micReady = false;
    micActivityFrames = 0;
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
      desiredCall = false;
      inCall = false;
      cleanupAudio();
      setVoiceUi();
      setStatus('接続が完了しませんでした。もう一度通話ボタンを押してください。');
    }, CALL_CONNECT_TIMEOUT_MS);
  }

  function maybeStartCall() {
    if (!desiredCall || !welcomed || !micReady || inCall) return;
    sendJson({ type: 'start_call', preferred_format: 'mp3' });
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

      if (data.type === 'search_trace') {
        dispatch('talksys-search-trace', data);
        return;
      }
      if (data.type === 'model_route') {
        dispatch('talksys-model-route', data);
        return;
      }
      if (data.type === 'welcome') {
        welcomed = true;
        flushText();
        maybeStartCall();
        return;
      }
      if (data.type === 'status') {
        if (data.status === 'listening') {
          if (desiredCall) {
            inCall = true;
            clearCallConnectTimeout();
            armMicWatch();
          }
          if (!assistantAudioActive()) setStatus(desiredCall ? '聞いています' : '');
        } else if (data.status === 'thinking') setStatus('考えています…');
        else if (data.status === 'speaking') setStatus((desiredCall || typedVoiceOutput) ? 'AIが話しています…' : '文字で回答しています…');
        else if (data.status === 'idle') inCall = false;
        setVoiceUi();
        return;
      }
      if (data.type === 'transcript_interim') { if (data.text) setStatus('聞き取り: ' + data.text); return; }
      if (data.type === 'transcript_start' && data.role === 'assistant') { beginAssistantStream(); return; }
      if (data.type === 'transcript_delta') { appendAssistantDelta(data.text); return; }
      if (data.type === 'transcript_end') { finishAssistantStream(data.text); return; }
      if (data.type === 'transcript' && data.text) {
        if (data.role === 'assistant') finishAssistantStream(data.text);
        else addMessage('user', data.text);
        return;
      }
      if (data.type === 'playback_interrupt') { stopPlayback(false); return; }
      if (data.type === 'search_status') {
        if (data.phase === 'searching') {
          const phrase = String(data.waitPhrase || '').trim();
          setStatus(phrase || 'Webで確認しています…');
          if (phrase && phrase !== lastSearchWaitPhrase && (desiredCall || typedVoiceOutput)) {
            lastSearchWaitPhrase = phrase;
            // The server normally provides TTS; do not create a second copy here.
          }
        } else setStatus('確認できた内容をまとめています…');
        return;
      }
      if (data.type === 'completion_outcome' && data.code === 'model_error') {
        setStatus('AI応答を再試行しています…');
        return;
      }
      if (data.type === 'error') {
        const message = String(data.message || '不明なエラー');
        if (/tts|speech|音声合成/i.test(message)) {
          if (currentAssistantText && !serverAudioThisTurn) setTimeout(() => speakJapaneseFallback(currentAssistantText), 120);
        } else setStatus('音声エラー: ' + message);
      }
    };
    socket.onclose = () => {
      welcomed = false;
      inCall = false;
      setVoiceUi();
      if (desiredCall && !manualStop) {
        setStatus('接続を復旧しています…');
        reconnectTimer = setTimeout(() => connectSocket(), 700);
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
      desiredCall = false;
      inCall = false;
      cleanupAudio();
      setVoiceUi();
      const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
      const missing = error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError';
      if (denied) setStatus('マイクの利用が許可されていません。ブラウザのマイク権限を許可してください。');
      else if (missing) setStatus('利用できるマイクが見つかりません。');
      else setStatus('マイクを開始できませんでした。もう一度通話ボタンを押してください。');
      dispatch('talksys-mic-error', { name: error?.name || '', message: error?.message || '' });
    }
  }

  function endCall() {
    clearCallConnectTimeout();
    manualStop = true;
    desiredCall = false;
    if (inCall) sendJson({ type: 'end_call' });
    inCall = false;
    stopPlayback(false);
    cleanupAudio();
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
    typedVoiceOutput = true;
    serverAudioThisTurn = false;
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
    try { if (inCall) sendJson({ type: 'end_call' }); } catch {}
    cleanupAudio();
    try { socket?.close(); } catch {}
  });

  setVoiceUi();
})();
`;

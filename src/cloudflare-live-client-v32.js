export const CLOUDFLARE_LIVE_CLIENT_V32 = String.raw`(() => {
  'use strict';

  const AGENT_PATH = '/agents/talk-sys-voice-agent/default';
  const MELO_TTS_ENDPOINT = '/api/melo-tts-v31';
  const TARGET_RATE = 16000;
  const CHUNK_SAMPLES = 640;
  const PRE_ROLL_FRAMES = 8;
  const CALL_CONNECT_TIMEOUT_MS = 12000;
  const CAPTURE_PROBE_MS = 1600;
  const CAPTURE_STALE_MS = 2400;
  const PLAYBACK_TAIL_GUARD_MS = 550;
  const BARGE_IN_THRESHOLD = 0.028;
  const BARGE_IN_FRAMES = 3;

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
  let callStartPending = false;
  let manualStop = false;
  let reconnectTimer = null;
  let callConnectTimer = null;

  let playbackContext = null;
  let playbackQueue = [];
  let playbackSource = null;
  let playing = false;
  let playbackGuardUntil = 0;
  let serverAudioThisTurn = false;
  let typedVoiceOutput = false;
  let typedTtsGeneration = 0;
  let typedMeloOwnsTurn = false;
  let typedTtsTimer = null;

  let captureContext = null;
  let mediaStream = null;
  let mediaSource = null;
  let captureNode = null;
  let captureSink = null;
  let captureKind = '';
  let captureState = 'idle';
  let captureGeneration = 0;
  let captureRecovery = false;
  let captureWatchTimer = null;
  let permissionState = 'unknown';
  let micSettings = {};
  let frameCount = 0;
  let firstFrameAt = 0;
  let lastFrameAt = 0;
  let lastRms = 0;
  let lastPeak = 0;
  let pcmFramesSent = 0;
  let pcmBytesSent = 0;
  let startCallSentAt = 0;
  let preRoll = [];
  let bargeInFrames = 0;

  let serverFramesReceived = 0;
  let serverBytesReceived = 0;
  let serverLastRms = 0;
  let serverLastFrameAt = 0;
  let lastSttEventAt = 0;

  let pendingText = [];
  let streamNode = null;
  let streamText = '';
  let currentAssistantText = '';
  let lastAdded = '';

  function setStatus(text) { if (status) status.textContent = text || ''; }
  function dispatch(name, detail) { try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch {} }
  function now() { return Date.now(); }

  function setCaptureState(next, extra = {}) {
    captureState = next;
    dispatch('talksys-mic-state', { state: next, ...extra, diagnostics: microphoneDiagnostics() });
  }

  function microphoneDiagnostics() {
    const track = mediaStream?.getAudioTracks?.()[0] || null;
    return {
      architecture: 'unified-capture-state-machine-v32',
      permission: permissionState,
      desiredCall,
      welcomed,
      inCall,
      callStartPending,
      socketState: socket?.readyState ?? -1,
      captureState,
      captureKind,
      frameCount,
      firstFrameAt,
      lastFrameAt,
      lastRms,
      lastPeak,
      pcmFramesSent,
      pcmBytesSent,
      startCallSentAt,
      serverFramesReceived,
      serverBytesReceived,
      serverLastRms,
      serverLastFrameAt,
      lastSttEventAt,
      track: track ? {
        readyState: track.readyState,
        muted: track.muted,
        enabled: track.enabled,
        settings: track.getSettings?.() || {},
      } : null,
      captureContext: captureContext ? { state: captureContext.state, sampleRate: captureContext.sampleRate } : null,
      playbackContext: playbackContext ? { state: playbackContext.state, sampleRate: playbackContext.sampleRate } : null,
      ttsProvider: '@cf/myshell-ai/melotts',
      browserSpeechSynthesisEnabled: false,
    };
  }
  try { window.__talksysVoiceDebug = () => microphoneDiagnostics(); } catch {}

  async function refreshPermission() {
    try {
      if (!navigator.permissions?.query) return;
      const result = await navigator.permissions.query({ name: 'microphone' });
      permissionState = result?.state || 'unknown';
      result.onchange = () => { permissionState = result.state || 'unknown'; };
    } catch {}
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
    streamText = '';
    currentAssistantText = '';
    serverAudioThisTurn = false;
    typedMeloOwnsTurn = false;
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

    clearTimeout(typedTtsTimer);
    typedTtsTimer = null;
    if (typedVoiceOutput && !desiredCall && !serverAudioThisTurn && value) {
      const generation = typedTtsGeneration;
      typedTtsTimer = setTimeout(() => {
        typedTtsTimer = null;
        if (!serverAudioThisTurn && !playing) void requestTypedMelo(value, generation);
      }, 750);
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
    try { socket.send(JSON.stringify(data)); return true; } catch { return false; }
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
      view.setInt16(i * 2, value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7fff), true);
    }
    return buffer;
  }

  function levelOf(samples) {
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const value = Number(samples[i]) || 0;
      sum += value * value;
      peak = Math.max(peak, Math.abs(value));
    }
    return { rms: Math.sqrt(sum / Math.max(1, samples.length)), peak };
  }

  function assistantAudioActive() { return playing || now() < playbackGuardUntil; }

  function sendPcmBuffer(buffer) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(buffer);
      pcmFramesSent += 1;
      pcmBytesSent += buffer.byteLength;
      if (pcmFramesSent === 1 || pcmFramesSent % 25 === 0) dispatch('talksys-mic-tx', microphoneDiagnostics());
      return true;
    } catch { return false; }
  }

  function rememberPreRoll(buffer) {
    preRoll.push(buffer.slice(0));
    if (preRoll.length > PRE_ROLL_FRAMES) preRoll.shift();
  }

  function flushPreRoll() {
    if (!(callStartPending || inCall) || socket?.readyState !== WebSocket.OPEN) return;
    const frames = preRoll.splice(0);
    for (const frame of frames) sendPcmBuffer(frame);
  }

  function handleCaptureFrame(samples) {
    if (!(samples instanceof Float32Array) || samples.length !== CHUNK_SAMPLES) return;
    frameCount += 1;
    lastFrameAt = now();
    if (!firstFrameAt) firstFrameAt = lastFrameAt;
    const level = levelOf(samples);
    lastRms = level.rms;
    lastPeak = level.peak;
    const pcm = floatToPcm(samples);

    if (frameCount === 1) {
      setCaptureState('verified', { sourceSampleRate: captureContext?.sampleRate || 0 });
      maybeStartCall();
    }

    const transportReady = desiredCall && welcomed && socket?.readyState === WebSocket.OPEN && (callStartPending || inCall);
    if (!transportReady) {
      if (desiredCall) rememberPreRoll(pcm);
      return;
    }

    if (assistantAudioActive()) {
      if (lastRms >= BARGE_IN_THRESHOLD) {
        bargeInFrames += 1;
        if (bargeInFrames >= BARGE_IN_FRAMES) {
          bargeInFrames = 0;
          stopPlayback(true);
          playbackGuardUntil = 0;
          sendPcmBuffer(pcm);
          dispatch('talksys-barge-in', { level: lastRms, threshold: BARGE_IN_THRESHOLD });
        }
      } else bargeInFrames = 0;
      return;
    }

    bargeInFrames = 0;
    sendPcmBuffer(pcm);
  }

  function createPlaybackContext() {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    try { return new AudioCtor({ sampleRate: 48000 }); } catch { try { return new AudioCtor(); } catch { return null; } }
  }

  function createCaptureContext() {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    try { return new AudioCtor(); } catch { return null; }
  }

  function primeAudioContexts() {
    if (!playbackContext || playbackContext.state === 'closed') playbackContext = createPlaybackContext();
    if (!captureContext || captureContext.state === 'closed') captureContext = createCaptureContext();
    try { if (playbackContext?.state !== 'running') void playbackContext.resume().catch(() => {}); } catch {}
    try { if (captureContext?.state !== 'running') void captureContext.resume().catch(() => {}); } catch {}
  }

  async function ensurePlaybackAudio() {
    if (!playbackContext || playbackContext.state === 'closed') playbackContext = createPlaybackContext();
    if (!playbackContext) return false;
    if (playbackContext.state !== 'running') await playbackContext.resume().catch(() => {});
    return playbackContext.state === 'running';
  }

  async function playNext() {
    if (playing || !playbackQueue.length || !playbackContext) return;
    playing = true;
    playbackGuardUntil = Number.POSITIVE_INFINITY;
    const bytes = playbackQueue.shift();
    try {
      if (playbackContext.state !== 'running') await playbackContext.resume();
      const decoded = await playbackContext.decodeAudioData(bytes.slice(0));
      const source = playbackContext.createBufferSource();
      source.buffer = decoded;
      const highpass = playbackContext.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 90;
      const presence = playbackContext.createBiquadFilter();
      presence.type = 'peaking';
      presence.frequency.value = 2800;
      presence.Q.value = 0.9;
      presence.gain.value = 2.0;
      const compressor = playbackContext.createDynamicsCompressor();
      compressor.threshold.value = -22;
      compressor.knee.value = 16;
      compressor.ratio.value = 2.6;
      compressor.attack.value = 0.006;
      compressor.release.value = 0.2;
      const gain = playbackContext.createGain();
      gain.gain.value = 1.05;
      source.connect(highpass);
      highpass.connect(presence);
      presence.connect(compressor);
      compressor.connect(gain);
      gain.connect(playbackContext.destination);
      playbackSource = source;
      source.onended = () => {
        if (playbackSource === source) playbackSource = null;
        playing = false;
        playbackGuardUntil = now() + PLAYBACK_TAIL_GUARD_MS;
        if (playbackQueue.length) void playNext();
        else if (desiredCall) setTimeout(() => { if (!assistantAudioActive() && desiredCall) setStatus('聞いています'); }, PLAYBACK_TAIL_GUARD_MS);
      };
      source.start();
    } catch (error) {
      playing = false;
      playbackGuardUntil = now() + PLAYBACK_TAIL_GUARD_MS;
      dispatch('talksys-playback-error', { message: String(error?.message || error).slice(0, 180) });
      if (playbackQueue.length) void playNext();
    }
  }

  function queueAudio(buffer, sourceKind = 'server') {
    clearTimeout(typedTtsTimer);
    typedTtsTimer = null;
    if (sourceKind === 'server' && typedMeloOwnsTurn) return;
    if (sourceKind === 'typed-melo') typedMeloOwnsTurn = true;
    serverAudioThisTurn = true;
    if (!(desiredCall || typedVoiceOutput)) return;
    playbackQueue.push(buffer);
    dispatch('talksys-melo-audio', { bytes: Number(buffer?.byteLength || 0), source: sourceKind });
    void ensurePlaybackAudio().then(() => playNext());
  }

  function stopPlayback(interruptServer = false) {
    clearTimeout(typedTtsTimer);
    typedTtsTimer = null;
    playbackQueue = [];
    playing = false;
    if (playbackSource) {
      try { playbackSource.stop(); } catch {}
      try { playbackSource.disconnect(); } catch {}
      playbackSource = null;
    }
    playbackGuardUntil = now() + PLAYBACK_TAIL_GUARD_MS;
    if (interruptServer) sendJson({ type: 'interrupt' });
  }

  async function requestTypedMelo(text, generation) {
    const value = String(text || '').trim();
    if (!value || desiredCall || !typedVoiceOutput) return;
    try {
      const response = await fetch(MELO_TTS_ENDPOINT, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: value }),
      });
      if (!response.ok) throw new Error('MeloTTS HTTP ' + response.status);
      const buffer = await response.arrayBuffer();
      if (!buffer.byteLength) throw new Error('MeloTTS returned empty audio');
      if (generation !== typedTtsGeneration || desiredCall || !typedVoiceOutput || serverAudioThisTurn) return;
      queueAudio(buffer, 'typed-melo');
    } catch (error) {
      if (generation === typedTtsGeneration) {
        setStatus('音声生成に失敗しました。文字回答は利用できます。');
        dispatch('talksys-melo-tts-error', { message: String(error?.message || error).slice(0, 180) });
      }
    }
  }

  function makeWorkletSource() {
    return "class TalkSysCaptureV32 extends AudioWorkletProcessor{constructor(){super();this.pending=[];this.phase=0;this.step=sampleRate/16000}process(inputs){const c=inputs[0]&&inputs[0][0];if(!c)return true;let p=this.phase;while(p<c.length){const a=Math.floor(p),f=p-a;this.pending.push(a+1<c.length?c[a]*(1-f)+c[a+1]*f:(c[a]||0));p+=this.step}this.phase=p-c.length;while(this.pending.length>=640){const out=new Float32Array(this.pending.splice(0,640));this.port.postMessage(out,[out.buffer])}return true}}registerProcessor('talksys-capture-v32',TalkSysCaptureV32);";
  }

  function disconnectProcessor() {
    try { captureNode?.disconnect(); } catch {}
    try { captureSink?.disconnect(); } catch {}
    captureNode = null;
    captureSink = null;
    captureKind = '';
  }

  function connectProcessorSink(node) {
    if (!captureContext) return false;
    captureSink = captureContext.createGain();
    captureSink.gain.value = 0;
    node.connect(captureSink);
    captureSink.connect(captureContext.destination);
    return true;
  }

  async function createWorkletProcessor(generation) {
    if (!captureContext?.audioWorklet || typeof AudioWorkletNode === 'undefined') return false;
    const url = URL.createObjectURL(new Blob([makeWorkletSource()], { type: 'text/javascript' }));
    try { await captureContext.audioWorklet.addModule(url); }
    catch { return false; }
    finally { URL.revokeObjectURL(url); }
    if (generation !== captureGeneration || !mediaSource) return false;
    const node = new AudioWorkletNode(captureContext, 'talksys-capture-v32');
    node.port.onmessage = (event) => {
      if (generation !== captureGeneration) return;
      const samples = event.data instanceof Float32Array ? event.data : new Float32Array(event.data);
      handleCaptureFrame(samples);
    };
    mediaSource.connect(node);
    connectProcessorSink(node);
    captureNode = node;
    captureKind = 'audio-worklet';
    return true;
  }

  function createScriptProcessor(generation) {
    if (!captureContext?.createScriptProcessor || !mediaSource) return false;
    const node = captureContext.createScriptProcessor(1024, 1, 1);
    const pending = [];
    let phase = 0;
    const step = captureContext.sampleRate / TARGET_RATE;
    node.onaudioprocess = (event) => {
      if (generation !== captureGeneration) return;
      const data = event.inputBuffer?.getChannelData(0);
      if (!data) return;
      let p = phase;
      while (p < data.length) {
        const a = Math.floor(p), f = p - a;
        pending.push(a + 1 < data.length ? data[a] * (1 - f) + data[a + 1] * f : (data[a] || 0));
        p += step;
      }
      phase = p - data.length;
      while (pending.length >= CHUNK_SAMPLES) handleCaptureFrame(new Float32Array(pending.splice(0, CHUNK_SAMPLES)));
    };
    mediaSource.connect(node);
    connectProcessorSink(node);
    captureNode = node;
    captureKind = 'script-processor';
    return true;
  }

  async function waitForFrame(baseline, timeoutMs = CAPTURE_PROBE_MS) {
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      if (frameCount > baseline && now() - lastFrameAt < 600) return true;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return frameCount > baseline;
  }

  async function installProcessor(preferred = 'audio-worklet') {
    const generation = captureGeneration;
    disconnectProcessor();
    const baseline = frameCount;
    let ok = false;
    if (preferred === 'audio-worklet') ok = await createWorkletProcessor(generation);
    else ok = createScriptProcessor(generation);
    if (!ok) return false;
    setCaptureState('processor', { captureKind });
    if (await waitForFrame(baseline)) return true;
    disconnectProcessor();
    return false;
  }

  async function acquireMicrophone() {
    const supported = navigator.mediaDevices.getSupportedConstraints?.() || {};
    const tuned = { channelCount: { ideal: 1 } };
    if (supported.echoCancellation !== false) tuned.echoCancellation = true;
    if (supported.noiseSuppression) tuned.noiseSuppression = true;
    if (supported.autoGainControl) tuned.autoGainControl = true;
    const attempts = [{ audio: tuned }, { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }, { audio: true }];
    let lastError = null;
    for (const request of attempts) {
      try { return await navigator.mediaDevices.getUserMedia(request); }
      catch (error) {
        lastError = error;
        if (['NotAllowedError', 'SecurityError', 'NotFoundError', 'DevicesNotFoundError'].includes(error?.name)) throw error;
      }
    }
    throw lastError || new Error('microphone acquisition failed');
  }

  async function startCapturePipeline() {
    if (!navigator.mediaDevices?.getUserMedia) {
      const error = new Error('microphone API unavailable'); error.name = 'NotSupportedError'; throw error;
    }
    const liveTrack = mediaStream?.getAudioTracks?.()[0];
    if (captureState === 'verified' && liveTrack?.readyState === 'live' && captureContext?.state === 'running' && now() - lastFrameAt < CAPTURE_STALE_MS) return;

    cleanupCapture(false);
    captureGeneration += 1;
    const generation = captureGeneration;
    setCaptureState('permission');
    await refreshPermission();
    mediaStream = await acquireMicrophone();
    if (generation !== captureGeneration) return;
    const track = mediaStream.getAudioTracks()[0];
    if (!track || track.readyState !== 'live') throw new Error('microphone track unavailable');
    micSettings = track.getSettings?.() || {};
    setCaptureState('track-live', { settings: micSettings });

    if (!captureContext || captureContext.state === 'closed') captureContext = createCaptureContext();
    if (!captureContext) throw new Error('Capture AudioContext unavailable');
    if (captureContext.state !== 'running') await captureContext.resume().catch(() => {});
    if (captureContext.state !== 'running') {
      await new Promise((resolve) => setTimeout(resolve, 80));
      await captureContext.resume().catch(() => {});
    }
    if (captureContext.state !== 'running') throw new Error('Capture AudioContext is suspended');

    mediaSource = captureContext.createMediaStreamSource(mediaStream);
    let verified = await installProcessor('audio-worklet');
    if (!verified) {
      dispatch('talksys-mic-capture-fallback', { from: 'audio-worklet', to: 'script-processor' });
      verified = await installProcessor('script-processor');
    }
    if (!verified) {
      const error = new Error('Microphone track is live but PCM capture produced no frames');
      error.name = 'NotReadableError';
      throw error;
    }

    track.onended = () => { if (desiredCall) void recoverCapture('track-ended'); };
    track.onmute = () => { if (desiredCall) setTimeout(() => { if (track.muted && desiredCall) void recoverCapture('track-muted'); }, 1400); };
    setCaptureState('verified', { captureKind, sampleRate: captureContext.sampleRate });
    armCaptureWatchdog();
  }

  function cleanupCapture(stopTracks = true) {
    clearTimeout(captureWatchTimer);
    captureWatchTimer = null;
    disconnectProcessor();
    try { mediaSource?.disconnect(); } catch {}
    mediaSource = null;
    if (stopTracks) {
      try { mediaStream?.getTracks?.().forEach((track) => { try { track.onended = null; track.onmute = null; track.onunmute = null; track.stop(); } catch {} }); } catch {}
      mediaStream = null;
    }
    if (stopTracks) setCaptureState('idle');
  }

  async function recoverCapture(reason) {
    if (!desiredCall || captureRecovery) return;
    captureRecovery = true;
    setStatus('マイク入力を復旧しています…');
    dispatch('talksys-mic-recovery', { reason, diagnostics: microphoneDiagnostics() });
    try {
      cleanupCapture(true);
      await startCapturePipeline();
      maybeStartCall();
      if (inCall) setStatus('聞いています');
    } catch (error) {
      setCaptureState('failed', { reason, message: String(error?.message || error).slice(0, 180) });
      setStatus('マイク入力を復旧できませんでした。通話ボタンを押し直してください。');
    } finally { captureRecovery = false; }
  }

  function armCaptureWatchdog() {
    clearTimeout(captureWatchTimer);
    const baseline = frameCount;
    captureWatchTimer = setTimeout(() => {
      captureWatchTimer = null;
      if (!desiredCall || assistantAudioActive()) { if (desiredCall) armCaptureWatchdog(); return; }
      if (frameCount === baseline || now() - lastFrameAt > CAPTURE_STALE_MS) void recoverCapture('capture-stalled');
      else armCaptureWatchdog();
    }, CAPTURE_STALE_MS);
  }

  function clearCallConnectTimeout() { clearTimeout(callConnectTimer); callConnectTimer = null; }
  function armCallConnectTimeout() {
    clearCallConnectTimeout();
    callConnectTimer = setTimeout(() => {
      callConnectTimer = null;
      if (!desiredCall || inCall) return;
      setStatus('音声接続の確認に失敗しました。処理ビューのマイク状態を確認してください。');
      dispatch('talksys-call-timeout', microphoneDiagnostics());
    }, CALL_CONNECT_TIMEOUT_MS);
  }

  function maybeStartCall() {
    if (!desiredCall || !welcomed || inCall || callStartPending) return;
    if (captureState !== 'verified' || frameCount < 1 || now() - lastFrameAt > CAPTURE_STALE_MS) {
      setStatus('マイク入力を確認しています…');
      return;
    }
    if (sendJson({ type: 'start_call', preferred_format: 'mp3' })) {
      callStartPending = true;
      startCallSentAt = now();
      setStatus('音声入力を接続しています…');
      flushPreRoll();
    }
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

      if (data.type === 'turn_trace') { dispatch('talksys-turn-trace', data); return; }
      if (data.type === 'search_trace') { dispatch('talksys-search-trace', data); return; }
      if (data.type === 'model_route') { dispatch('talksys-model-route', data); return; }
      if (data.type === 'mic_transport') {
        serverFramesReceived = Number(data.frames || serverFramesReceived || 0);
        serverBytesReceived = Number(data.bytes || serverBytesReceived || 0);
        serverLastRms = Number(data.rms || 0);
        serverLastFrameAt = now();
        dispatch('talksys-mic-transport', { ...data, diagnostics: microphoneDiagnostics() });
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
            callStartPending = false;
            clearCallConnectTimeout();
            setStatus('聞いています');
          }
        } else if (data.status === 'thinking') setStatus('考えています…');
        else if (data.status === 'speaking') setStatus((desiredCall || typedVoiceOutput) ? 'AIが話しています…' : '文字で回答しています…');
        else if (data.status === 'idle') inCall = false;
        setVoiceUi();
        return;
      }
      if (data.type === 'transcript_interim') { lastSttEventAt = now(); if (data.text) setStatus('聞き取り: ' + data.text); return; }
      if (data.type === 'transcript_start' && data.role === 'assistant') { beginAssistantStream(); return; }
      if (data.type === 'transcript_delta') { appendAssistantDelta(data.text); return; }
      if (data.type === 'transcript_end') { finishAssistantStream(data.text); return; }
      if (data.type === 'transcript' && data.text) {
        lastSttEventAt = now();
        if (data.role === 'assistant') finishAssistantStream(data.text);
        else { serverAudioThisTurn = false; typedMeloOwnsTurn = false; addMessage('user', data.text); }
        return;
      }
      if (data.type === 'playback_interrupt') { stopPlayback(false); return; }
      if (data.type === 'search_status') {
        setStatus(data.phase === 'searching' ? String(data.waitPhrase || '確認しています…') : '確認した内容をまとめています…');
        return;
      }
      if (data.type === 'completion_outcome' && data.code === 'model_error') { setStatus('AI応答を再試行しています…'); return; }
      if (data.type === 'error') {
        const message = String(data.message || '不明なエラー');
        setStatus(/tts|speech|音声合成/i.test(message) ? '音声生成を再確認しています…' : '音声エラー: ' + message);
      }
    };
    socket.onclose = () => {
      welcomed = false;
      inCall = false;
      callStartPending = false;
      setVoiceUi();
      if (desiredCall && !manualStop) {
        setStatus('接続を復旧しています…');
        reconnectTimer = setTimeout(() => connectSocket(), 650);
      }
    };
    socket.onerror = () => { if (desiredCall && !manualStop) { setStatus('接続を再確立しています…'); try { socket.close(); } catch {} } };
  }

  async function startCall() {
    manualStop = false;
    desiredCall = true;
    inCall = false;
    callStartPending = false;
    frameCount = 0;
    firstFrameAt = 0;
    lastFrameAt = 0;
    pcmFramesSent = 0;
    pcmBytesSent = 0;
    serverFramesReceived = 0;
    serverBytesReceived = 0;
    serverLastFrameAt = 0;
    lastSttEventAt = 0;
    preRoll = [];
    typedVoiceOutput = false;
    stopPlayback(false);
    primeAudioContexts();
    setVoiceUi();
    try {
      setStatus('マイク入力を確認しています…');
      await startCapturePipeline();
      armCallConnectTimeout();
      connectSocket();
      maybeStartCall();
    } catch (error) {
      desiredCall = false;
      inCall = false;
      callStartPending = false;
      cleanupCapture(true);
      setVoiceUi();
      const denied = ['NotAllowedError', 'SecurityError'].includes(error?.name);
      const missing = ['NotFoundError', 'DevicesNotFoundError'].includes(error?.name);
      if (denied) setStatus('マイクの利用が許可されていません。ブラウザのマイク権限を許可してください。');
      else if (missing) setStatus('利用できるマイクが見つかりません。');
      else setStatus('マイク入力経路を開始できませんでした。処理ビューの診断を確認してください。');
      setCaptureState('failed', { name: error?.name || '', message: String(error?.message || error).slice(0, 180) });
      dispatch('talksys-mic-error', { name: error?.name || '', message: String(error?.message || error).slice(0, 180), diagnostics: microphoneDiagnostics() });
    }
  }

  function endCall() {
    clearCallConnectTimeout();
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    manualStop = true;
    desiredCall = false;
    if (inCall || callStartPending) sendJson({ type: 'end_call' });
    inCall = false;
    callStartPending = false;
    stopPlayback(false);
    cleanupCapture(true);
    try { if (captureContext?.state === 'running') void captureContext.suspend().catch(() => {}); } catch {}
    setStatus('');
    setVoiceUi();
  }

  function submitText(event) {
    if (event) { event.preventDefault(); event.stopImmediatePropagation(); }
    const value = String(input.value || '').trim();
    if (!value) return false;
    input.value = '';
    typedVoiceOutput = true;
    typedTtsGeneration += 1;
    typedMeloOwnsTurn = false;
    stopPlayback(false);
    serverAudioThisTurn = false;
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
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) submitText(event); }, true);
  voice.addEventListener('click', () => desiredCall ? endCall() : void startCall());

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && desiredCall) setTimeout(() => {
      try { if (captureContext?.state === 'suspended') void captureContext.resume(); } catch {}
      try { if (playbackContext?.state === 'suspended') void playbackContext.resume(); } catch {}
      if (now() - lastFrameAt > CAPTURE_STALE_MS) void recoverCapture('visibility-resume');
      if (!socket || socket.readyState >= WebSocket.CLOSING) connectSocket();
    }, 80);
  });
  window.addEventListener('online', () => { if (desiredCall && (!socket || socket.readyState >= WebSocket.CLOSING)) connectSocket(); });
  window.addEventListener('beforeunload', () => {
    try { if (inCall || callStartPending) sendJson({ type: 'end_call' }); } catch {}
    cleanupCapture(true);
    try { socket?.close(); } catch {}
  });

  void refreshPermission();
  setVoiceUi();
})();
`;

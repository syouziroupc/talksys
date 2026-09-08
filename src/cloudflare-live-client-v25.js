import { CLOUDFLARE_LIVE_CLIENT_V24 } from './cloudflare-live-client-v24.js';

function replaceOnce(source, target, replacement, label) {
  if (!source.includes(target)) throw new Error(`TalkSys v25 client patch target missing: ${label}`);
  return source.replace(target, replacement);
}

let source = CLOUDFLARE_LIVE_CLIENT_V24;

source = replaceOnce(
  source,
  "  const BARGE_IN_FRAMES = 3;\n",
  "  const BARGE_IN_FRAMES = 3;\n  const IS_ANDROID = /Android/i.test(navigator.userAgent || '');\n  const MOBILE_CAPTURE_START_TIMEOUT_MS = 1800;\n",
  'mobile capture constants',
);

source = replaceOnce(
  source,
  "  let audioContext = null;\n",
  "  let audioContext = null;\n  let captureAudioContext = null;\n  let micFirstFrameAt = 0;\n  let micPcmFramesSent = 0;\n  let micStartSentAt = 0;\n  let micPermissionState = 'unknown';\n",
  'dedicated capture context state',
);

source = replaceOnce(
  source,
  `  function dispatch(name, detail) {
    try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch {}
  }
`,
  `  function dispatch(name, detail) {
    try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch {}
  }

  function microphoneDiagnostics() {
    const track = mediaStream?.getAudioTracks?.()[0] || null;
    return {
      android: IS_ANDROID,
      permission: micPermissionState,
      desiredCall,
      welcomed,
      inCall,
      callStartPending,
      socketState: socket?.readyState ?? -1,
      micReady,
      capture: micCaptureKind,
      frameCount: micFrameCount,
      firstFrameAt: micFirstFrameAt,
      lastFrameAt: micLastFrameAt,
      pcmFramesSent: micPcmFramesSent,
      startCallSentAt: micStartSentAt,
      track: track ? {
        readyState: track.readyState,
        muted: track.muted,
        enabled: track.enabled,
        settings: track.getSettings?.() || {},
      } : null,
      captureAudioContext: captureAudioContext ? {
        state: captureAudioContext.state,
        sampleRate: captureAudioContext.sampleRate,
      } : null,
      playbackAudioContext: audioContext ? {
        state: audioContext.state,
        sampleRate: audioContext.sampleRate,
      } : null,
    };
  }

  try { window.__talksysVoiceDebug = () => microphoneDiagnostics(); } catch {}

  async function refreshMicPermissionState() {
    try {
      if (!navigator.permissions?.query) return;
      const result = await navigator.permissions.query({ name: 'microphone' });
      micPermissionState = result?.state || 'unknown';
      result.onchange = () => { micPermissionState = result.state || 'unknown'; };
    } catch {}
  }
`,
  'microphone diagnostics',
);

source = replaceOnce(
  source,
  `  function handleMicFrame(samples) {
    micFrameCount += 1;
    micLastFrameAt = Date.now();
    const level = rms(samples);
`,
  `  function sendMicPcm(samples) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(floatToPcm(samples));
      micPcmFramesSent += 1;
      return true;
    } catch {
      return false;
    }
  }

  function handleMicFrame(samples) {
    micFrameCount += 1;
    micLastFrameAt = Date.now();
    if (!micFirstFrameAt) micFirstFrameAt = micLastFrameAt;
    if (IS_ANDROID && desiredCall && welcomed && micReady && !inCall && !callStartPending) maybeStartCall();
    const level = rms(samples);
`,
  'verified first microphone frame',
);

source = replaceOnce(
  source,
  `          socket.send(floatToPcm(samples));
          dispatch('talksys-barge-in', { level, threshold: BARGE_IN_THRESHOLD });
`,
  `          sendMicPcm(samples);
          dispatch('talksys-barge-in', { level, threshold: BARGE_IN_THRESHOLD });
`,
  'barge-in pcm accounting',
);

source = replaceOnce(
  source,
  `    if (transportReady) socket.send(floatToPcm(samples));
`,
  `    if (transportReady) sendMicPcm(samples);
`,
  'normal pcm accounting',
);

source = replaceOnce(
  source,
  `  function createAudioContextCompat() {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    try { return new AudioCtor({ sampleRate: 48000 }); }
    catch {
      try { return new AudioCtor(); } catch { return null; }
    }
  }

  function primeAudioContextFromGesture() {
    if (!audioContext || audioContext.state === 'closed') audioContext = createAudioContextCompat();
    if (!audioContext) return null;
    if (audioContext.state !== 'running') {
      try { void audioContext.resume().catch(() => {}); } catch {}
    }
    return audioContext;
  }
`,
  `  function createAudioContextCompat() {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    try { return new AudioCtor({ sampleRate: 48000 }); }
    catch {
      try { return new AudioCtor(); } catch { return null; }
    }
  }

  function createCaptureAudioContextCompat() {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    // Use the device-native capture rate. Forcing 48 kHz on some Android devices can
    // produce a live MediaStreamTrack without a functioning WebAudio capture graph.
    try { return new AudioCtor(); } catch { return null; }
  }

  function primeAudioContextFromGesture() {
    if (!audioContext || audioContext.state === 'closed') audioContext = createAudioContextCompat();
    if (!captureAudioContext || captureAudioContext.state === 'closed') captureAudioContext = createCaptureAudioContextCompat();
    if (audioContext?.state !== 'running') {
      try { void audioContext.resume().catch(() => {}); } catch {}
    }
    if (captureAudioContext?.state !== 'running') {
      try { void captureAudioContext.resume().catch(() => {}); } catch {}
    }
    return audioContext || captureAudioContext;
  }
`,
  'separate playback and microphone audio contexts',
);

source = replaceOnce(
  source,
  `    if (supported.sampleRate) constraints.sampleRate = { ideal: 48000 };
`,
  `    if (supported.sampleRate && !IS_ANDROID) constraints.sampleRate = { ideal: 48000 };
`,
  'native android capture sample rate',
);

source = replaceOnce(
  source,
  `  function connectCaptureSilently(node) {
    captureSilenceGain = audioContext.createGain();
    captureSilenceGain.gain.value = 0;
    node.connect(captureSilenceGain);
    captureSilenceGain.connect(audioContext.destination);
  }
`,
  `  function connectCaptureSilently(node) {
    if (!captureAudioContext) return;
    captureSilenceGain = captureAudioContext.createGain();
    captureSilenceGain.gain.value = 0;
    node.connect(captureSilenceGain);
    captureSilenceGain.connect(captureAudioContext.destination);
  }
`,
  'capture graph destination',
);

source = replaceOnce(
  source,
  `  async function createWorkletCapture() {
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
`,
  `  async function createWorkletCapture() {
    if (!captureAudioContext?.audioWorklet || typeof AudioWorkletNode === 'undefined') return false;
    const url = URL.createObjectURL(new Blob([makeWorkletSource()], { type: 'text/javascript' }));
    try {
      await captureAudioContext.audioWorklet.addModule(url);
    } catch {
      return false;
    } finally {
      URL.revokeObjectURL(url);
    }
    const node = new AudioWorkletNode(captureAudioContext, 'talksys-v20-capture');
    node.port.onmessage = (event) => {
      const samples = event.data instanceof Float32Array ? event.data : new Float32Array(event.data);
      handleMicFrame(samples);
    };
    mediaSource.connect(node);
    connectCaptureSilently(node);
    captureNode = node;
    return true;
  }
`,
  'worklet on dedicated capture context',
);

source = replaceOnce(
  source,
  `  function createScriptProcessorCapture() {
    if (!audioContext?.createScriptProcessor) return false;
    const node = audioContext.createScriptProcessor(2048, 1, 1);
    const pending = [];
    let phase = 0;
    const step = audioContext.sampleRate / TARGET_RATE;
`,
  `  function createScriptProcessorCapture() {
    if (!captureAudioContext?.createScriptProcessor) return false;
    const node = captureAudioContext.createScriptProcessor(IS_ANDROID ? 1024 : 2048, 1, 1);
    const pending = [];
    let phase = 0;
    const step = captureAudioContext.sampleRate / TARGET_RATE;
`,
  'android-safe script processor capture',
);

source = replaceOnce(
  source,
  `    if (micReady && mediaStream && audioContext) {
      if (audioContext.state !== 'running') await audioContext.resume().catch(() => {});
      return;
    }
`,
  `    if (micReady && mediaStream && captureAudioContext) {
      if (captureAudioContext.state !== 'running') await captureAudioContext.resume().catch(() => {});
      if (audioContext?.state !== 'running') await audioContext?.resume?.().catch(() => {});
      if (captureAudioContext.state === 'running') return;
    }
`,
  'capture readiness uses capture context',
);

source = replaceOnce(
  source,
  `    if (!primeAudioContextFromGesture()) throw new Error('AudioContext unavailable');
    if (audioContext.state !== 'running') await audioContext.resume().catch(() => {});
    if (audioContext.state !== 'running') {
      await new Promise((resolve) => setTimeout(resolve, 80));
      await audioContext.resume().catch(() => {});
    }
    if (audioContext.state !== 'running') throw new Error('AudioContext is suspended');

    mediaSource = audioContext.createMediaStreamSource(mediaStream);
    const workletOk = await createWorkletCapture();
    if (!workletOk && !createScriptProcessorCapture()) throw new Error('No microphone capture processor available');
`,
  `    if (!primeAudioContextFromGesture()) throw new Error('AudioContext unavailable');
    if (!captureAudioContext || captureAudioContext.state === 'closed') captureAudioContext = createCaptureAudioContextCompat();
    if (!captureAudioContext) throw new Error('Capture AudioContext unavailable');
    if (captureAudioContext.state !== 'running') await captureAudioContext.resume().catch(() => {});
    if (captureAudioContext.state !== 'running') {
      await new Promise((resolve) => setTimeout(resolve, 80));
      await captureAudioContext.resume().catch(() => {});
    }
    if (captureAudioContext.state !== 'running') throw new Error('Capture AudioContext is suspended');

    mediaSource = captureAudioContext.createMediaStreamSource(mediaStream);
    let workletOk = false;
    let captureOk = false;
    // ScriptProcessor is deprecated, but on older Android/WebView it is materially
    // more reliable than AudioWorklet for live microphone delivery. Prefer it there.
    if (IS_ANDROID) captureOk = createScriptProcessorCapture();
    if (!captureOk) {
      workletOk = await createWorkletCapture();
      captureOk = workletOk;
    }
    if (!captureOk) captureOk = createScriptProcessorCapture();
    if (!captureOk) throw new Error('No microphone capture processor available');
`,
  'native mobile capture graph',
);

source = replaceOnce(
  source,
  `  function maybeStartCall() {
    if (!desiredCall || !welcomed || !micReady || inCall || callStartPending) return;
    if (sendJson({ type: 'start_call', preferred_format: 'mp3' })) {
      callStartPending = true;
      setStatus('接続しています…');
    }
  }
`,
  `  function maybeStartCall() {
    if (!desiredCall || !welcomed || !micReady || inCall || callStartPending) return;
    // On Android, prove that WebAudio is actually delivering microphone frames before
    // starting the server call. A live track/mic icon alone is not sufficient.
    if (IS_ANDROID && micFrameCount < 1) {
      setStatus('マイク入力を確認しています…');
      return;
    }
    if (sendJson({ type: 'start_call', preferred_format: 'mp3' })) {
      callStartPending = true;
      micStartSentAt = Date.now();
      setStatus('接続しています…');
    }
  }
`,
  'frame-proven android call start',
);

source = replaceOnce(
  source,
  `    proactiveGreetingDone = false;
    callStartPending = false;
    bargeInFrames = 0;
`,
  `    proactiveGreetingDone = false;
    callStartPending = false;
    micFrameCount = 0;
    micFirstFrameAt = 0;
    micPcmFramesSent = 0;
    micStartSentAt = 0;
    void refreshMicPermissionState();
    bargeInFrames = 0;
`,
  'new-call microphone diagnostics reset',
);

source = replaceOnce(
  source,
  `    micReady = true;
    micCaptureKind = workletOk ? 'audio-worklet' : 'script-processor';
`,
  `    micReady = true;
    micCaptureKind = workletOk ? 'audio-worklet' : 'script-processor';
    dispatch('talksys-mic-pipeline', microphoneDiagnostics());
`,
  'capture pipeline event',
);

source = replaceOnce(
  source,
  `      if (!desiredCall || !micReady || assistantAudioActive()) return;
      if (micFrameCount !== baseline || Date.now() - micLastFrameAt < 1200) return;
`,
  `      if (!desiredCall || !micReady || assistantAudioActive()) return;
      if (micFrameCount !== baseline || Date.now() - micLastFrameAt < 1200) return;
      dispatch('talksys-mic-stalled', microphoneDiagnostics());
`,
  'stalled capture diagnostics',
);

source = replaceOnce(
  source,
  `  function endCall() {
    callStartPending = false;
`,
  `  function endCall() {
    callStartPending = false;
    try { if (captureAudioContext?.state === 'running') void captureAudioContext.suspend().catch(() => {}); } catch {}
`,
  'suspend dedicated capture context on call end',
);

export const CLOUDFLARE_LIVE_CLIENT_V25 = source;

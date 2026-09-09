import { CLOUDFLARE_LIVE_CLIENT_V25 } from './cloudflare-live-client-v25.js';

function replaceOnce(source, target, replacement, label) {
  if (!source.includes(target)) throw new Error(`TalkSys v26 client patch target missing: ${label}`);
  return source.replace(target, replacement);
}

let source = CLOUDFLARE_LIVE_CLIENT_V25;

source = replaceOnce(
  source,
  "  const MOBILE_CAPTURE_START_TIMEOUT_MS = 1800;\n",
  "  const MOBILE_CAPTURE_START_TIMEOUT_MS = 1400;\n  const MOBILE_CAPTURE_SECONDARY_TIMEOUT_MS = 1400;\n  const MOBILE_RESUME_STALE_MS = 2600;\n",
  'mobile capture probe timing',
);

source = replaceOnce(
  source,
  `  async function createWorkletCapture() {
`,
  `  function disconnectCaptureProcessor() {
    try { captureNode?.disconnect(); } catch {}
    try { captureSilenceGain?.disconnect(); } catch {}
    captureNode = null;
    captureSilenceGain = null;
  }

  async function waitForMicFrameAfter(baseline, timeoutMs) {
    const deadline = Date.now() + Math.max(100, timeoutMs || 1000);
    while (Date.now() < deadline) {
      if (micFrameCount > baseline && Date.now() - micLastFrameAt < 500) return true;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return micFrameCount > baseline;
  }

  async function verifyAndroidCapturePipeline() {
    if (!IS_ANDROID) return true;
    let baseline = micFrameCount;
    if (await waitForMicFrameAfter(baseline, MOBILE_CAPTURE_START_TIMEOUT_MS)) return true;

    // Chrome/Android normally prefers AudioWorklet. If the selected backend produced
    // no callback at all, rebuild the graph using the other backend before reacquiring
    // the microphone. This distinguishes a live MediaStreamTrack from a live PCM path.
    const previous = micCaptureKind;
    disconnectCaptureProcessor();
    let switched = false;
    if (previous === 'audio-worklet') {
      switched = createScriptProcessorCapture();
      if (switched) micCaptureKind = 'script-processor';
    } else {
      const workletOk = await createWorkletCapture();
      switched = workletOk;
      if (workletOk) micCaptureKind = 'audio-worklet';
    }
    if (!switched) return false;

    dispatch('talksys-mic-capture-fallback', { from: previous, capture: micCaptureKind, startup: true });
    baseline = micFrameCount;
    return waitForMicFrameAfter(baseline, MOBILE_CAPTURE_SECONDARY_TIMEOUT_MS);
  }

  async function createWorkletCapture() {
`,
  'active Android capture verification helpers',
);

source = replaceOnce(
  source,
  `    let workletOk = false;
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
  `    let workletOk = false;
    let captureOk = false;
    // AudioWorklet is the standards-based real-time path on current Android Chrome.
    // ScriptProcessor remains only as a compatibility fallback for old WebViews.
    workletOk = await createWorkletCapture();
    captureOk = workletOk;
    if (!captureOk) captureOk = createScriptProcessorCapture();
    if (!captureOk) throw new Error('No microphone capture processor available');
`,
  'standards-first Android capture backend',
);

source = replaceOnce(
  source,
  `    micReady = true;
    micCaptureKind = workletOk ? 'audio-worklet' : 'script-processor';
    dispatch('talksys-mic-pipeline', microphoneDiagnostics());
    micLastActiveAt = Date.now();
`,
  `    micReady = true;
    micCaptureKind = workletOk ? 'audio-worklet' : 'script-processor';
    if (IS_ANDROID) {
      const verified = await verifyAndroidCapturePipeline();
      if (!verified) {
        const error = new Error('Android microphone track is live but PCM capture produced no frames');
        error.name = 'NotReadableError';
        dispatch('talksys-mic-no-frames', microphoneDiagnostics());
        throw error;
      }
    }
    dispatch('talksys-mic-pipeline', microphoneDiagnostics());
    micLastActiveAt = Date.now();
`,
  'prove Android PCM before declaring microphone ready',
);

source = replaceOnce(
  source,
  `    socket.onerror = () => setStatus('リアルタイム接続を再確認しています…');
`,
  `    socket.onerror = () => {
      if (!desiredCall || manualStop) return;
      setStatus('接続を再確立しています…');
      // onerror does not guarantee onclose on every mobile Chromium network failure.
      // Closing explicitly funnels recovery through the single onclose reconnect path.
      try { socket?.close(); } catch {}
    };
`,
  'mobile websocket error recovery',
);

source = replaceOnce(
  source,
  `  form.addEventListener('submit', submitText, true);
`,
  `  async function resumeMobileRuntime(reason = '') {
    if (!IS_ANDROID || !desiredCall || manualStop) return;
    try {
      if (audioContext?.state === 'suspended') await audioContext.resume().catch(() => {});
      if (captureAudioContext?.state === 'suspended') await captureAudioContext.resume().catch(() => {});

      const track = mediaStream?.getAudioTracks?.()[0] || null;
      const stale = !track || track.readyState !== 'live' || !micReady || Date.now() - micLastFrameAt > MOBILE_RESUME_STALE_MS;
      if (stale && !micRecoveryInProgress) {
        cleanupAudio();
        await ensureAudio();
      }

      if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
        connectSocket();
      } else if (welcomed) {
        maybeStartCall();
      }
      dispatch('talksys-mobile-resume', { reason, diagnostics: microphoneDiagnostics() });
    } catch (error) {
      dispatch('talksys-mic-error', { name: error?.name || '', message: error?.message || '', resume: reason });
      scheduleMicRecovery('mobile-resume-' + reason);
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) setTimeout(() => void resumeMobileRuntime('visibility'), 80);
  });
  window.addEventListener('pageshow', () => setTimeout(() => void resumeMobileRuntime('pageshow'), 80));
  window.addEventListener('online', () => setTimeout(() => void resumeMobileRuntime('online'), 80));

  form.addEventListener('submit', submitText, true);
`,
  'Android lifecycle resume and network recovery',
);

export const CLOUDFLARE_LIVE_CLIENT_V26 = source;

import { CLOUDFLARE_LIVE_CLIENT_V21 } from './cloudflare-live-client-v21.js';

function replaceOnce(source, target, replacement, label) {
  if (!source.includes(target)) throw new Error(`TalkSys v23 client patch target missing: ${label}`);
  return source.replace(target, replacement);
}

let source = CLOUDFLARE_LIVE_CLIENT_V21;

source = replaceOnce(
  source,
  "  let proactiveGreetingTimer = null;\n",
  "  let proactiveGreetingTimer = null;\n  let micFrameCount = 0;\n  let micLastFrameAt = 0;\n  let micCaptureKind = '';\n  let micCaptureWatchTimer = null;\n  let micRecoveryTimer = null;\n  let micRecoveryInProgress = false;\n  let micMuteRecoveryTimer = null;\n  let searchWaitActive = false;\n  let searchWaitFollowupTimer = null;\n  let deviceSpeechPurpose = '';\n  let lastFallbackAnswerText = '';\n  let lastFallbackAnswerAt = 0;\n",
  'v23 runtime state',
);

source = replaceOnce(
  source,
  `  function handleMicFrame(samples) {
    const level = rms(samples);
`,
  `  function handleMicFrame(samples) {
    micFrameCount += 1;
    micLastFrameAt = Date.now();
    const level = rms(samples);
`,
  'mic frame liveness',
);

source = replaceOnce(
  source,
  `  function cancelDeviceSpeech() {
    try { speechSynthesis.cancel(); } catch {}
    deviceSpeaking = false;
    deviceUtterance = null;
    playbackGuardUntil = Date.now() + PLAYBACK_TAIL_GUARD_MS;
  }

  function speakJapaneseFallback(text) {
`,
  `  function cancelDeviceSpeech() {
    try { speechSynthesis.cancel(); } catch {}
    deviceSpeaking = false;
    deviceUtterance = null;
    deviceSpeechPurpose = '';
    playbackGuardUntil = Date.now() + PLAYBACK_TAIL_GUARD_MS;
  }

  function speakJapaneseFallback(text, purpose = 'answer') {
`,
  'speech purpose tracking',
);

source = replaceOnce(
  source,
  `      deviceUtterance = utterance;
      utterance.onstart = () => {
`,
  `      deviceUtterance = utterance;
      deviceSpeechPurpose = purpose;
      utterance.onstart = () => {
`,
  'speech purpose assignment',
);

source = replaceOnce(
  source,
  `        deviceUtterance = null;
        deviceSpeaking = false;
        playbackGuardUntil = Date.now() + PLAYBACK_TAIL_GUARD_MS;
`,
  `        deviceUtterance = null;
        deviceSpeaking = false;
        deviceSpeechPurpose = '';
        playbackGuardUntil = Date.now() + PLAYBACK_TAIL_GUARD_MS;
`,
  'speech purpose cleanup',
);

source = replaceOnce(
  source,
  `    if ((desiredCall || typedVoiceOutput) && !serverAudioThisTurn && value) {
      ttsFallbackTimer = setTimeout(() => {
        ttsFallbackTimer = null;
        if (!serverAudioThisTurn && !playing && !deviceSpeaking) speakJapaneseFallback(value);
      }, 500);
    }
`,
  `    if ((desiredCall || typedVoiceOutput) && !serverAudioThisTurn && value) {
      ttsFallbackTimer = setTimeout(() => {
        ttsFallbackTimer = null;
        const now = Date.now();
        const duplicate = value === lastFallbackAnswerText && now - lastFallbackAnswerAt < 8000;
        if (!duplicate && !serverAudioThisTurn && !playing && !deviceSpeaking) {
          if (speakJapaneseFallback(value, 'answer-fallback')) {
            lastFallbackAnswerText = value;
            lastFallbackAnswerAt = now;
          }
        }
      }, 3500);
    }
`,
  'late non-duplicating browser TTS fallback',
);

source = replaceOnce(
  source,
  `    micSettings = track.getSettings?.() || {};
    track.onended = () => {
      micReady = false;
      if (desiredCall) setStatus('マイク接続を復旧しています…');
    };
`,
  `    micSettings = track.getSettings?.() || {};
    track.onended = () => {
      micReady = false;
      if (desiredCall && !micRecoveryInProgress) scheduleMicRecovery('track-ended');
    };
    track.onmute = () => {
      clearTimeout(micMuteRecoveryTimer);
      micMuteRecoveryTimer = setTimeout(() => {
        micMuteRecoveryTimer = null;
        if (desiredCall && track.muted && !micRecoveryInProgress) scheduleMicRecovery('track-muted');
      }, 1800);
    };
    track.onunmute = () => {
      clearTimeout(micMuteRecoveryTimer);
      micMuteRecoveryTimer = null;
    };
`,
  'track recovery hooks',
);

source = replaceOnce(
  source,
  `  async function ensureAudio() {
`,
  `  async function acquireMicrophone(constraints) {
    const attempts = [
      { audio: constraints },
      { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } },
      { audio: true },
    ];
    let lastError = null;
    for (const request of attempts) {
      try { return await navigator.mediaDevices.getUserMedia(request); }
      catch (error) {
        lastError = error;
        if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError' || error?.name === 'NotFoundError') throw error;
      }
    }
    throw lastError || new Error('microphone acquisition failed');
  }

  function clearMicRecoveryTimers() {
    clearTimeout(micCaptureWatchTimer);
    clearTimeout(micRecoveryTimer);
    clearTimeout(micMuteRecoveryTimer);
    micCaptureWatchTimer = null;
    micRecoveryTimer = null;
    micMuteRecoveryTimer = null;
  }

  function scheduleMicRecovery(reason = '') {
    if (!desiredCall || micRecoveryInProgress || micRecoveryTimer) return;
    setStatus('マイク接続を復旧しています…');
    micRecoveryTimer = setTimeout(async () => {
      micRecoveryTimer = null;
      if (!desiredCall || micRecoveryInProgress) return;
      micRecoveryInProgress = true;
      try {
        cleanupAudio();
        await ensureAudio();
        if (desiredCall && socket?.readyState === WebSocket.OPEN) maybeStartCall();
        if (desiredCall && inCall) setStatus('聞いています');
        dispatch('talksys-mic-recovered', { reason, capture: micCaptureKind, settings: micSettings });
      } catch (error) {
        dispatch('talksys-mic-error', { name: error?.name || '', message: error?.message || '', recovery: true });
        if (desiredCall) setStatus('マイクを復旧できませんでした。通話ボタンを押し直してください。');
      } finally {
        micRecoveryInProgress = false;
      }
    }, 250);
  }

  function armCaptureWatchdog() {
    clearTimeout(micCaptureWatchTimer);
    const baseline = micFrameCount;
    micCaptureWatchTimer = setTimeout(() => {
      micCaptureWatchTimer = null;
      if (!desiredCall || !micReady || assistantAudioActive()) return;
      if (micFrameCount !== baseline || Date.now() - micLastFrameAt < 1200) return;

      if (micCaptureKind === 'audio-worklet') {
        try { captureNode?.disconnect(); } catch {}
        try { captureSilenceGain?.disconnect(); } catch {}
        captureNode = null;
        captureSilenceGain = null;
        if (createScriptProcessorCapture()) {
          micCaptureKind = 'script-processor';
          dispatch('talksys-mic-capture-fallback', { capture: micCaptureKind });
          armCaptureWatchdog();
          return;
        }
      }
      scheduleMicRecovery('capture-stalled');
    }, 1600);
  }

  async function ensureAudio() {
`,
  'staged microphone acquisition and recovery',
);

source = replaceOnce(
  source,
  `    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
`,
  `    mediaStream = await acquireMicrophone(constraints);
`,
  'microphone constraint fallback',
);

source = replaceOnce(
  source,
  `    micReady = true;
    micLastActiveAt = Date.now();
    armMicWatch();
    dispatch('talksys-mic-ready', { settings: micSettings, capture: workletOk ? 'audio-worklet' : 'script-processor' });
`,
  `    micReady = true;
    micCaptureKind = workletOk ? 'audio-worklet' : 'script-processor';
    micLastActiveAt = Date.now();
    micLastFrameAt = Date.now();
    armMicWatch();
    armCaptureWatchdog();
    dispatch('talksys-mic-ready', { settings: micSettings, capture: micCaptureKind });
`,
  'capture watchdog activation',
);

source = replaceOnce(
  source,
  `  function cleanupAudio() {
    clearMicWatch();
    try { mediaStream?.getTracks().forEach((track) => track.stop()); } catch {}
`,
  `  function cleanupAudio() {
    clearMicWatch();
    clearMicRecoveryTimers();
    try {
      mediaStream?.getTracks().forEach((track) => {
        try { track.onended = null; track.onmute = null; track.onunmute = null; } catch {}
        try { track.stop(); } catch {}
      });
    } catch {}
`,
  'safe microphone cleanup',
);

source = replaceOnce(
  source,
  `    micReady = false;
    micActivityFrames = 0;
  }
`,
  `    micReady = false;
    micCaptureKind = '';
    micActivityFrames = 0;
  }
`,
  'capture kind cleanup',
);

source = replaceOnce(
  source,
  `      if (data.type === 'search_status') {
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
`,
  `      if (data.type === 'search_status') {
        if (data.phase === 'searching') {
          const phrase = String(data.waitPhrase || '少し調べますね。').trim();
          const followupPhrase = String(data.followupPhrase || '').trim();
          searchWaitActive = true;
          serverAudioThisTurn = false;
          setStatus(phrase || '確認しています…');
          clearTimeout(searchWaitFollowupTimer);
          if (phrase && phrase !== lastSearchWaitPhrase && (desiredCall || typedVoiceOutput)) {
            lastSearchWaitPhrase = phrase;
            if (!assistantAudioActive()) speakJapaneseFallback(phrase, 'search-wait');
          }
          if (followupPhrase && (desiredCall || typedVoiceOutput)) {
            searchWaitFollowupTimer = setTimeout(() => {
              searchWaitFollowupTimer = null;
              if (!searchWaitActive || serverAudioThisTurn || playing || deviceSpeaking) return;
              speakJapaneseFallback(followupPhrase, 'search-wait');
            }, 2800);
          }
        } else {
          searchWaitActive = false;
          clearTimeout(searchWaitFollowupTimer);
          searchWaitFollowupTimer = null;
          lastSearchWaitPhrase = '';
          setStatus('確認した内容をまとめています…');
        }
        return;
      }
`,
  'audible adaptive search wait speech',
);

source = replaceOnce(
  source,
  `  function endCall() {
    clearCallConnectTimeout();
    clearTimeout(proactiveGreetingTimer);
    proactiveGreetingTimer = null;
`,
  `  function endCall() {
    clearCallConnectTimeout();
    clearTimeout(proactiveGreetingTimer);
    clearTimeout(searchWaitFollowupTimer);
    proactiveGreetingTimer = null;
    searchWaitFollowupTimer = null;
    searchWaitActive = false;
`,
  'search wait cleanup on call end',
);

export const CLOUDFLARE_LIVE_CLIENT_V23 = source;

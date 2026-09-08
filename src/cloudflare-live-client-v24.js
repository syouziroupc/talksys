import { CLOUDFLARE_LIVE_CLIENT_V23_FINAL } from './cloudflare-live-client-v23-final.js';

function replaceOnce(source, target, replacement, label) {
  if (!source.includes(target)) throw new Error(`TalkSys v24 client patch target missing: ${label}`);
  return source.replace(target, replacement);
}

let source = CLOUDFLARE_LIVE_CLIENT_V23_FINAL;

source = replaceOnce(
  source,
  "  const MIC_ACTIVITY_FRAMES = 2;\n",
  "  const MIC_ACTIVITY_FRAMES = 2;\n  const BARGE_IN_THRESHOLD = 0.028;\n  const BARGE_IN_FRAMES = 3;\n",
  'barge-in thresholds',
);

source = replaceOnce(
  source,
  "  let serverTtsExpectedThisTurn = false;\n",
  "  let serverTtsExpectedThisTurn = false;\n  let callStartPending = false;\n  let bargeInFrames = 0;\n  let browserStreamTtsThisTurn = false;\n  let browserStreamConsumed = 0;\n  let streamSpeechQueue = [];\n",
  'v24 transport and streaming speech state',
);

source = replaceOnce(
  source,
  `  function handleMicFrame(samples) {
    micFrameCount += 1;
    micLastFrameAt = Date.now();
    const level = rms(samples);
`,
  `  function handleMicFrame(samples) {
    micFrameCount += 1;
    micLastFrameAt = Date.now();
    const level = rms(samples);
`,
  'mic frame anchor',
);

source = replaceOnce(
  source,
  `    // Strict half-duplex while AI audio is audible. Browser AEC remains enabled,
    // but no far-end speaker audio is ever forwarded to STT. This trades barge-in
    // for reliable speakerphone behavior and prevents TalkSys from answering itself.
    if (assistantAudioActive()) return;
    if (inCall && socket?.readyState === WebSocket.OPEN) socket.send(floatToPcm(samples));
`,
  `    const transportReady = desiredCall && welcomed && micReady && socket?.readyState === WebSocket.OPEN && (inCall || callStartPending);

    // Keep AEC enabled, but allow deliberate speech to interrupt the assistant.
    // A higher threshold and three consecutive frames avoid most speaker-echo false positives.
    if (assistantAudioActive()) {
      if (transportReady && level >= BARGE_IN_THRESHOLD && micSettings?.echoCancellation !== false) {
        bargeInFrames += 1;
        if (bargeInFrames >= BARGE_IN_FRAMES) {
          bargeInFrames = 0;
          stopPlayback(true);
          playbackGuardUntil = 0;
          socket.send(floatToPcm(samples));
          dispatch('talksys-barge-in', { level, threshold: BARGE_IN_THRESHOLD });
        }
      } else {
        bargeInFrames = 0;
      }
      return;
    }

    bargeInFrames = 0;
    // Send microphone pre-roll after start_call is sent, even before the server has
    // emitted its listening status. This removes the Xperia/Android circular wait.
    if (transportReady) socket.send(floatToPcm(samples));
`,
  'full duplex barge-in and pre-listening mic frames',
);

source = replaceOnce(
  source,
  `  function maybeStartCall() {
    if (!desiredCall || !welcomed || !micReady || inCall) return;
    sendJson({ type: 'start_call', preferred_format: 'mp3' });
  }
`,
  `  function maybeStartCall() {
    if (!desiredCall || !welcomed || !micReady || inCall || callStartPending) return;
    if (sendJson({ type: 'start_call', preferred_format: 'mp3' })) {
      callStartPending = true;
      setStatus('接続しています…');
    }
  }
`,
  'single pending start_call handshake',
);

source = replaceOnce(
  source,
  `            inCall = true;
            clearCallConnectTimeout();
`,
  `            inCall = true;
            callStartPending = false;
            clearCallConnectTimeout();
`,
  'clear pending handshake on listening',
);

source = replaceOnce(
  source,
  `    socket.onclose = () => {
      welcomed = false;
      inCall = false;
`,
  `    socket.onclose = () => {
      welcomed = false;
      inCall = false;
      callStartPending = false;
`,
  'reset handshake on reconnect',
);

source = replaceOnce(
  source,
  `    proactiveGreetingDone = false;
    clearTimeout(proactiveGreetingTimer);
`,
  `    proactiveGreetingDone = false;
    callStartPending = false;
    bargeInFrames = 0;
    browserStreamTtsThisTurn = false;
    browserStreamConsumed = 0;
    streamSpeechQueue = [];
    clearTimeout(proactiveGreetingTimer);
`,
  'new call reset',
);

source = replaceOnce(
  source,
  `  function beginAssistantStream() {
    if (streamNode) return;
    clearTimeout(ttsFallbackTimer);
`,
  `  function beginAssistantStream() {
    if (streamNode) return;
    browserStreamTtsThisTurn = false;
    browserStreamConsumed = 0;
    streamSpeechQueue = [];
    clearTimeout(ttsFallbackTimer);
`,
  'stream speech turn reset',
);

source = replaceOnce(
  source,
  `  function speakJapaneseFallback(text, purpose = 'answer') {
`,
  `  function pumpStreamSpeechQueue() {
    if (!browserStreamTtsThisTurn || deviceSpeaking || deviceUtterance || !streamSpeechQueue.length) return;
    const chunk = streamSpeechQueue.shift();
    if (!speakJapaneseFallback(chunk, 'stream-answer')) streamSpeechQueue.unshift(chunk);
  }

  function queueCompletedStreamSpeech(fullText, force = false) {
    if (!(desiredCall || typedVoiceOutput) || serverAudioThisTurn) return;
    const value = String(fullText || '');
    if (!value || browserStreamConsumed >= value.length) return;
    const remaining = value.slice(browserStreamConsumed);
    let cut = -1;
    const match = remaining.match(/^([\s\S]*?[。！？!?](?:[」』】）)]?))/);
    if (match?.[1] && match[1].trim().length >= 5) cut = match[1].length;
    else if (force) cut = remaining.length;
    if (cut <= 0) return;
    const chunk = remaining.slice(0, cut).trim();
    browserStreamConsumed += cut;
    if (!chunk) return;
    browserStreamTtsThisTurn = true;
    streamSpeechQueue.push(chunk);
    pumpStreamSpeechQueue();
  }

  function speakJapaneseFallback(text, purpose = 'answer') {
`,
  'streaming browser TTS queue',
);

source = replaceOnce(
  source,
  `        deviceSpeechPurpose = '';
        playbackGuardUntil = Date.now() + PLAYBACK_TAIL_GUARD_MS;
        if (desiredCall) setTimeout(() => {
`,
  `        deviceSpeechPurpose = '';
        playbackGuardUntil = Date.now() + PLAYBACK_TAIL_GUARD_MS;
        setTimeout(() => pumpStreamSpeechQueue(), 0);
        if (desiredCall) setTimeout(() => {
`,
  'continue browser stream speech',
);

source = replaceOnce(
  source,
  `  function appendAssistantDelta(delta) {
    const value = String(delta || '');
    if (!value) return;
    beginAssistantStream();
    streamText += value;
    currentAssistantText = streamText;
    streamNode.textContent = streamText;
    streamNode.scrollIntoView({ block: 'nearest' });
  }
`,
  `  function appendAssistantDelta(delta) {
    const value = String(delta || '');
    if (!value) return;
    beginAssistantStream();
    streamText += value;
    currentAssistantText = streamText;
    streamNode.textContent = streamText;
    streamNode.scrollIntoView({ block: 'nearest' });
    queueCompletedStreamSpeech(streamText, false);
  }
`,
  'speak first complete sentence as it streams',
);

source = replaceOnce(
  source,
  `  function finishAssistantStream(finalText) {
    const value = String(finalText || streamText || '').trim();
    currentAssistantText = value;
`,
  `  function finishAssistantStream(finalText) {
    const value = String(finalText || streamText || '').trim();
    currentAssistantText = value;
    queueCompletedStreamSpeech(value, true);
`,
  'flush final streamed speech',
);

source = replaceOnce(
  source,
  `  function queueAudio(buffer) {
    clearTimeout(ttsFallbackTimer);
    ttsFallbackTimer = null;
    serverAudioThisTurn = true;
`,
  `  function queueAudio(buffer) {
    clearTimeout(ttsFallbackTimer);
    ttsFallbackTimer = null;
    if (browserStreamTtsThisTurn) return;
    serverAudioThisTurn = true;
`,
  'do not duplicate locally-started streamed speech',
);

source = replaceOnce(
  source,
  `        else {
          serverTtsExpectedThisTurn = false;
          serverAudioThisTurn = false;
          addMessage('user', data.text);
        }
`,
  `        else {
          stopPlayback(true);
          callStartPending = false;
          serverTtsExpectedThisTurn = false;
          serverAudioThisTurn = false;
          browserStreamTtsThisTurn = false;
          browserStreamConsumed = 0;
          streamSpeechQueue = [];
          addMessage('user', data.text);
        }
`,
  'hard stop old assistant speech on user transcript',
);

source = replaceOnce(
  source,
  `  function endCall() {
    clearCallConnectTimeout();
`,
  `  function endCall() {
    callStartPending = false;
    bargeInFrames = 0;
    browserStreamTtsThisTurn = false;
    browserStreamConsumed = 0;
    streamSpeechQueue = [];
    clearCallConnectTimeout();
`,
  'v24 call teardown',
);

export const CLOUDFLARE_LIVE_CLIENT_V24 = source;

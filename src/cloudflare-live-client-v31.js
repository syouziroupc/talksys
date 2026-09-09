import { CLOUDFLARE_LIVE_CLIENT_V26 } from './cloudflare-live-client-v26.js';

function replaceRequired(source, target, replacement, label) {
  if (!source.includes(target)) throw new Error(`TalkSys v31 client patch target missing: ${label}`);
  return source.replace(target, replacement);
}

let source = CLOUDFLARE_LIVE_CLIENT_V26;

source = replaceRequired(
  source,
  "  const AGENT_PATH = '/agents/talk-sys-voice-agent/default';\n",
  "  const AGENT_PATH = '/agents/talk-sys-voice-agent/default';\n  const MELO_TTS_ENDPOINT = '/api/melo-tts-v31';\n",
  'Melo TTS endpoint',
);

source = replaceRequired(
  source,
  "  let ttsFallbackTimer = null;\n",
  "  let ttsFallbackTimer = null;\n  let typedTtsGeneration = 0;\n  let typedMeloOwnsTurn = false;\n  let meloAudioBytes = 0;\n  let meloAudioChunks = 0;\n  let meloAudioLastAt = 0;\n  let meloTtsRequests = 0;\n",
  'Melo runtime state',
);

source = replaceRequired(
  source,
  "  try { window.__talksysVoiceDebug = () => microphoneDiagnostics(); } catch {}\n",
  `  try {
    window.__talksysVoiceDebug = () => ({
      ...microphoneDiagnostics(),
      ttsProvider: '@cf/myshell-ai/melotts',
      browserSpeechSynthesisEnabled: false,
      meloAudioBytes,
      meloAudioChunks,
      meloAudioLastAt,
      meloTtsRequests,
      typedVoiceOutput,
    });
  } catch {}
`,
  'combined microphone and TTS diagnostics',
);

// v24 introduced local browser speech to shave latency. That can mask the actual
// server TTS voice and can suppress server audio. v31 makes MeloTTS authoritative.
source = source.replace(/\n\s*queueCompletedStreamSpeech\(streamText, false\);/g, '');
source = source.replace(/\n\s*queueCompletedStreamSpeech\(value, true\);/g, '');

source = replaceRequired(
  source,
  "  function queueAudio(buffer) {\n",
  "  function queueAudio(buffer, sourceKind = 'server') {\n",
  'audio source tagging',
);

source = replaceRequired(
  source,
  `    if (browserStreamTtsThisTurn) return;
    serverAudioThisTurn = true;
`,
  `    browserStreamTtsThisTurn = false;
    if (sourceKind === 'server' && typedMeloOwnsTurn) return;
    if (sourceKind === 'typed-melo') typedMeloOwnsTurn = true;
    serverAudioThisTurn = true;
    const byteLength = Number(buffer?.byteLength || 0);
    meloAudioBytes += byteLength;
    meloAudioChunks += 1;
    meloAudioLastAt = Date.now();
    dispatch('talksys-melo-audio', { bytes: byteLength, totalBytes: meloAudioBytes, chunks: meloAudioChunks, source: sourceKind });
`,
  'never suppress Melo server audio',
);

source = replaceRequired(
  source,
  "  function speakJapaneseFallback(text, purpose = 'answer') {\n",
  `  function speakJapaneseFallback(text, purpose = 'answer') {
    // Device/browser speech is intentionally disabled. All audible assistant
    // replies use Cloudflare-hosted MeloTTS so Android and desktop hear one voice.
    return false;
`,
  'disable browser speech synthesis',
);

source = replaceRequired(
  source,
  "  function finishAssistantStream(finalText) {\n",
  `  async function requestTypedMeloTts(text, generation) {
    const value = String(text || '').trim();
    if (!value || desiredCall || !typedVoiceOutput) return;
    meloTtsRequests += 1;
    try {
      const response = await fetch(MELO_TTS_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: value }),
      });
      if (!response.ok) throw new Error('MeloTTS HTTP ' + response.status);
      const buffer = await response.arrayBuffer();
      if (!buffer.byteLength) throw new Error('MeloTTS returned empty audio');
      if (generation !== typedTtsGeneration || desiredCall || !typedVoiceOutput || serverAudioThisTurn) return;
      queueAudio(buffer, 'typed-melo');
      dispatch('talksys-typed-melo-tts', { bytes: buffer.byteLength, generation });
    } catch (error) {
      if (generation !== typedTtsGeneration) return;
      setStatus('音声生成に失敗しました。文字回答は利用できます。');
      dispatch('talksys-melo-tts-error', { message: String(error?.message || error).slice(0, 180) });
    }
  }

  function finishAssistantStream(finalText) {
`,
  'typed Melo requester',
);

source = replaceRequired(
  source,
  `    clearTimeout(ttsFallbackTimer);
    ttsFallbackTimer = null;
    if ((desiredCall || typedVoiceOutput) && !serverAudioThisTurn && !serverTtsExpectedThisTurn && value) {
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
  `    clearTimeout(ttsFallbackTimer);
    ttsFallbackTimer = null;
    if (typedVoiceOutput && !desiredCall && !serverAudioThisTurn && value) {
      const generation = typedTtsGeneration;
      // Give the normal voice-agent server audio a brief chance to arrive. If typed
      // turns do not receive it, synthesize the same answer with Melo explicitly.
      ttsFallbackTimer = setTimeout(() => {
        ttsFallbackTimer = null;
        if (!serverAudioThisTurn && !playing) void requestTypedMeloTts(value, generation);
      }, 700);
    }
`,
  'typed speech uses Melo rather than device fallback',
);

source = replaceRequired(
  source,
  `    typedVoiceOutput = true;
    serverAudioThisTurn = false;
`,
  `    typedVoiceOutput = true;
    typedTtsGeneration += 1;
    typedMeloOwnsTurn = false;
    stopPlayback(true);
    serverAudioThisTurn = false;
`,
  'typed turn resets prior audio',
);

source = replaceRequired(
  source,
  `          stopPlayback(true);
          callStartPending = false;
          serverTtsExpectedThisTurn = false;
          serverAudioThisTurn = false;
`,
  `          stopPlayback(true);
          callStartPending = false;
          typedMeloOwnsTurn = false;
          serverTtsExpectedThisTurn = false;
          serverAudioThisTurn = false;
`,
  'new spoken user turn resets typed Melo ownership',
);

source = replaceRequired(
  source,
  `  if ('speechSynthesis' in window) {
    try { speechSynthesis.getVoices(); } catch {}
    window.addEventListener('voiceschanged', () => { try { speechSynthesis.getVoices(); } catch {} });
  }
`,
  `  // Browser speech synthesis is deliberately not initialized in v31.
`,
  'disable browser voice initialization',
);

export const CLOUDFLARE_LIVE_CLIENT_V31 = source;

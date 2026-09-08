import { CLOUDFLARE_LIVE_CLIENT_V20 } from './cloudflare-live-client-v20.js';

function replaceOnce(source, target, replacement, label) {
  if (!source.includes(target)) throw new Error(`TalkSys v21 client patch target missing: ${label}`);
  return source.replace(target, replacement);
}

let source = CLOUDFLARE_LIVE_CLIENT_V20;

source = replaceOnce(
  source,
  "  let ttsFallbackTimer = null;\n",
  "  let ttsFallbackTimer = null;\n  let proactiveGreetingDone = false;\n  let proactiveGreetingTimer = null;\n",
  'greeting state',
);

source = replaceOnce(
  source,
  `  async function ensurePlaybackAudio() {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return false;
    audioContext = audioContext || new AudioCtor({ sampleRate: 48000 });
    if (audioContext.state !== 'running') await audioContext.resume().catch(() => {});
    return audioContext.state === 'running';
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

  function primeAudioContextFromGesture() {
    if (!audioContext || audioContext.state === 'closed') audioContext = createAudioContextCompat();
    if (!audioContext) return null;
    if (audioContext.state !== 'running') {
      try { void audioContext.resume().catch(() => {}); } catch {}
    }
    return audioContext;
  }

  async function ensurePlaybackAudio() {
    const context = primeAudioContextFromGesture();
    if (!context) return false;
    if (context.state !== 'running') await context.resume().catch(() => {});
    return context.state === 'running';
  }
`,
  'audio context compatibility',
);

source = replaceOnce(
  source,
  `    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) throw new Error('AudioContext unavailable');
    audioContext = audioContext || new AudioCtor({ sampleRate: 48000 });
    await audioContext.resume().catch(() => {});
    if (audioContext.state !== 'running') throw new Error('AudioContext is suspended');
`,
  `    if (!primeAudioContextFromGesture()) throw new Error('AudioContext unavailable');
    if (audioContext.state !== 'running') await audioContext.resume().catch(() => {});
    if (audioContext.state !== 'running') {
      await new Promise((resolve) => setTimeout(resolve, 80));
      await audioContext.resume().catch(() => {});
    }
    if (audioContext.state !== 'running') throw new Error('AudioContext is suspended');
`,
  'ensureAudio resume',
);

source = replaceOnce(
  source,
  `    micSettings = track.getSettings?.() || {};

    const AudioCtor = window.AudioContext || window.webkitAudioContext;
`,
  `    micSettings = track.getSettings?.() || {};
    track.onended = () => {
      micReady = false;
      if (desiredCall) setStatus('マイク接続を復旧しています…');
    };

    const AudioCtor = window.AudioContext || window.webkitAudioContext;
`,
  'track end monitor',
);

source = replaceOnce(
  source,
  `  function stopPlayback(interruptServer = false) {
`,
  `  function deliverProactiveGreeting() {
    if (!desiredCall || proactiveGreetingDone) return;
    proactiveGreetingDone = true;
    clearTimeout(proactiveGreetingTimer);
    proactiveGreetingTimer = null;
    const greeting = 'お電話ありがとうございます。AIチャットサポートです。今日はどのようなご相談でしょうか？';
    addMessage('assistant', greeting);
    currentAssistantText = greeting;
    serverAudioThisTurn = false;
    setStatus('AIが話しています…');
    if (!speakJapaneseFallback(greeting)) {
      proactiveGreetingTimer = setTimeout(() => {
        proactiveGreetingTimer = null;
        if (desiredCall && !assistantAudioActive()) {
          if (!speakJapaneseFallback(greeting)) setStatus('聞いています');
        }
      }, 350);
    }
  }

  function stopPlayback(interruptServer = false) {
`,
  'proactive greeting function',
);

source = replaceOnce(
  source,
  `  async function startCall() {
    manualStop = false;
    desiredCall = true;
    setVoiceUi();
    try {
`,
  `  async function startCall() {
    manualStop = false;
    desiredCall = true;
    proactiveGreetingDone = false;
    clearTimeout(proactiveGreetingTimer);
    proactiveGreetingTimer = null;
    primeAudioContextFromGesture();
    setVoiceUi();
    try {
`,
  'startCall gesture priming',
);

source = replaceOnce(
  source,
  `          if (!assistantAudioActive()) setStatus(desiredCall ? '聞いています' : '');
`,
  `          if (desiredCall && !proactiveGreetingDone) deliverProactiveGreeting();
          else if (!assistantAudioActive()) setStatus(desiredCall ? '聞いています' : '');
`,
  'listening greeting trigger',
);

source = replaceOnce(
  source,
  `  function endCall() {
    clearCallConnectTimeout();
`,
  `  function endCall() {
    clearCallConnectTimeout();
    clearTimeout(proactiveGreetingTimer);
    proactiveGreetingTimer = null;
`,
  'endCall greeting cleanup',
);

export const CLOUDFLARE_LIVE_CLIENT_V21 = source;

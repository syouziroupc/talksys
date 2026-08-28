export const VOICE_FALLBACK_CLIENT = String.raw`(() => {
  'use strict';

  if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) return;

  const status = document.getElementById('status');
  const chat = document.getElementById('chat');
  const voiceButton = document.getElementById('voice');
  if (!status || !chat) return;

  let lastSpoken = '';
  let lastSpokenAt = 0;
  let ttsActive = false;
  let ttsGeneration = 0;
  let activeUtterances = 0;
  let streamId = '';
  let streamedText = '';
  let streamEnded = false;
  let lastStreamedFinal = '';
  let lastStreamedAt = 0;

  function setTtsState(active, detail = {}) {
    if (ttsActive === active && !detail.interrupted) return;
    ttsActive = active;
    window.__talksysDeviceTtsSpeaking = active;
    window.dispatchEvent(new CustomEvent(active ? 'talksys:tts-start' : 'talksys:tts-end', { detail }));
  }

  function pickJapaneseVoice() {
    const voices = speechSynthesis.getVoices();
    const japanese = voices.filter((voice) => /^ja(?:-|_)/i.test(voice.lang || ''));
    if (!japanese.length) return null;
    return japanese.find((voice) => /Google|Microsoft|Nanami|Keita|Kyoko|Otoya|Japanese/i.test(voice.name || '')) || japanese[0];
  }

  function isVoiceSessionActive() {
    if (!voiceButton) return true;
    const text = String(voiceButton.textContent || '');
    return /通話中|接続中/.test(text) || voiceButton.classList.contains('active');
  }

  function normalize(value) {
    return String(value || '').replace(/https?:\/\/\S+/g, 'リンク').replace(/\s+/g, ' ').trim();
  }

  function cancelSpeech(interrupted = false) {
    ttsGeneration += 1;
    activeUtterances = 0;
    speechSynthesis.cancel();
    if (ttsActive) setTtsState(false, { interrupted });
  }

  function makeUtterance(text, generation) {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ja-JP';
    utterance.rate = 1.06;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;
    const voice = pickJapaneseVoice();
    if (voice) utterance.voice = voice;
    utterance.onstart = () => {
      if (generation !== ttsGeneration) return;
      setTtsState(true);
      if (isVoiceSessionActive()) status.textContent = 'AIが話しています。途中でそのまま割り込めます。';
    };
    utterance.onend = () => {
      if (generation !== ttsGeneration) return;
      activeUtterances = Math.max(0, activeUtterances - 1);
      if (activeUtterances === 0 && streamEnded) {
        setTtsState(false);
        if (isVoiceSessionActive()) status.textContent = '聞いています';
      }
    };
    utterance.onerror = () => {
      if (generation !== ttsGeneration) return;
      activeUtterances = Math.max(0, activeUtterances - 1);
      if (activeUtterances === 0) setTtsState(false);
      if (isVoiceSessionActive()) status.textContent = '日本語音声を再生できません。返答はチャット欄に表示しています。';
    };
    return utterance;
  }

  function beginStream(id) {
    if (streamId === id) return;
    cancelSpeech(false);
    streamId = id || '';
    streamedText = '';
    streamEnded = false;
  }

  function enqueueStreamChunk(detail) {
    const id = String(detail?.streamId || '');
    const text = normalize(detail?.text);
    if (!text || !isVoiceSessionActive()) return;
    if (!streamId || streamId !== id) beginStream(id);
    streamedText += (streamedText ? '' : '') + text;
    const generation = ttsGeneration;
    activeUtterances += 1;
    speechSynthesis.speak(makeUtterance(text, generation));
  }

  function finishStream(detail) {
    const id = String(detail?.streamId || '');
    if (streamId && id && id !== streamId) return;
    streamEnded = true;
    lastStreamedFinal = normalize(detail?.text) || normalize(streamedText);
    lastStreamedAt = Date.now();
    if (activeUtterances === 0) {
      setTtsState(false);
      if (isVoiceSessionActive()) status.textContent = '聞いています';
    }
  }

  function speakWhole(text) {
    const value = normalize(text);
    if (!value || !isVoiceSessionActive()) return;
    const now = Date.now();
    if (value === lastSpoken && now - lastSpokenAt < 10000) return;
    if (lastStreamedFinal && now - lastStreamedAt < 15000 && (value === lastStreamedFinal || value.includes(lastStreamedFinal) || lastStreamedFinal.includes(value))) return;
    lastSpoken = value;
    lastSpokenAt = now;
    cancelSpeech(false);
    streamId = '';
    streamedText = value;
    streamEnded = true;
    const generation = ttsGeneration;
    activeUtterances = 1;
    speechSynthesis.speak(makeUtterance(value, generation));
  }

  window.addEventListener('talksys:assistant-stream-start', (event) => beginStream(String(event.detail?.streamId || '')));
  window.addEventListener('talksys:assistant-speech-chunk', (event) => enqueueStreamChunk(event.detail || {}));
  window.addEventListener('talksys:assistant-stream-end', (event) => finishStream(event.detail || {}));
  window.addEventListener('talksys:barge-in', () => {
    cancelSpeech(true);
    streamEnded = true;
    if (isVoiceSessionActive()) status.textContent = '割り込みを聞いています…';
  });

  const chatObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (!node.classList.contains('assistant')) continue;
        speakWhole(node.textContent || '');
      }
    }
  });
  chatObserver.observe(chat, { childList: true });

  speechSynthesis.getVoices();
  window.addEventListener('beforeunload', () => {
    cancelSpeech(false);
    setTtsState(false);
  }, { once: true });
})();
`;
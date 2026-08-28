(() => {
  'use strict';

  if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) return;

  const status = document.getElementById('status');
  const chat = document.getElementById('chat');
  const voiceButton = document.getElementById('voice');
  if (!status || !chat) return;

  let lastSpoken = '';
  let lastSpokenAt = 0;
  let ttsActive = false;

  function setTtsState(active) {
    if (ttsActive === active) return;
    ttsActive = active;
    window.__talksysDeviceTtsSpeaking = active;
    window.dispatchEvent(new CustomEvent(active ? 'talksys:tts-start' : 'talksys:tts-end'));
  }

  function pickJapaneseVoice() {
    const voices = speechSynthesis.getVoices();
    const japanese = voices.filter((voice) => /^ja(?:-|_)/i.test(voice.lang || ''));
    if (!japanese.length) return null;
    return japanese.find((voice) => /Google|Microsoft|Nanami|Keita|Kyoko|Otoya|Japanese/i.test(voice.name || '')) || japanese[0];
  }

  function isVoiceSessionActive() {
    const text = String(voiceButton?.textContent || '');
    return /通話中|接続中/.test(text) || voiceButton?.classList.contains('active');
  }

  function speakJapanese(text) {
    const value = String(text || '').replace(/https?:\/\/\S+/g, 'リンク').trim();
    if (!value || !isVoiceSessionActive()) return;
    const now = Date.now();
    if (value === lastSpoken && now - lastSpokenAt < 10000) return;
    lastSpoken = value;
    lastSpokenAt = now;

    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(value);
    utterance.lang = 'ja-JP';
    utterance.rate = 1.04;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;
    const voice = pickJapaneseVoice();
    if (voice) utterance.voice = voice;
    utterance.onstart = () => {
      setTtsState(true);
      if (isVoiceSessionActive()) status.textContent = '応答を読み上げています。読み上げ後すぐ聞き取りを再開します。';
    };
    utterance.onerror = () => {
      setTtsState(false);
      if (isVoiceSessionActive()) status.textContent = '日本語音声を再生できません。返答はチャット欄に表示しています。';
    };
    utterance.onend = () => {
      setTtsState(false);
      if (isVoiceSessionActive()) status.textContent = '聞いています';
    };
    speechSynthesis.speak(utterance);
  }

  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (!node.classList.contains('assistant')) continue;
        speakJapanese(node.textContent || '');
      }
    }
  }).observe(chat, { childList: true });

  speechSynthesis.getVoices();
  window.addEventListener('beforeunload', () => {
    speechSynthesis.cancel();
    setTtsState(false);
  }, { once: true });
})();

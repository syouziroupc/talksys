export const VOICE_FALLBACK_CLIENT = String.raw`(() => {
  'use strict';

  if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) return;

  const status = document.getElementById('status');
  const chat = document.getElementById('chat');
  const voiceButton = document.getElementById('voice');
  if (!status || !chat) return;

  let lastSpoken = '';
  let lastSpokenAt = 0;

  function pickJapaneseVoice() {
    const voices = speechSynthesis.getVoices();
    const japanese = voices.filter((voice) => /^ja(?:-|_)/i.test(voice.lang || ''));
    if (!japanese.length) return null;
    const preferred = japanese.find((voice) => /Google|Microsoft|Nanami|Keita|Kyoko|Otoya/i.test(voice.name || ''));
    return preferred || japanese[0];
  }

  function latestAssistantText() {
    const nodes = chat.querySelectorAll('.msg.assistant');
    if (!nodes.length) return '';
    return String(nodes[nodes.length - 1].textContent || '').trim();
  }

  function isVoiceSessionActive() {
    if (!voiceButton) return true;
    const text = String(voiceButton.textContent || '');
    return /通話中|接続中/.test(text) || voiceButton.classList.contains('active');
  }

  function speakFallback(text) {
    const value = String(text || '').trim();
    if (!value || !isVoiceSessionActive()) return;
    const now = Date.now();
    if (value === lastSpoken && now - lastSpokenAt < 12000) return;
    lastSpoken = value;
    lastSpokenAt = now;

    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(value);
    utterance.lang = 'ja-JP';
    utterance.rate = 1.02;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;
    const voice = pickJapaneseVoice();
    if (voice) utterance.voice = voice;
    utterance.onstart = () => {
      status.textContent = 'クラウド音声に障害があるため、端末の日本語音声で読み上げています。';
    };
    utterance.onerror = () => {
      status.textContent = '読み上げに失敗しました。返答はチャット欄に表示しています。';
    };
    utterance.onend = () => {
      if (isVoiceSessionActive()) status.textContent = '聞いています';
    };
    speechSynthesis.speak(utterance);
  }

  const observer = new MutationObserver(() => {
    const text = String(status.textContent || '');
    if (!/(3043|Internal server error|音声エラー)/i.test(text)) return;
    speakFallback(latestAssistantText());
  });
  observer.observe(status, { childList: true, characterData: true, subtree: true });

  window.addEventListener('beforeunload', () => speechSynthesis.cancel(), { once: true });
})();
`;
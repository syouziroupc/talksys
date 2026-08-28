export const VOICE_FALLBACK_CLIENT = String.raw`(() => {
  'use strict';

  const status = document.getElementById('status');
  const chat = document.getElementById('chat');
  const voiceButton = document.getElementById('voice');
  const form = document.getElementById('form');
  const input = document.getElementById('input');
  const sendButton = document.getElementById('send');
  if (!status || !chat) return;

  const canTts = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  let textSocket = null;
  let textWelcomed = false;
  let textBusy = false;
  let queuedText = '';

  function addMessage(role, text) {
    if (!text) return;
    const node = document.createElement('div');
    node.className = 'msg ' + role;
    node.textContent = text;
    chat.appendChild(node);
    node.scrollIntoView({ block: 'nearest' });
  }

  function agentWsUrl() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return protocol + '//' + location.host + '/agents/talk-sys-voice-agent/default';
  }

  function finishTypedTurn() {
    textBusy = false;
    if (sendButton) sendButton.disabled = false;
    if (input) input.focus();
    if (!isVoiceSessionActive()) status.textContent = '';
  }

  function sendQueuedText() {
    if (!textWelcomed || !queuedText || !textSocket || textSocket.readyState !== WebSocket.OPEN) return;
    const value = queuedText;
    queuedText = '';
    textSocket.send(JSON.stringify({ type: 'text_message', text: value }));
  }

  function ensureTextSocket() {
    if (textSocket && (textSocket.readyState === WebSocket.OPEN || textSocket.readyState === WebSocket.CONNECTING)) {
      sendQueuedText();
      return;
    }
    textWelcomed = false;
    textSocket = new WebSocket(agentWsUrl());
    textSocket.addEventListener('open', () => {
      textSocket.send(JSON.stringify({ type: 'hello', protocol_version: 1 }));
    });
    textSocket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.type === 'welcome') {
        textWelcomed = true;
        sendQueuedText();
        return;
      }
      if (data.type === 'search_status') {
        status.textContent = data.phase === 'searching' ? '確認のため検索しています…' : '検索結果から答えています…';
        return;
      }
      if (data.type === 'assistant_stream_start') {
        window.dispatchEvent(new CustomEvent('talksys:assistant-stream-start', { detail: data }));
        return;
      }
      if (data.type === 'assistant_speech_chunk') {
        window.dispatchEvent(new CustomEvent('talksys:assistant-speech-chunk', { detail: data }));
        return;
      }
      if (data.type === 'assistant_stream_end') {
        window.dispatchEvent(new CustomEvent('talksys:assistant-stream-end', { detail: data }));
        return;
      }
      if (data.type === 'transcript' && data.role === 'assistant' && data.text) {
        addMessage('assistant', data.text);
        finishTypedTurn();
        return;
      }
      if (data.type === 'error') {
        addMessage('assistant', 'エラー: ' + (data.message || '応答に失敗しました'));
        finishTypedTurn();
      }
    });
    textSocket.addEventListener('close', () => {
      textWelcomed = false;
      if (textBusy) {
        addMessage('assistant', '接続が切れました。もう一度送ってください。');
        queuedText = '';
        finishTypedTurn();
      }
    });
    textSocket.addEventListener('error', () => {
      if (textBusy) status.textContent = '文字チャット接続を再確認しています…';
    });
  }

  function submitTyped(event) {
    const value = String(input?.value || '').trim();
    if (!value || textBusy) return false;
    if (event) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    textBusy = true;
    queuedText = value;
    if (input) input.value = '';
    if (sendButton) sendButton.disabled = true;
    addMessage('user', value);
    status.textContent = '考えています…';
    ensureTextSocket();
    sendQueuedText();
    return true;
  }

  if (form && input) {
    form.addEventListener('submit', (event) => submitTyped(event), true);
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey) return;
      submitTyped(event);
    }, true);
  }

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
    if (!canTts) return null;
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
    if (!canTts) return;
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
    if (!canTts || streamId === id) return;
    cancelSpeech(false);
    streamId = id || '';
    streamedText = '';
    streamEnded = false;
  }

  function enqueueStreamChunk(detail) {
    if (!canTts) return;
    const id = String(detail?.streamId || '');
    const text = normalize(detail?.text);
    if (!text || !isVoiceSessionActive()) return;
    if (!streamId || streamId !== id) beginStream(id);
    streamedText += text;
    const generation = ttsGeneration;
    activeUtterances += 1;
    speechSynthesis.speak(makeUtterance(text, generation));
  }

  function finishStream(detail) {
    if (!canTts) return;
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
    if (!canTts) return;
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

  if (canTts) {
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
  }

  window.addEventListener('beforeunload', () => {
    cancelSpeech(false);
    setTtsState(false);
    try { textSocket?.close(); } catch {}
  }, { once: true });
})();
`;
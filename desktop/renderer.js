const form = document.getElementById('form');
const input = document.getElementById('input');
const chat = document.getElementById('chat');
const send = document.getElementById('send');
const status = document.getElementById('status');
const voice = document.getElementById('voice');
const capture = document.getElementById('capture');
const clear = document.getElementById('clear');
const apiBase = document.getElementById('apiBase');
const messages = [];

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const canSpeak = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
let recognition = null;
let listening = false;
let voiceSession = false;

function addMessage(role, text) {
  const node = document.createElement('div');
  node.className = `msg ${role}`;
  node.textContent = text;
  chat.appendChild(node);
  node.scrollIntoView({ block: 'nearest' });
}

function shouldLocate(text) {
  return /(開きたい|開いて|開くには|押して|押す|クリック|タップ|どこ|探して|探す|見つけ|指して|矢印|案内|選んで|ボタン|アイコン|メニュー|タブ)/i.test(text);
}

function speak(text) {
  if (!voiceSession || !canSpeak) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'ja-JP';
  utterance.onstart = () => { status.textContent = '読み上げ中…'; };
  utterance.onend = utterance.onerror = () => { status.textContent = ''; input.focus(); };
  window.speechSynthesis.speak(utterance);
}

async function guide(text) {
  try {
    status.textContent = '画面から対象を探しています…';
    const result = await window.talksys.locate(text, apiBase.value.trim());
    if (result.found) status.textContent = `矢印: ${result.label || '対象'}`;
    else status.textContent = result.note || '画面上に対象を特定できませんでした。';
  } catch (error) {
    status.textContent = `画面案内エラー: ${error.message}`;
  }
}

async function submit() {
  const text = input.value.trim();
  if (!text || send.disabled) return;
  if (listening && recognition) recognition.stop();

  messages.push({ role: 'user', content: text });
  addMessage('user', text);
  input.value = '';
  send.disabled = true;
  voice.disabled = true;
  status.textContent = '回答中…';

  if (shouldLocate(text)) void guide(text);

  try {
    const result = await window.talksys.chat(messages, apiBase.value.trim());
    messages.push({ role: 'assistant', content: result.reply });
    addMessage('assistant', result.reply);
    speak(result.reply);
  } catch (error) {
    addMessage('assistant', `エラー: ${error.message}`);
  } finally {
    send.disabled = false;
    voice.disabled = !Recognition;
    if (!voiceSession && !status.textContent.startsWith('矢印:')) status.textContent = '';
    input.focus();
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  submit();
});

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submit();
  }
});

capture.addEventListener('click', async () => {
  capture.disabled = true;
  try {
    const result = await window.talksys.saveCapture();
    status.textContent = result.saved ? `保存: ${result.filePath}` : '保存をキャンセルしました。';
  } catch (error) {
    status.textContent = `キャプチャーエラー: ${error.message}`;
  } finally {
    capture.disabled = false;
  }
});

clear.addEventListener('click', async () => {
  await window.talksys.clearOverlay();
  status.textContent = '矢印を消しました。';
});

if (Recognition) {
  recognition = new Recognition();
  recognition.lang = 'ja-JP';
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.onstart = () => {
    listening = true;
    voiceSession = true;
    voice.classList.add('active');
    voice.textContent = '■ 停止';
    status.textContent = '聞き取り中…';
  };
  recognition.onend = () => {
    listening = false;
    voice.classList.remove('active');
    voice.textContent = '🎙 音声';
    if (status.textContent === '聞き取り中…') status.textContent = '';
  };
  recognition.onerror = (event) => {
    if (event.error !== 'aborted' && event.error !== 'no-speech') {
      status.textContent = '音声入力を開始できませんでした。';
    }
  };
  recognition.onresult = (event) => {
    const text = event.results?.[0]?.[0]?.transcript?.trim() || '';
    if (!text) return;
    input.value = text;
    submit();
  };
  voice.addEventListener('click', () => {
    if (send.disabled) return;
    if (listening) {
      recognition.stop();
      return;
    }
    if (canSpeak) window.speechSynthesis.cancel();
    try { recognition.start(); } catch { status.textContent = '音声入力を開始できませんでした。'; }
  });
} else {
  voice.disabled = true;
  voice.textContent = '音声入力非対応';
}

window.talksys.getConfig().then((config) => {
  apiBase.value = config.apiBase || 'http://127.0.0.1:8787';
}).catch(() => {
  apiBase.value = 'http://127.0.0.1:8787';
});

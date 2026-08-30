'use strict';

(() => {
  const MODEL = 'gemini-3.5-transcribe-live';
  const INPUT_RATE = 16000;
  const CHUNK_MS = 40;
  const END_SILENCE_MS = 560;
  const ROTATE_MS = 8 * 60 * 1000;
  const CUSTOM_VOCABULARY = [
    'TalkSys','Gemini','Gemini Live','Google Search','Cloudflare','Workers','GitHub','Windows','Android','iPhone','Linux',
    'CPU','GPU','Wi-Fi','WebSocket','API','STT','TTS','HIFU','EMS','LLM','AI','Chrome','Edge','Electron','JavaScript',
    'TypeScript','Python','OpenAI','ChatGPT','Qwen','Whisper','Deepgram','Nova-3','SSD','NVMe','BIOS','UEFI','USB','HDMI',
    'Bluetooth','Ethernet','DNS','HTTP','HTTPS','JSON','REST','VAD','PCM','WAV','Docker','Kubernetes','Node.js','Git'
  ];

  const chat = document.getElementById('chat');
  const status = document.getElementById('status');
  const voice = document.getElementById('voice');
  const form = document.getElementById('form');
  const apiBase = document.getElementById('apiBase');
  if (!chat || !status || !voice || !apiBase) return;

  const indicator = document.createElement('div');
  indicator.style.cssText = 'min-height:20px;padding:0 14px 6px;font-size:11px;color:#71717a;white-space:pre-wrap';
  status.insertAdjacentElement('afterend', indicator);

  let ws = null;
  let ready = false;
  let shouldRun = true;
  let reconnectTimer = null;
  let rotateTimer = null;
  let audioContext = null;
  let micStream = null;
  let micSource = null;
  let worklet = null;
  let noiseFloor = 0.006;
  let speech = false;
  let speechFrames = 0;
  let silenceMs = 0;
  let audioStreamOpen = false;
  let finalText = '';
  let lastTypedAt = 0;

  form?.addEventListener('submit', () => { lastTypedAt = Date.now(); }, true);

  function base() {
    try { return new URL(apiBase.value.trim()).toString().replace(/\/$/, ''); }
    catch { return 'https://talksys.syouziroupc.workers.dev'; }
  }
  function indicatorText(text) { indicator.textContent = text ? '高精度文字起こし: ' + text : ''; }
  function bytesToBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + 0x8000)));
    return btoa(s);
  }
  function toPcm(samples) {
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const v = Math.max(-1, Math.min(1, samples[i]));
      pcm[i] = v < 0 ? v * 32768 : v * 32767;
    }
    return bytesToBase64(new Uint8Array(pcm.buffer));
  }
  function rms(samples) {
    let sum = 0;
    for (const v of samples) sum += v * v;
    return Math.sqrt(sum / Math.max(1, samples.length));
  }
  function send(message) {
    if (!ready || !ws || ws.readyState !== WebSocket.OPEN) return false;
    try { ws.send(JSON.stringify(message)); return true; } catch { return false; }
  }
  function endStream() {
    if (audioStreamOpen && send({ realtimeInput: { audioStreamEnd: true } })) audioStreamOpen = false;
  }
  function voiceActive() { return voice.classList.contains('active') || /通話中/.test(voice.textContent || ''); }
  function modelSpeaking() { return /Geminiが話しています/.test(status.textContent || ''); }

  function apply(text) {
    const value = String(text || '').trim();
    if (!value) return;
    finalText = value;
    indicatorText(value);
    if (Date.now() - lastTypedAt < 3500) return;
    const users = chat.querySelectorAll('.msg.user');
    const node = users[users.length - 1];
    if (node) node.textContent = value;
  }

  new MutationObserver(() => {
    if (!finalText || Date.now() - lastTypedAt < 3500) return;
    const users = chat.querySelectorAll('.msg.user');
    const node = users[users.length - 1];
    if (node && node.textContent !== finalText) node.textContent = finalText;
  }).observe(chat, { childList: true });

  async function token() {
    const res = await fetch(base() + '/api/gemini-live-token', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ purpose: 'transcription' })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token || data.model !== MODEL) throw new Error(data.reason || 'transcription token failed');
    return data;
  }

  async function connect() {
    if (!shouldRun || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) return;
    const t = await token();
    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('transcription setup timeout')); } }, 8000);
      ws = new WebSocket(t.endpoint + '?access_token=' + encodeURIComponent(t.token));
      ws.onopen = () => ws.send(JSON.stringify({ setup: {
        model: 'models/' + MODEL,
        generationConfig: { responseModalities: ['TEXT'] },
        inputAudioTranscription: { languageCodes: ['ja-JP'], customVocabulary: CUSTOM_VOCABULARY, mode: 'SMART' },
        realtimeInputConfig: {
          automaticActivityDetection: { disabled: false, startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH', endOfSpeechSensitivity: 'END_SENSITIVITY_LOW', prefixPaddingMs: 180, silenceDurationMs: 800 },
          turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY'
        }
      }}));
      ws.onmessage = (event) => {
        let m; try { m = JSON.parse(event.data); } catch { return; }
        if (m.setupComplete && !settled) { ready = true; settled = true; clearTimeout(timer); resolve(); }
        const c = m.serverContent;
        if (c?.interimInputTranscription?.text) indicatorText(String(c.interimInputTranscription.text).trim());
        if (c?.inputTranscription?.text) apply(c.inputTranscription.text);
      };
      ws.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('transcription websocket error')); } };
      ws.onclose = () => {
        ready = false; clearTimeout(rotateTimer);
        if (shouldRun) reconnectTimer = setTimeout(() => connect().catch(() => {}), 700);
      };
    });
    clearTimeout(rotateTimer);
    rotateTimer = setTimeout(() => { try { ws?.close(1000, 'transcription_rotation'); } catch {} }, ROTATE_MS);
  }

  const WORKLET = "class DesktopTranscribeCapture extends AudioWorkletProcessor{constructor(){super();this.b=[];this.r=sampleRate/16000}process(i){const x=i[0];if(!x||!x[0])return true;const d=x[0];for(let p=0;p<d.length;p+=this.r){const n=Math.floor(p),f=p-n;this.b.push(n+1<d.length?d[n]*(1-f)+d[n+1]*f:(d[n]||0))}while(this.b.length>=640){const a=new Float32Array(this.b.splice(0,640));this.port.postMessage(a,[a.buffer])}return true}}registerProcessor('desktop-transcribe-capture',DesktopTranscribeCapture);";

  function frame(samples) {
    if (!ready || !voiceActive() || modelSpeaking()) return;
    const l = rms(samples);
    if (!speech && l < 0.025) noiseFloor = noiseFloor * 0.985 + l * 0.015;
    const start = Math.max(0.014, noiseFloor * 2.7);
    const end = Math.max(0.009, noiseFloor * 1.65);
    if (!speech) {
      if (l >= start) speechFrames++; else speechFrames = Math.max(0, speechFrames - 1);
      if (speechFrames >= 2) { speech = true; silenceMs = 0; finalText = ''; }
    }
    if (send({ realtimeInput: { audio: { data: toPcm(samples), mimeType: 'audio/pcm;rate=' + INPUT_RATE } } })) audioStreamOpen = true;
    if (!speech) return;
    if (l <= end) silenceMs += CHUNK_MS; else silenceMs = 0;
    if (silenceMs >= END_SILENCE_MS) { endStream(); speech = false; speechFrames = 0; silenceMs = 0; }
  }

  async function capture() {
    audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    await audioContext.resume().catch(() => {});
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    try { await audioContext.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    micSource = audioContext.createMediaStreamSource(micStream);
    worklet = new AudioWorkletNode(audioContext, 'desktop-transcribe-capture');
    worklet.port.onmessage = (e) => frame(e.data instanceof Float32Array ? e.data : new Float32Array(e.data));
    micSource.connect(worklet); worklet.connect(audioContext.destination);
  }

  const boot = async () => {
    for (let i = 0; i < 40 && !apiBase.value.trim(); i++) await new Promise(r => setTimeout(r, 50));
    await Promise.all([connect(), capture()]);
  };
  boot().catch(() => { indicator.textContent = ''; });

  window.addEventListener('beforeunload', () => {
    shouldRun = false; clearTimeout(reconnectTimer); clearTimeout(rotateTimer); endStream();
    try { ws?.close(1000, 'desktop_close'); } catch {}
    micStream?.getTracks().forEach(t => t.stop());
    try { micSource?.disconnect(); } catch {}; try { worklet?.disconnect(); } catch {};
  }, { once: true });
})();
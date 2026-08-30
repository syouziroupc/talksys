export const GEMINI_TRANSCRIBE_COMPANION = String.raw`(() => {
  'use strict';

  const TOKEN_ENDPOINT = '/api/gemini-live-token';
  const MODEL = 'gemini-3.5-transcribe-live';
  const INPUT_RATE = 16000;
  const CHUNK_SAMPLES = 640;
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
  if (!chat || !status || !voice) return;

  const indicator = document.createElement('div');
  indicator.id = 'talksysHighAccuracyTranscript';
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
  let interim = '';
  let finalText = '';
  let lastTypedAt = 0;
  let lastApplied = '';

  form?.addEventListener('submit', () => { lastTypedAt = Date.now(); }, true);

  function setIndicator(text) {
    indicator.textContent = text ? '高精度文字起こし: ' + text : '';
  }

  function bytesToBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + 0x8000)));
    return btoa(s);
  }

  function toPcm(samples) {
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
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
    if (!audioStreamOpen) return;
    if (send({ realtimeInput: { audioStreamEnd: true } })) audioStreamOpen = false;
  }

  function modelIsSpeaking() {
    const text = String(status.textContent || '');
    return /Geminiが話しています|AIが話しています|読み上げ中/.test(text);
  }

  function voiceIsActive() {
    return voice.classList.contains('active') || /通話中/.test(String(voice.textContent || ''));
  }

  function applyFinalTranscript(text) {
    const value = String(text || '').trim();
    if (!value || value === lastApplied) return;
    lastApplied = value;
    setIndicator(value);
    // Do not rewrite a typed message. For spoken turns, replace the newest user
    // bubble with the dedicated transcription once the primary Live client has
    // rendered it. If that bubble arrives slightly later, the observer below
    // applies the correction then.
    if (Date.now() - lastTypedAt < 3500) return;
    const users = chat.querySelectorAll('.msg.user');
    const node = users[users.length - 1];
    if (node) node.textContent = value;
  }

  const observer = new MutationObserver(() => {
    if (!finalText || Date.now() - lastTypedAt < 3500) return;
    const users = chat.querySelectorAll('.msg.user');
    const node = users[users.length - 1];
    if (node && node.textContent !== finalText) node.textContent = finalText;
  });
  observer.observe(chat, { childList: true });

  function handleServer(message) {
    if (message.setupComplete) { ready = true; return; }
    const c = message.serverContent;
    if (!c) return;
    if (c.interimInputTranscription?.text) {
      interim = String(c.interimInputTranscription.text || '').trim();
      if (interim) setIndicator(interim);
    }
    if (c.inputTranscription?.text) {
      finalText = String(c.inputTranscription.text || '').trim();
      interim = '';
      applyFinalTranscript(finalText);
    }
  }

  async function fetchToken() {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST', headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify({ purpose: 'transcription' })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.available || !data.token || data.model !== MODEL) throw new Error(data.reason || 'transcription token failed');
    return data;
  }

  async function connect() {
    if (!shouldRun || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) return;
    const token = await fetchToken();
    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('transcription setup timeout')); } }, 8000);
      ws = new WebSocket(token.endpoint + '?access_token=' + encodeURIComponent(token.token));
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
        let message; try { message = JSON.parse(event.data); } catch { return; }
        if (message.setupComplete && !settled) { settled = true; clearTimeout(timer); resolve(); }
        handleServer(message);
      };
      ws.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('transcription websocket error')); } };
      ws.onclose = () => {
        ready = false;
        clearTimeout(rotateTimer);
        if (!shouldRun) return;
        reconnectTimer = setTimeout(() => connect().catch(() => {}), 700);
      };
    });
    clearTimeout(rotateTimer);
    rotateTimer = setTimeout(() => { try { ws?.close(1000, 'transcription_rotation'); } catch {} }, ROTATE_MS);
  }

  const WORKLET = "class TalkSysTranscribeCapture extends AudioWorkletProcessor{constructor(){super();this.b=[];this.r=sampleRate/16000}process(i){const x=i[0];if(!x||!x[0])return true;const d=x[0];for(let p=0;p<d.length;p+=this.r){const n=Math.floor(p),f=p-n;this.b.push(n+1<d.length?d[n]*(1-f)+d[n+1]*f:(d[n]||0))}while(this.b.length>=640){const a=new Float32Array(this.b.splice(0,640));this.port.postMessage(a,[a.buffer])}return true}}registerProcessor('talksys-transcribe-capture',TalkSysTranscribeCapture);";

  function handleFrame(samples) {
    if (!ready || !voiceIsActive() || modelIsSpeaking()) return;
    const level = rms(samples);
    if (!speech && level < 0.025) noiseFloor = noiseFloor * 0.985 + level * 0.015;
    const start = Math.max(0.014, noiseFloor * 2.7);
    const end = Math.max(0.009, noiseFloor * 1.65);
    if (!speech) {
      if (level >= start) speechFrames += 1; else speechFrames = Math.max(0, speechFrames - 1);
      if (speechFrames >= 2) { speech = true; silenceMs = 0; finalText = ''; lastApplied = ''; }
    }
    if (send({ realtimeInput: { audio: { data: toPcm(samples), mimeType: 'audio/pcm;rate=' + INPUT_RATE } } })) audioStreamOpen = true;
    if (!speech) return;
    if (level <= end) silenceMs += CHUNK_MS; else silenceMs = 0;
    if (silenceMs >= END_SILENCE_MS) {
      endStream(); speech = false; speechFrames = 0; silenceMs = 0;
    }
  }

  async function startCapture() {
    const ctx = audioContext || new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    audioContext = ctx;
    await ctx.resume().catch(() => {});
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
    const moduleUrl = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    try { await ctx.audioWorklet.addModule(moduleUrl); } finally { URL.revokeObjectURL(moduleUrl); }
    micSource = ctx.createMediaStreamSource(micStream);
    worklet = new AudioWorkletNode(ctx, 'talksys-transcribe-capture');
    worklet.port.onmessage = (event) => handleFrame(event.data instanceof Float32Array ? event.data : new Float32Array(event.data));
    micSource.connect(worklet);
    worklet.connect(ctx.destination);
  }

  Promise.all([connect(), startCapture()]).catch(() => {
    // Dedicated transcription is quality enhancement only. Native Gemini Live
    // conversation remains active if this companion cannot start.
    indicator.textContent = '';
  });

  window.addEventListener('beforeunload', () => {
    shouldRun = false; clearTimeout(reconnectTimer); clearTimeout(rotateTimer); endStream(); observer.disconnect();
    try { ws?.close(1000, 'page_unload'); } catch {}
    micStream?.getTracks().forEach((track) => track.stop());
    try { micSource?.disconnect(); } catch {}
    try { worklet?.disconnect(); } catch {}
  }, { once: true });
})();
`;
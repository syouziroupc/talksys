export const GEMINI_LIVE_CLIENT = String.raw`(() => {
  'use strict';

  // Gemini Live is the primary TalkSys conversation path. The legacy Cloudflare
  // Voice client is loaded only when the server cannot mint a Gemini token.
  window.__talksysGeminiLivePrimary = true;

  const MODEL = 'gemini-3.1-flash-live-preview';
  const TOKEN_ENDPOINT = '/api/gemini-live-token';
  const INPUT_RATE = 16000;
  const OUTPUT_RATE = 24000;
  const CHUNK_SAMPLES = 640; // 40 ms at 16 kHz
  const RECONNECT_MS = 350;
  const MAX_SETUP_MS = 9000;
  const ECHO_BARGE_THRESHOLD = 0.052;
  const ECHO_BARGE_FRAMES = 4;
  const PRE_ROLL_FRAMES = 8;
  const HANDLE_KEY = 'talksys.gemini.live.handle';

  const SYSTEM_INSTRUCTION = [
    'あなたはTalkSysという日本語のリアルタイム音声アシスタントです。',
    '原則として自然な日本語で話し、ユーザーが別の言語を明示的に求めた場合だけ切り替えてください。',
    '日常会話では普通の会話相手として自然に応答してください。質問や相談には通常2〜5文で、直接回答に加えて理由・補足・具体例のどれかを少なくとも1つ含め、短すぎる一言回答を避けてください。',
    '外部の事実、現在情報、人物、ニュース、価格、法律、制度、製品仕様、技術仕様、医療・科学上の事実など、誤る可能性のある知識質問にはGoogle Searchを積極的に使って確認してください。モデルの記憶だけで具体的な固有名詞・数字・日付・仕様を作らないでください。',
    'Google Searchを使う必要がある質問では、自然なら最初に「ちょっと調べますね。」と短く伝えてから、検索で確認できた内容だけを回答してください。確認できなければ推測せず、確認できなかったと伝えてください。',
    '検索結果同士が食い違う場合は断定せず、その不一致を短く説明してください。URLを音読しないでください。',
    '現在のPC画面について答える必要がある時だけinspect_current_screenを使ってください。ツール結果に無い画面内容や、実行していない操作を見た・実行したと主張しないでください。',
    '音声入力と文字チャットは同じ会話です。直前までの文脈を保ってください。',
    'ユーザーが話し始めて割り込んだら、現在の発話を止めてユーザーを優先してください。',
  ].join('\n');

  const originalVoice = document.getElementById('voice');
  const originalForm = document.getElementById('form');
  const chat = document.getElementById('chat');
  const status = document.getElementById('status');
  if (!originalVoice || !originalForm || !chat || !status) return;

  // Remove the old inline WebSpeech / REST chat listeners without touching the
  // screen-share controls. Gemini gets exclusive ownership of voice + chat.
  const voice = originalVoice.cloneNode(true);
  originalVoice.replaceWith(voice);
  const form = originalForm.cloneNode(true);
  originalForm.replaceWith(form);
  const input = form.querySelector('#input');
  const send = form.querySelector('#send');

  let liveSocket = null;
  let liveReady = false;
  let setupPromise = null;
  let setupResolve = null;
  let setupReject = null;
  let reconnectTimer = null;
  let shouldReconnect = true;
  let legacyActivated = false;
  let sessionHandle = sessionStorage.getItem(HANDLE_KEY) || '';
  let tokenInfo = null;
  let closeFailures = 0;

  let audioContext = null;
  let micStream = null;
  let micSource = null;
  let worklet = null;
  let micEnabled = false;
  let micReady = false;
  let micFrames = 0;
  let noiseFloor = 0.008;
  let preRoll = [];
  let bargeFrames = 0;
  let bargeActive = false;

  let playbackCursor = 0;
  let playbackEpoch = 0;
  let playbackSources = new Set();
  let modelSpeaking = false;
  let modelTurnComplete = true;
  let audioStreamOpen = false;

  let inputTranscript = '';
  let outputTranscript = '';
  let typedTurnOpen = false;
  let lastMessageKey = '';
  let groundingSources = new Map();
  let pendingTyped = [];

  function setStatus(text) {
    status.textContent = text || '';
  }

  function addMessage(role, text) {
    const value = String(text || '').trim();
    if (!value) return;
    const key = role + ':' + value;
    if (key === lastMessageKey) return;
    lastMessageKey = key;
    const node = document.createElement('div');
    node.className = 'msg ' + role;
    node.textContent = value;
    chat.appendChild(node);
    node.scrollIntoView({ block: 'nearest' });
  }

  function addSources() {
    if (!groundingSources.size) return;
    const node = document.createElement('div');
    node.className = 'msg assistant';
    const label = document.createElement('div');
    label.textContent = '検索出典';
    label.style.fontSize = '12px';
    label.style.fontWeight = '700';
    label.style.marginBottom = '5px';
    node.appendChild(label);
    let count = 0;
    for (const source of groundingSources.values()) {
      if (count >= 4) break;
      const a = document.createElement('a');
      a.href = source.uri;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = source.title || source.uri;
      a.style.display = 'block';
      a.style.fontSize = '12px';
      a.style.marginTop = '3px';
      node.appendChild(a);
      count += 1;
    }
    chat.appendChild(node);
    node.scrollIntoView({ block: 'nearest' });
  }

  function mergeTranscript(current, incoming) {
    const next = String(incoming || '').trim();
    if (!next) return current;
    if (!current) return next;
    if (next === current || current.endsWith(next)) return current;
    if (next.startsWith(current)) return next;
    if (current.endsWith(' ') || /^[、。！？,.!?]/.test(next)) return current + next;
    return current + ' ' + next;
  }

  function finalizeInputTranscript() {
    if (typedTurnOpen) return;
    const text = inputTranscript.trim();
    if (text) addMessage('user', text);
    inputTranscript = '';
  }

  function finalizeOutputTranscript() {
    const text = outputTranscript.trim();
    if (text) addMessage('assistant', text);
    outputTranscript = '';
    typedTurnOpen = false;
  }

  function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + chunk)));
    }
    return btoa(binary);
  }

  function samplesToPcmBase64(samples) {
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      const value = Math.max(-1, Math.min(1, samples[i]));
      pcm[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
    }
    return bytesToBase64(new Uint8Array(pcm.buffer));
  }

  function base64ToPcmFloat(data) {
    const binary = atob(String(data || ''));
    const length = Math.floor(binary.length / 2);
    const out = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      const lo = binary.charCodeAt(i * 2) & 255;
      const hi = binary.charCodeAt(i * 2 + 1) & 255;
      let sample = lo | (hi << 8);
      if (sample & 0x8000) sample -= 0x10000;
      out[i] = sample / 32768;
    }
    return out;
  }

  function rms(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
    return Math.sqrt(sum / Math.max(1, samples.length));
  }

  function sendLive(message) {
    if (!liveSocket || liveSocket.readyState !== WebSocket.OPEN || !liveReady) return false;
    try {
      liveSocket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  function markAudioStreamEnd() {
    if (!audioStreamOpen) return;
    sendLive({ realtimeInput: { audioStreamEnd: true } });
    audioStreamOpen = false;
  }

  function stopPlayback(interrupted = false) {
    playbackEpoch += 1;
    for (const source of playbackSources) {
      try { source.stop(); } catch {}
      try { source.disconnect(); } catch {}
    }
    playbackSources.clear();
    playbackCursor = audioContext ? audioContext.currentTime : 0;
    modelSpeaking = false;
    if (interrupted) setStatus('聞いています');
  }

  function maybeFinishPlayback(epoch) {
    if (epoch !== playbackEpoch) return;
    if (!modelTurnComplete || playbackSources.size) return;
    modelSpeaking = false;
    bargeActive = false;
    bargeFrames = 0;
    preRoll = [];
    if (micEnabled) setStatus('聞いています');
  }

  async function ensureAudioContext() {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    if (audioContext.state !== 'running') await audioContext.resume().catch(() => {});
    return audioContext;
  }

  async function queueModelAudio(base64) {
    const ctx = await ensureAudioContext();
    const samples = base64ToPcmFloat(base64);
    if (!samples.length) return;

    if (!modelSpeaking) {
      modelSpeaking = true;
      modelTurnComplete = false;
      bargeFrames = 0;
      preRoll = [];
      markAudioStreamEnd();
      setStatus('Geminiが話しています。途中で割り込めます。');
    }

    const buffer = ctx.createBuffer(1, samples.length, OUTPUT_RATE);
    buffer.copyToChannel(samples, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const epoch = playbackEpoch;
    const startAt = Math.max(ctx.currentTime + 0.025, playbackCursor || 0);
    playbackCursor = startAt + buffer.duration;
    playbackSources.add(source);
    source.onended = () => {
      playbackSources.delete(source);
      try { source.disconnect(); } catch {}
      maybeFinishPlayback(epoch);
    };
    source.start(startAt);
  }

  function collectGrounding(metadata) {
    const chunks = metadata?.groundingChunks || [];
    for (const chunk of chunks) {
      const web = chunk?.web;
      if (!web?.uri) continue;
      groundingSources.set(web.uri, { uri: web.uri, title: String(web.title || '').trim() });
    }
    if (groundingSources.size) setStatus('Google検索で確認した情報から回答しています…');
  }

  async function inspectCurrentScreen(query) {
    const video = document.getElementById('screenVideo');
    const overlay = document.getElementById('overlay');
    const targetNote = document.getElementById('targetNote');
    const screenHint = document.getElementById('screenHint');
    if (!video?.srcObject || !video.videoWidth || !video.videoHeight) {
      if (screenHint) screenHint.textContent = 'Geminiが画面確認を必要としています。画面共有を開始してください。';
      return { available: false, reason: 'screen_share_required' };
    }
    try {
      if (screenHint) screenHint.textContent = 'Geminiが現在画面を確認しています…';
      const scale = Math.min(1, 1024 / video.videoWidth, 720 / video.videoHeight);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = canvas.toDataURL('image/jpeg', 0.78);
      const response = await fetch('/api/locate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: String(query || '現在の画面を確認してください').slice(0, 600), image })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'screen analysis failed');
      if (result.found && overlay) {
        const px = Math.max(25, Math.min(975, Number(result.x) || 500));
        const py = Math.max(25, Math.min(975, Number(result.y) || 500));
        const sx = px < 500 ? Math.min(950, px + 190) : Math.max(50, px - 190);
        const sy = py < 300 ? Math.min(950, py + 165) : Math.max(50, py - 165);
        overlay.innerHTML = '<defs><marker id="geminiArrow" markerWidth="40" markerHeight="40" refX="34" refY="20" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L0,40 L40,20 z" fill="#ff3b30"></path></marker></defs><line x1="' + sx + '" y1="' + sy + '" x2="' + px + '" y2="' + py + '" stroke="#ff3b30" stroke-width="16" stroke-linecap="round" marker-end="url(#geminiArrow)"></line><circle cx="' + px + '" cy="' + py + '" r="34" fill="none" stroke="#ff3b30" stroke-width="13"></circle>';
        if (targetNote) targetNote.textContent = '→ ' + (result.label || 'ここです');
      }
      if (screenHint) screenHint.textContent = result.found ? 'Geminiが対象を確認しました。' : (result.note || '対象を特定できませんでした。');
      return { available: true, found: Boolean(result.found), x: result.x, y: result.y, label: result.label || '', note: result.note || '' };
    } catch (error) {
      if (screenHint) screenHint.textContent = '画面確認エラー: ' + String(error?.message || error);
      return { available: false, reason: String(error?.message || error || 'screen_error') };
    }
  }

  async function handleToolCall(toolCall) {
    const functionResponses = [];
    for (const call of toolCall?.functionCalls || []) {
      if (call.name === 'inspect_current_screen') {
        setStatus('画面を確認しています…');
        const result = await inspectCurrentScreen(call.args?.query || '現在の画面を確認してください');
        functionResponses.push({ id: call.id, name: call.name, response: { result } });
      } else {
        functionResponses.push({ id: call.id, name: call.name, response: { error: 'unsupported_tool' } });
      }
    }
    if (functionResponses.length) sendLive({ toolResponse: { functionResponses } });
  }

  async function handleServerMessage(message) {
    if (message.setupComplete) {
      liveReady = true;
      closeFailures = 0;
      setupResolve?.();
      setupResolve = null;
      setupReject = null;
      setStatus(micEnabled ? '聞いています' : 'Gemini Live 接続済み');
      flushTypedQueue();
      return;
    }

    if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) {
      sessionHandle = message.sessionResumptionUpdate.newHandle;
      sessionStorage.setItem(HANDLE_KEY, sessionHandle);
    }

    if (message.goAway) {
      setStatus('会話を維持したまま接続を更新します…');
      setTimeout(() => {
        if (liveSocket && liveSocket.readyState === WebSocket.OPEN) liveSocket.close(1000, 'session_resumption');
      }, 250);
    }

    if (message.toolCall) await handleToolCall(message.toolCall);

    const content = message.serverContent;
    if (!content) return;

    if (content.interrupted) {
      stopPlayback(true);
      outputTranscript = '';
      groundingSources.clear();
      modelTurnComplete = true;
    }

    if (content.inputTranscription?.text) {
      inputTranscript = mergeTranscript(inputTranscript, content.inputTranscription.text);
      if (!typedTurnOpen) setStatus('聞き取り: ' + inputTranscript);
    }

    if (content.outputTranscription?.text) {
      finalizeInputTranscript();
      outputTranscript = mergeTranscript(outputTranscript, content.outputTranscription.text);
    }

    if (content.groundingMetadata) collectGrounding(content.groundingMetadata);

    for (const part of content.modelTurn?.parts || []) {
      if (part.inlineData?.data && /audio\/pcm/i.test(part.inlineData.mimeType || 'audio/pcm')) {
        finalizeInputTranscript();
        await queueModelAudio(part.inlineData.data);
      }
    }

    if (content.turnComplete) {
      modelTurnComplete = true;
      finalizeInputTranscript();
      finalizeOutputTranscript();
      addSources();
      groundingSources.clear();
      maybeFinishPlayback(playbackEpoch);
      if (!modelSpeaking && micEnabled) setStatus('聞いています');
    }
  }

  function buildSetup() {
    const setup = {
      model: 'models/' + MODEL,
      generationConfig: {
        responseModalities: ['AUDIO'],
        temperature: 0.35,
        topP: 0.9,
        speechConfig: { languageCode: 'ja-JP' }
      },
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      tools: [
        { googleSearch: {} },
        {
          functionDeclarations: [{
            name: 'inspect_current_screen',
            description: '現在共有されているPC画面を確認し、ユーザーが尋ねたUI要素や表示内容を特定する。画面に依存する質問の時だけ使う。',
            parameters: {
              type: 'OBJECT',
              properties: {
                query: { type: 'STRING', description: '画面上で確認すべき対象や質問' }
              },
              required: ['query']
            }
          }]
        }
      ],
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
          endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
          prefixPaddingMs: 160,
          silenceDurationMs: 650
        },
        activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
        turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY'
      },
      sessionResumption: sessionHandle ? { handle: sessionHandle } : {},
      contextWindowCompression: { slidingWindow: {} },
      inputAudioTranscription: {},
      outputAudioTranscription: {}
    };
    return { setup };
  }

  async function fetchToken() {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: '{}'
    });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok || !data.available || !data.token) {
      const error = new Error(data.reason || data.error || ('Gemini token HTTP ' + response.status));
      error.code = response.status === 503 ? 'not_configured' : 'token_failed';
      throw error;
    }
    return data;
  }

  async function connectLive() {
    if (legacyActivated) return;
    if (liveSocket && (liveSocket.readyState === WebSocket.OPEN || liveSocket.readyState === WebSocket.CONNECTING)) return setupPromise;
    clearTimeout(reconnectTimer);
    liveReady = false;
    tokenInfo = await fetchToken();
    const endpoint = tokenInfo.endpoint || 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
    const url = endpoint + '?access_token=' + encodeURIComponent(tokenInfo.token);
    setupPromise = new Promise((resolve, reject) => {
      setupResolve = resolve;
      setupReject = reject;
      const timer = setTimeout(() => reject(new Error('Gemini Live setup timeout')), MAX_SETUP_MS);
      const wrappedResolve = setupResolve;
      const wrappedReject = setupReject;
      setupResolve = () => { clearTimeout(timer); wrappedResolve(); };
      setupReject = (error) => { clearTimeout(timer); wrappedReject(error); };
    });

    const ws = new WebSocket(url);
    liveSocket = ws;
    ws.onopen = () => {
      try { ws.send(JSON.stringify(buildSetup())); }
      catch (error) { setupReject?.(error); }
    };
    ws.onmessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); }
      catch { return; }
      void handleServerMessage(message);
    };
    ws.onerror = () => {
      if (!liveReady) setupReject?.(new Error('Gemini Live WebSocket error'));
    };
    ws.onclose = (event) => {
      const wasReady = liveReady;
      liveReady = false;
      if (!wasReady) setupReject?.(new Error('Gemini Live closed before setup: ' + event.code));
      if (!shouldReconnect || legacyActivated) return;
      closeFailures += 1;
      if (event.code === 1007 && closeFailures <= 2) sessionHandle = '';
      if (closeFailures >= 5) {
        void activateLegacy('Gemini Liveの再接続に繰り返し失敗しました。');
        return;
      }
      setStatus('Gemini Live 再接続中…');
      reconnectTimer = setTimeout(() => {
        connectLive().catch((error) => {
          if (error?.code === 'not_configured') void activateLegacy('Gemini APIキーが未設定です。');
        });
      }, RECONNECT_MS);
    };
    return setupPromise;
  }

  const WORKLET = "class GeminiTalkSysCapture extends AudioWorkletProcessor{constructor(){super();this.buf=[];this.ratio=sampleRate/16000}process(inputs){const input=inputs[0];if(!input||!input[0])return true;const d=input[0];for(let i=0;i<d.length;i+=this.ratio){const n=Math.floor(i),f=i-n;this.buf.push(n+1<d.length?d[n]*(1-f)+d[n+1]*f:(d[n]||0))}while(this.buf.length>=640){const a=new Float32Array(this.buf.splice(0,640));this.port.postMessage(a,[a.buffer])}return true}}registerProcessor('gemini-talksys-capture',GeminiTalkSysCapture);";

  function sendMicFrame(samples) {
    if (!liveReady || !micEnabled) return;
    const encoded = samplesToPcmBase64(samples);
    if (sendLive({ realtimeInput: { audio: { data: encoded, mimeType: 'audio/pcm;rate=' + INPUT_RATE } } })) audioStreamOpen = true;
  }

  function handleMicFrame(samples) {
    micFrames += 1;
    const level = rms(samples);
    if (!modelSpeaking) {
      if (level < 0.025) noiseFloor = noiseFloor * 0.975 + level * 0.025;
      preRoll = [];
      bargeFrames = 0;
      bargeActive = false;
      sendMicFrame(samples);
      return;
    }

    const frameCopy = new Float32Array(samples);
    preRoll.push(frameCopy);
    if (preRoll.length > PRE_ROLL_FRAMES) preRoll.shift();
    const threshold = Math.max(ECHO_BARGE_THRESHOLD, Math.min(0.14, noiseFloor * 5.0));
    if (level >= threshold) bargeFrames += 1;
    else bargeFrames = Math.max(0, bargeFrames - 1);
    if (bargeFrames < ECHO_BARGE_FRAMES) return;

    // A sustained near-end signal is treated as a real user interruption. Stop
    // local Gemini playback immediately, then reopen the audio stream with a
    // small pre-roll so the first syllable is not clipped.
    stopPlayback(true);
    modelTurnComplete = true;
    bargeActive = true;
    setStatus('割り込みを聞いています…');
    for (const frame of preRoll) sendMicFrame(frame);
    preRoll = [];
    bargeFrames = 0;
  }

  async function ensureMic() {
    if (micReady && micStream && worklet) return;
    const ctx = await ensureAudioContext();
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: { ideal: 48000 },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false
      }
    });
    const moduleUrl = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    try { await ctx.audioWorklet.addModule(moduleUrl); }
    finally { URL.revokeObjectURL(moduleUrl); }
    micSource = ctx.createMediaStreamSource(micStream);
    worklet = new AudioWorkletNode(ctx, 'gemini-talksys-capture');
    worklet.port.onmessage = (event) => {
      const samples = event.data instanceof Float32Array ? event.data : new Float32Array(event.data);
      handleMicFrame(samples);
    };
    micSource.connect(worklet);
    worklet.connect(ctx.destination);
    micReady = true;
  }

  async function startVoice(fromAuto = false) {
    if (legacyActivated) return;
    voice.disabled = true;
    setStatus('Gemini Liveとマイクを準備しています…');
    try {
      await Promise.all([connectLive(), ensureMic()]);
      micEnabled = true;
      voice.classList.add('active');
      voice.textContent = '● Gemini Live 通話中';
      voice.disabled = false;
      setStatus('聞いています');
    } catch (error) {
      voice.disabled = false;
      if (error?.code === 'not_configured') {
        await activateLegacy('Gemini APIキーが未設定です。');
        return;
      }
      if (fromAuto && (error?.name === 'NotAllowedError' || error?.name === 'SecurityError')) {
        voice.textContent = '☎ Gemini Liveを開始';
        setStatus('通話を始めるにはボタンを押してマイクを許可してください。');
        return;
      }
      setStatus('Gemini Live開始エラー: ' + String(error?.message || error));
    }
  }

  function stopVoice() {
    micEnabled = false;
    markAudioStreamEnd();
    stopPlayback(false);
    if (micStream) micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
    micReady = false;
    if (micSource) { try { micSource.disconnect(); } catch {} micSource = null; }
    if (worklet) { try { worklet.disconnect(); } catch {} worklet = null; }
    voice.classList.remove('active');
    voice.textContent = '☎ Gemini Liveを開始';
    setStatus('Gemini Live 接続済み（マイク停止）');
  }

  function flushTypedQueue() {
    if (!liveReady || !pendingTyped.length) return;
    const queue = pendingTyped.splice(0);
    for (const text of queue) {
      sendLive({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text }] }],
          turnComplete: true
        }
      });
    }
  }

  async function submitTyped(event) {
    if (event) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    const value = String(input?.value || '').trim();
    if (!value || legacyActivated) return;
    if (input) input.value = '';
    addMessage('user', value);
    typedTurnOpen = true;
    inputTranscript = '';
    outputTranscript = '';
    groundingSources.clear();
    stopPlayback(true);
    setStatus('Geminiが考えています…');
    try {
      if (!liveReady) await connectLive();
      pendingTyped.push(value);
      flushTypedQueue();
    } catch (error) {
      if (error?.code === 'not_configured') {
        await activateLegacy('Gemini APIキーが未設定です。');
      } else {
        addMessage('assistant', 'Gemini Live接続エラー: ' + String(error?.message || error));
      }
    }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('load failed: ' + src));
      document.body.appendChild(script);
    });
  }

  async function activateLegacy(reason) {
    if (legacyActivated) return;
    legacyActivated = true;
    shouldReconnect = false;
    clearTimeout(reconnectTimer);
    try { liveSocket?.close(); } catch {}
    liveSocket = null;
    stopVoice();
    window.__talksysGeminiLivePrimary = false;
    setStatus((reason || 'Gemini Liveを利用できません。') + ' 従来音声へ切り替えます。');

    // Remove Gemini listeners before handing the controls to the legacy client.
    const currentVoice = document.getElementById('voice');
    if (currentVoice) currentVoice.replaceWith(currentVoice.cloneNode(true));
    const currentForm = document.getElementById('form');
    if (currentForm) currentForm.replaceWith(currentForm.cloneNode(true));
    try {
      await loadScript('/voice-marker-bridge.js');
      await loadScript('/realtime-voice.js');
      await loadScript('/voice-fallback.js');
    } catch (error) {
      setStatus('フォールバック音声の起動にも失敗しました: ' + String(error?.message || error));
    }
  }

  voice.textContent = '… Gemini Live接続中';
  voice.addEventListener('click', async () => {
    if (micEnabled) stopVoice();
    else await startVoice(false);
  });
  form.addEventListener('submit', submitTyped, true);
  input?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) void submitTyped(event);
  }, true);

  window.addEventListener('beforeunload', () => {
    shouldReconnect = false;
    markAudioStreamEnd();
    stopPlayback(false);
    try { liveSocket?.close(1000, 'page_unload'); } catch {}
    if (micStream) micStream.getTracks().forEach((track) => track.stop());
  }, { once: true });

  // Connect immediately so typed chat and the first spoken turn have no model
  // cold-connect penalty. Then attempt microphone start; browsers that require a
  // user gesture leave the session connected and wait for the button press.
  connectLive()
    .then(() => startVoice(true))
    .catch((error) => {
      if (error?.code === 'not_configured') void activateLegacy('Gemini APIキーが未設定です。');
      else {
        voice.textContent = '☎ Gemini Liveを再接続';
        setStatus('Gemini Live接続エラー: ' + String(error?.message || error));
      }
    });
})();
`;
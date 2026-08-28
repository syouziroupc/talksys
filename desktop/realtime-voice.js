(() => {
  'use strict';

  const TARGET_RATE = 16000;
  const originalVoice = document.getElementById('voice');
  const status = document.getElementById('status');
  const chat = document.getElementById('chat');
  const apiBaseInput = document.getElementById('apiBase');
  if (!originalVoice || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;

  const voice = originalVoice.cloneNode(true);
  originalVoice.replaceWith(voice);

  let baseUrl = '';
  let socket = null;
  let audioContext = null;
  let mediaStream = null;
  let workletNode = null;
  let welcomed = false;
  let micReady = false;
  let inCall = false;
  let desiredCall = false;
  let serverStatus = 'idle';
  let playbackQueue = [];
  let playbackSource = null;
  let playing = false;
  let interruptCount = 0;
  let reconnectTimer = null;
  let manualStop = false;
  let lastTranscriptKey = '';

  function setStatus(text) {
    status.textContent = text || '';
  }

  function addMessage(role, text) {
    if (!text) return;
    const key = role + ':' + text;
    if (key === lastTranscriptKey) return;
    lastTranscriptKey = key;
    const node = document.createElement('div');
    node.className = 'msg ' + role;
    node.textContent = text;
    chat.appendChild(node);
    node.scrollIntoView({ block: 'nearest' });
  }

  function normalizeBase(value) {
    try {
      const url = new URL(String(value || '').trim());
      return url.toString().replace(/\/$/, '');
    } catch {
      return 'https://talksys.syouziroupc.workers.dev';
    }
  }

  function websocketUrl() {
    const url = new URL(normalizeBase(baseUrl || apiBaseInput.value));
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/agents/talk-sys-voice-agent/default';
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  function setVoiceUi() {
    voice.classList.toggle('active', desiredCall && inCall);
    if (desiredCall && inCall) voice.textContent = '● 通話中';
    else if (desiredCall) voice.textContent = '… 接続中';
    else voice.textContent = '☎ リアルタイム通話';
  }

  function sendJson(data) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
  }

  function floatTo16BitPCM(samples) {
    const buffer = new ArrayBuffer(samples.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buffer;
  }

  function rms(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / Math.max(1, samples.length));
  }

  function stopPlayback() {
    playbackQueue = [];
    playing = false;
    if (playbackSource) {
      try { playbackSource.stop(); } catch {}
      try { playbackSource.disconnect(); } catch {}
      playbackSource = null;
    }
  }

  async function playNext() {
    if (playing || !playbackQueue.length || !audioContext) return;
    playing = true;
    const bytes = playbackQueue.shift();
    try {
      if (audioContext.state !== 'running') await audioContext.resume();
      const decoded = await audioContext.decodeAudioData(bytes.slice(0));
      const source = audioContext.createBufferSource();
      source.buffer = decoded;
      source.connect(audioContext.destination);
      playbackSource = source;
      source.onended = () => {
        if (playbackSource === source) playbackSource = null;
        playing = false;
        playNext();
      };
      source.start();
    } catch (error) {
      playing = false;
      setStatus('音声再生エラー: ' + (error.message || error));
    }
  }

  function queueAudio(buffer) {
    playbackQueue.push(buffer);
    playNext();
  }

  const WORKLET = "class TalkSysCapture extends AudioWorkletProcessor{constructor(){super();this.buffer=[];this.ratio=sampleRate/16000}process(inputs){const input=inputs[0];if(!input||!input[0])return true;const d=input[0];for(let i=0;i<d.length;i+=this.ratio){const n=Math.floor(i),f=i-n;this.buffer.push(n+1<d.length?d[n]*(1-f)+d[n+1]*f:d[n]||0)}if(this.buffer.length>=1600){const a=new Float32Array(this.buffer);this.buffer=[];this.port.postMessage(a,[a.buffer])}return true}}registerProcessor('talksys-capture',TalkSysCapture);";

  async function ensureAudio() {
    if (micReady && mediaStream && audioContext) {
      if (audioContext.state !== 'running') await audioContext.resume().catch(() => {});
      return;
    }
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      }
    });
    audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
    const workletUrl = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    try {
      await audioContext.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl);
    }
    const source = audioContext.createMediaStreamSource(mediaStream);
    workletNode = new AudioWorkletNode(audioContext, 'talksys-capture', { numberOfInputs: 1, numberOfOutputs: 0 });
    source.connect(workletNode);
    workletNode.port.onmessage = (event) => {
      const samples = event.data instanceof Float32Array ? event.data : new Float32Array(event.data);
      const level = rms(samples);
      if (serverStatus === 'speaking' && level > 0.055) {
        interruptCount += 1;
        if (interruptCount >= 2) {
          interruptCount = 0;
          stopPlayback();
          sendJson({ type: 'interrupt' });
        }
      } else if (level < 0.035) {
        interruptCount = 0;
      }
      if (inCall && socket && socket.readyState === WebSocket.OPEN) {
        socket.send(floatTo16BitPCM(samples));
      }
    };
    await audioContext.resume().catch(() => {});
    micReady = true;
  }

  function maybeStartServerCall() {
    if (!desiredCall || !welcomed || !micReady || inCall) return;
    sendJson({ type: 'start_call', preferred_format: 'mp3' });
  }

  async function handleScreenRequest(data) {
    const id = data.id || '';
    const query = data.query || '現在の画面を確認してください';
    try {
      setStatus('AIが現在のデスクトップを確認しています…');
      const result = await window.talksys.locate(query, normalizeBase(baseUrl || apiBaseInput.value));
      sendJson({ type: 'screen_result', id: id, available: true, result: result });
      if (result.found) setStatus('画面上に「' + (result.label || '対象') + '」を示しました。');
      else setStatus(result.note || '画面上に対象を特定できませんでした。');
    } catch (error) {
      sendJson({ type: 'screen_result', id: id, available: false, error: String(error.message || error) });
      setStatus('画面確認エラー: ' + (error.message || error));
    }
  }

  function connectSocket() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    clearTimeout(reconnectTimer);
    welcomed = false;
    socket = new WebSocket(websocketUrl());
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      sendJson({ type: 'hello', protocol_version: 1 });
      maybeStartServerCall();
    };
    socket.onmessage = async (event) => {
      if (event.data instanceof ArrayBuffer) {
        queueAudio(event.data);
        return;
      }
      if (event.data instanceof Blob) {
        queueAudio(await event.data.arrayBuffer());
        return;
      }
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.type === 'welcome') {
        welcomed = true;
        maybeStartServerCall();
        return;
      }
      if (data.type === 'status') {
        serverStatus = data.status || 'idle';
        if (serverStatus === 'listening') {
          inCall = true;
          setStatus('聞いています');
        } else if (serverStatus === 'thinking') {
          setStatus('考えています…');
        } else if (serverStatus === 'speaking') {
          setStatus('応答中。途中でもそのまま話しかけられます。');
        } else if (serverStatus === 'idle') {
          inCall = false;
          setStatus(desiredCall ? '通話を開始しています…' : '');
        }
        setVoiceUi();
        return;
      }
      if (data.type === 'transcript_interim') {
        if (data.text) setStatus('聞き取り: ' + data.text);
        return;
      }
      if (data.type === 'transcript' && data.text) {
        addMessage(data.role === 'assistant' ? 'assistant' : 'user', data.text);
        return;
      }
      if (data.type === 'playback_interrupt') {
        stopPlayback();
        return;
      }
      if (data.type === 'screen_request') {
        await handleScreenRequest(data);
        return;
      }
      if (data.type === 'error') setStatus('音声エラー: ' + (data.message || '不明なエラー'));
    };
    socket.onclose = () => {
      welcomed = false;
      inCall = false;
      setVoiceUi();
      if (desiredCall && !manualStop) {
        setStatus('再接続中…');
        reconnectTimer = setTimeout(connectSocket, 1200);
      }
    };
    socket.onerror = () => setStatus('リアルタイム音声接続に失敗しました。');
  }

  async function startCall(fromAuto) {
    manualStop = false;
    desiredCall = true;
    setVoiceUi();
    setStatus('マイクを準備しています…');
    try {
      await ensureAudio();
      connectSocket();
      maybeStartServerCall();
      if (audioContext && audioContext.state !== 'running') {
        if (fromAuto) {
          desiredCall = false;
          setVoiceUi();
          setStatus('リアルタイム通話を始めるには通話ボタンを一度押してください。');
        } else {
          await audioContext.resume();
        }
      }
    } catch (error) {
      desiredCall = false;
      setVoiceUi();
      setStatus('マイクを開始できませんでした: ' + (error.message || error));
    }
  }

  function endCall() {
    manualStop = true;
    desiredCall = false;
    if (inCall) sendJson({ type: 'end_call' });
    inCall = false;
    stopPlayback();
    if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
    micReady = false;
    if (workletNode) {
      try { workletNode.disconnect(); } catch {}
      workletNode = null;
    }
    if (socket) {
      try { socket.close(); } catch {}
      socket = null;
    }
    setStatus('');
    setVoiceUi();
  }

  voice.addEventListener('click', async () => {
    if (desiredCall) endCall();
    else await startCall(false);
  });

  window.addEventListener('beforeunload', endCall, { once: true });

  window.talksys.getConfig().then((config) => {
    baseUrl = normalizeBase(config.apiBase || apiBaseInput.value);
    apiBaseInput.value = baseUrl;
    setVoiceUi();
    setTimeout(() => startCall(true), 300);
  }).catch(() => {
    baseUrl = normalizeBase(apiBaseInput.value);
    setVoiceUi();
    setTimeout(() => startCall(true), 300);
  });
})();

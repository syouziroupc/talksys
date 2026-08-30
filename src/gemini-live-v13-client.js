export const GEMINI_LIVE_V13_CLIENT = String.raw`(() => {
  'use strict';

  window.__talksysGeminiLivePrimary = true;
  window.__talksysGeminiLiveRevision = 'gemini-live-v13.1';

  const MODEL = 'gemini-3.1-flash-live-preview';
  const TOKEN_ENDPOINT = '/api/gemini-live-token';
  const INPUT_RATE = 16000;
  const DEFAULT_OUTPUT_RATE = 24000;
  const CHUNK_SAMPLES = 640; // 40 ms @ 16kHz
  const CHUNK_MS = 40;
  const LOCAL_END_SILENCE_MS = 560;
  const LOCAL_START_FRAMES = 2;
  const RECONNECT_BASE_MS = 300;
  const MAX_SETUP_MS = 9000;
  const SESSION_ROTATE_MS = 12 * 60 * 1000;
  const TRANSCRIPT_GRACE_MS = 520;
  const HANDLE_KEY = 'talksys.gemini.live.handle.v13';
  const ECHO_BARGE_THRESHOLD = 0.052;
  const ECHO_BARGE_FRAMES = 4;
  const PRE_ROLL_FRAMES = 8;

  const CUSTOM_VOCABULARY = [
    'TalkSys','Gemini','Gemini Live','Google Search','Cloudflare','Workers','GitHub','Windows','Android','iPhone','Linux',
    'CPU','GPU','Wi-Fi','WebSocket','API','STT','TTS','HIFU','EMS','LLM','AI','Cloudflare Workers','Workers AI',
    'Chrome','Edge','Firefox','Electron','JavaScript','TypeScript','Python','OpenAI','ChatGPT','Qwen','Whisper','Deepgram',
    'Nova-3','MeloTTS','D1','Durable Object','Cloudflare Pages','Cloudflare Workers AI','GitHub Actions','Gemini API',
    'SSD','NVMe','BIOS','UEFI','USB','HDMI','Bluetooth','Ethernet','LAN','WAN','DNS','HTTP','HTTPS','JSON','REST',
    'RAG','VAD','PCM','WAV','AAC','Opus','Docker','Kubernetes','React','Node.js','npm','Git','Cloud Run','Google AI Studio'
  ];

  const SYSTEM_INSTRUCTION = [
    'あなたはTalkSysという日本語のリアルタイム音声アシスタントです。',
    '会話は自然な日本語を基本にし、ユーザーが明示的に別言語を求めた場合だけ切り替えてください。理由なく外国語や意味不明な発音へ切り替えないでください。',
    '日常会話では普通の会話相手として自然に応答してください。通常は2〜5文で、直接回答に加えて理由・補足・具体例のいずれかを含め、短すぎる一言回答を避けてください。',
    '音声が不明瞭、固有名詞が曖昧、または聞き間違いの可能性が高い場合は、推測して話を進めず短く聞き返してください。',
    '外部事実、現在情報、人物、ニュース、価格、法律、制度、製品仕様、技術仕様、医療・科学上の事実、比較、推薦など、検証可能な知識質問ではGoogle Searchを積極的に使用してください。モデルの記憶だけで固有名詞・数字・日付・仕様を断定しないでください。',
    'Google Searchを使うと決めた場合は、検索を開始する前に必ず「ちょっと調べますね。」と短く一言だけ発話してください。その後、検索で確認できた内容を根拠に回答してください。',
    '検索結果が不足、矛盾、または質問に無関係なら、推測で埋めず確認できない点を明示してください。URLは音読しないでください。',
    '現在のPC画面について答える必要がある場合だけinspect_current_screenを使用してください。ツール結果にない画面内容や、実行していない操作を見た・実行したと主張しないでください。',
    '文字入力と音声入力は同じ会話です。直前までの会話文脈を一貫して維持してください。',
    'ユーザーが話し始めて割り込んだら、現在の発話を止め、ユーザーの発言を優先してください。',
    '回答品質と速度を両立してください。難しくない質問で長い前置きや過剰な推論を行わないでください。'
  ].join('\n');

  const originalVoice = document.getElementById('voice');
  const originalForm = document.getElementById('form');
  const chat = document.getElementById('chat');
  const status = document.getElementById('status');
  if (!originalVoice || !originalForm || !chat || !status) return;

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
  let rotationTimer = null;
  let shouldReconnect = true;
  let legacyActivated = false;
  let sessionHandle = sessionStorage.getItem(HANDLE_KEY) || '';
  let closeFailures = 0;
  let connectionGeneration = 0;

  let audioContext = null;
  let micStream = null;
  let micSource = null;
  let worklet = null;
  let micEnabled = false;
  let micReady = false;
  let noiseFloor = 0.006;
  let localSpeech = false;
  let localSpeechFrames = 0;
  let localSilenceMs = 0;
  let preRoll = [];
  let bargeFrames = 0;
  let audioStreamOpen = false;

  let playbackEpoch = 0;
  let playbackCursor = 0;
  const playbackSources = new Set();
  let modelSpeaking = false;
  let modelTurnComplete = true;

  let inputTranscript = '';
  let interimInputTranscript = '';
  let outputTranscript = '';
  let typedTurnOpen = false;
  let turnCompleteSeen = false;
  let transcriptFinalizeTimer = null;
  let groundingSources = new Map();
  let lastMessageKey = '';
  const pendingTyped = [];

  function setStatus(text) { status.textContent = text || ''; }

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
    const title = document.createElement('div');
    title.textContent = 'Google検索の出典';
    title.style.fontSize = '12px';
    title.style.fontWeight = '700';
    title.style.marginBottom = '5px';
    node.appendChild(title);
    let count = 0;
    for (const source of groundingSources.values()) {
      if (count >= 5) break;
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

  function resetTurnBuffers() {
    inputTranscript = '';
    interimInputTranscript = '';
    outputTranscript = '';
    turnCompleteSeen = false;
    groundingSources.clear();
    if (transcriptFinalizeTimer) clearTimeout(transcriptFinalizeTimer);
    transcriptFinalizeTimer = null;
  }

  function finalizeTurnUi() {
    if (transcriptFinalizeTimer) clearTimeout(transcriptFinalizeTimer);
    transcriptFinalizeTimer = null;
    if (!typedTurnOpen) {
      const userText = inputTranscript.trim() || interimInputTranscript.trim();
      if (userText) addMessage('user', userText);
    }
    const assistantText = outputTranscript.trim();
    if (assistantText) addMessage('assistant', assistantText);
    addSources();
    typedTurnOpen = false;
    inputTranscript = '';
    interimInputTranscript = '';
    outputTranscript = '';
    groundingSources.clear();
    turnCompleteSeen = false;
  }

  function scheduleTurnFinalize(delay = TRANSCRIPT_GRACE_MS) {
    if (transcriptFinalizeTimer) clearTimeout(transcriptFinalizeTimer);
    transcriptFinalizeTimer = setTimeout(() => finalizeTurnUi(), delay);
  }

  function bytesToBase64(bytes) {
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + step)));
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

  function parsePcmRate(mimeType) {
    const match = String(mimeType || '').match(/rate=(\d+)/i);
    const value = match ? Number(match[1]) : DEFAULT_OUTPUT_RATE;
    return Number.isFinite(value) && value >= 8000 && value <= 96000 ? value : DEFAULT_OUTPUT_RATE;
  }

  function rms(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
    return Math.sqrt(sum / Math.max(1, samples.length));
  }

  function sendLive(message) {
    if (!liveReady || !liveSocket || liveSocket.readyState !== WebSocket.OPEN) return false;
    try { liveSocket.send(JSON.stringify(message)); return true; } catch { return false; }
  }

  function markAudioStreamEnd() {
    if (!audioStreamOpen) return;
    if (sendLive({ realtimeInput: { audioStreamEnd: true } })) audioStreamOpen = false;
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
    if (interrupted && micEnabled) setStatus('割り込みを聞いています…');
  }

  function maybeFinishPlayback(epoch) {
    if (epoch !== playbackEpoch || !modelTurnComplete || playbackSources.size) return;
    modelSpeaking = false;
    bargeFrames = 0;
    if (micEnabled) setStatus('聞いています');
  }

  async function ensureAudioContext() {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    if (audioContext.state !== 'running') await audioContext.resume().catch(() => {});
    return audioContext;
  }

  async function queueModelAudio(base64, mimeType) {
    const ctx = await ensureAudioContext();
    const samples = base64ToPcmFloat(base64);
    if (!samples.length) return;
    const rate = parsePcmRate(mimeType);

    if (!modelSpeaking) {
      modelSpeaking = true;
      modelTurnComplete = false;
      localSpeech = false;
      localSpeechFrames = 0;
      localSilenceMs = 0;
      bargeFrames = 0;
      preRoll = [];
      markAudioStreamEnd();
      setStatus('Geminiが話しています。途中で割り込めます。');
    }

    const buffer = ctx.createBuffer(1, samples.length, rate);
    buffer.copyToChannel(samples, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const epoch = playbackEpoch;
    const startAt = Math.max(ctx.currentTime + 0.018, playbackCursor || 0);
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
      if (screenHint) screenHint.textContent = '画面確認が必要です。画面共有を開始してください。';
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
      const response = await fetch('/api/locate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: String(query || '現在の画面を確認してください').slice(0, 600), image: canvas.toDataURL('image/jpeg', 0.8) })
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
      if (screenHint) screenHint.textContent = result.found ? '対象を確認しました。' : (result.note || '対象を特定できませんでした。');
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

  function handleSessionResumption(update) {
    if (!update?.resumable || !update.newHandle) return;
    sessionHandle = update.newHandle;
    sessionStorage.setItem(HANDLE_KEY, sessionHandle);
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
      scheduleRotation();
      return;
    }
    if (message.sessionResumptionUpdate) handleSessionResumption(message.sessionResumptionUpdate);
    if (message.goAway) {
      setStatus('会話を維持したまま接続を更新します…');
      setTimeout(() => {
        if (liveSocket?.readyState === WebSocket.OPEN) liveSocket.close(1000, 'session_resumption');
      }, 120);
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

    if (content.interimInputTranscription?.text) {
      interimInputTranscript = String(content.interimInputTranscription.text || '').trim();
      if (!typedTurnOpen && interimInputTranscript) setStatus('聞き取り中: ' + interimInputTranscript);
    }

    if (content.inputTranscription?.text) {
      inputTranscript = mergeTranscript(inputTranscript, content.inputTranscription.text);
      interimInputTranscript = '';
      if (!typedTurnOpen && inputTranscript) setStatus('聞き取り: ' + inputTranscript);
      if (turnCompleteSeen) scheduleTurnFinalize();
    }

    if (content.outputTranscription?.text) {
      outputTranscript = mergeTranscript(outputTranscript, content.outputTranscription.text);
      if (turnCompleteSeen) scheduleTurnFinalize();
    }

    if (content.groundingMetadata) collectGrounding(content.groundingMetadata);

    for (const part of content.modelTurn?.parts || []) {
      if (part.inlineData?.data && /audio\/pcm/i.test(part.inlineData.mimeType || 'audio/pcm')) {
        await queueModelAudio(part.inlineData.data, part.inlineData.mimeType);
      }
    }

    if (content.turnComplete) {
      turnCompleteSeen = true;
      modelTurnComplete = true;
      scheduleTurnFinalize();
      maybeFinishPlayback(playbackEpoch);
    }
  }

  function buildSetup() {
    return {
      setup: {
        model: 'models/' + MODEL,
        generationConfig: {
          responseModalities: ['AUDIO'],
          temperature: 0.28,
          topP: 0.9,
          thinkingConfig: { thinkingLevel: 'LOW' },
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
        },
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        tools: [
          { googleSearch: {} },
          {
            functionDeclarations: [{
              name: 'inspect_current_screen',
              description: '現在共有されているPC画面を確認し、ユーザーが尋ねたUI要素や表示内容を特定する。画面依存の質問の時だけ使う。',
              parameters: {
                type: 'OBJECT',
                properties: { query: { type: 'STRING', description: '画面上で確認すべき対象や質問' } },
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
            prefixPaddingMs: 180,
            silenceDurationMs: 800
          },
          activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
          turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY'
        },
        sessionResumption: sessionHandle ? { handle: sessionHandle } : {},
        contextWindowCompression: { triggerTokens: '90000', slidingWindow: { targetTokens: '52000' } },
        inputAudioTranscription: {
          languageCodes: ['ja-JP'],
          customVocabulary: CUSTOM_VOCABULARY,
          mode: 'SMART'
        },
        outputAudioTranscription: {}
      }
    };
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

  function scheduleRotation() {
    clearTimeout(rotationTimer);
    rotationTimer = setTimeout(() => {
      if (!shouldReconnect || legacyActivated) return;
      if (modelSpeaking || localSpeech) {
        rotationTimer = setTimeout(scheduleRotation, 30000);
        return;
      }
      setStatus('会話を維持したままセッションを更新します…');
      try { liveSocket?.close(1000, 'proactive_rotation'); } catch {}
    }, SESSION_ROTATE_MS);
  }

  async function connectLive() {
    if (legacyActivated) return;
    if (liveSocket && (liveSocket.readyState === WebSocket.OPEN || liveSocket.readyState === WebSocket.CONNECTING)) return setupPromise;
    clearTimeout(reconnectTimer);
    liveReady = false;
    const tokenInfo = await fetchToken();
    const endpoint = tokenInfo.endpoint || 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
    const generation = ++connectionGeneration;

    setupPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Gemini Live setup timeout')), MAX_SETUP_MS);
      setupResolve = () => { clearTimeout(timer); resolve(); };
      setupReject = (error) => { clearTimeout(timer); reject(error); };
    });

    const ws = new WebSocket(endpoint + '?access_token=' + encodeURIComponent(tokenInfo.token));
    liveSocket = ws;
    ws.onopen = () => {
      if (generation !== connectionGeneration) return;
      try { ws.send(JSON.stringify(buildSetup())); } catch (error) { setupReject?.(error); }
    };
    ws.onmessage = (event) => {
      if (generation !== connectionGeneration) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      void handleServerMessage(message);
    };
    ws.onerror = () => { if (!liveReady) setupReject?.(new Error('Gemini Live WebSocket error')); };
    ws.onclose = (event) => {
      if (generation !== connectionGeneration) return;
      const wasReady = liveReady;
      liveReady = false;
      clearTimeout(rotationTimer);
      if (!wasReady) setupReject?.(new Error('Gemini Live closed before setup: ' + event.code + ' ' + event.reason));
      if (!shouldReconnect || legacyActivated) return;
      closeFailures += 1;
      if (event.code === 1007 && closeFailures <= 2) {
        sessionHandle = '';
        sessionStorage.removeItem(HANDLE_KEY);
      }
      if (closeFailures >= 5) {
        void activateLegacy('Gemini Liveの再接続に繰り返し失敗しました。');
        return;
      }
      setStatus('Gemini Live 再接続中…');
      const delay = Math.min(2500, RECONNECT_BASE_MS * Math.pow(1.7, Math.max(0, closeFailures - 1)));
      reconnectTimer = setTimeout(() => {
        connectLive().catch((error) => {
          if (error?.code === 'not_configured') void activateLegacy('Gemini APIキーが未設定です。');
        });
      }, delay);
    };
    return setupPromise;
  }

  const WORKLET = "class TalkSysGeminiCapture extends AudioWorkletProcessor{constructor(){super();this.buf=[];this.ratio=sampleRate/16000}process(inputs){const i=inputs[0];if(!i||!i[0])return true;const d=i[0];for(let p=0;p<d.length;p+=this.ratio){const n=Math.floor(p),f=p-n;this.buf.push(n+1<d.length?d[n]*(1-f)+d[n+1]*f:(d[n]||0))}while(this.buf.length>=640){const a=new Float32Array(this.buf.splice(0,640));this.port.postMessage(a,[a.buffer])}return true}}registerProcessor('talksys-gemini-capture',TalkSysGeminiCapture);";

  function sendMicFrame(samples) {
    if (!liveReady || !micEnabled) return false;
    const sent = sendLive({ realtimeInput: { audio: { data: samplesToPcmBase64(samples), mimeType: 'audio/pcm;rate=' + INPUT_RATE } } });
    if (sent) audioStreamOpen = true;
    return sent;
  }

  function handleNearEndBarge(samples, level) {
    const copy = new Float32Array(samples);
    preRoll.push(copy);
    if (preRoll.length > PRE_ROLL_FRAMES) preRoll.shift();
    const threshold = Math.max(ECHO_BARGE_THRESHOLD, Math.min(0.14, noiseFloor * 5.0));
    if (level >= threshold) bargeFrames += 1;
    else bargeFrames = Math.max(0, bargeFrames - 1);
    if (bargeFrames < ECHO_BARGE_FRAMES) return;
    stopPlayback(true);
    modelTurnComplete = true;
    localSpeech = true;
    localSpeechFrames = LOCAL_START_FRAMES;
    localSilenceMs = 0;
    setStatus('割り込みを聞いています…');
    for (const frame of preRoll) sendMicFrame(frame);
    preRoll = [];
    bargeFrames = 0;
  }

  function handleMicFrame(samples) {
    const level = rms(samples);
    if (modelSpeaking) {
      handleNearEndBarge(samples, level);
      return;
    }

    if (!localSpeech && level < 0.025) noiseFloor = noiseFloor * 0.985 + level * 0.015;
    const startThreshold = Math.max(0.014, noiseFloor * 2.7);
    const endThreshold = Math.max(0.009, noiseFloor * 1.65);

    if (!localSpeech) {
      preRoll.push(new Float32Array(samples));
      if (preRoll.length > PRE_ROLL_FRAMES) preRoll.shift();
      if (level >= startThreshold) localSpeechFrames += 1;
      else localSpeechFrames = Math.max(0, localSpeechFrames - 1);
      if (localSpeechFrames >= LOCAL_START_FRAMES) {
        localSpeech = true;
        localSilenceMs = 0;
        setStatus('聞いています…');
        for (const frame of preRoll) sendMicFrame(frame);
        preRoll = [];
      } else {
        // Keep the server-side VAD warm without relying on it for finalization.
        sendMicFrame(samples);
      }
      return;
    }

    sendMicFrame(samples);
    if (level <= endThreshold) localSilenceMs += CHUNK_MS;
    else localSilenceMs = 0;
    if (localSilenceMs >= LOCAL_END_SILENCE_MS) {
      markAudioStreamEnd();
      localSpeech = false;
      localSpeechFrames = 0;
      localSilenceMs = 0;
      preRoll = [];
      setStatus('Geminiが考えています…');
    }
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
    try { await ctx.audioWorklet.addModule(moduleUrl); } finally { URL.revokeObjectURL(moduleUrl); }
    micSource = ctx.createMediaStreamSource(micStream);
    worklet = new AudioWorkletNode(ctx, 'talksys-gemini-capture');
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
      voice.textContent = '☎ Gemini Liveを再試行';
      setStatus('Gemini Live開始エラー: ' + String(error?.message || error));
    }
  }

  function stopVoice() {
    micEnabled = false;
    markAudioStreamEnd();
    stopPlayback(false);
    localSpeech = false;
    localSpeechFrames = 0;
    localSilenceMs = 0;
    if (micStream) micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
    micReady = false;
    if (micSource) { try { micSource.disconnect(); } catch {} micSource = null; }
    if (worklet) { try { worklet.disconnect(); } catch {} worklet = null; }
    voice.classList.remove('active');
    voice.textContent = '☎ Gemini Liveを開始';
    setStatus(liveReady ? 'Gemini Live 接続済み（マイク停止）' : '');
  }

  function flushTypedQueue() {
    if (!liveReady || !pendingTyped.length) return;
    while (pendingTyped.length) {
      const text = pendingTyped.shift();
      sendLive({ realtimeInput: { text } });
    }
  }

  async function submitTyped(event) {
    if (event) { event.preventDefault(); event.stopImmediatePropagation(); }
    const value = String(input?.value || '').trim();
    if (!value || legacyActivated) return;
    if (input) input.value = '';
    if (send) send.disabled = true;
    addMessage('user', value);
    typedTurnOpen = true;
    resetTurnBuffers();
    typedTurnOpen = true;
    stopPlayback(true);
    setStatus('Geminiが考えています…');
    try {
      if (!liveReady) await connectLive();
      pendingTyped.push(value);
      flushTypedQueue();
    } catch (error) {
      if (error?.code === 'not_configured') await activateLegacy('Gemini APIキーが未設定です。');
      else addMessage('assistant', 'Gemini Live接続エラー: ' + String(error?.message || error));
    } finally {
      if (send) send.disabled = false;
      input?.focus();
    }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error('load failed: ' + src));
      document.body.appendChild(script);
    });
  }

  async function activateLegacy(reason) {
    if (legacyActivated) return;
    legacyActivated = true;
    shouldReconnect = false;
    clearTimeout(reconnectTimer);
    clearTimeout(rotationTimer);
    try { liveSocket?.close(); } catch {}
    liveSocket = null;
    stopVoice();
    window.__talksysGeminiLivePrimary = false;
    setStatus((reason || 'Gemini Liveを利用できません。') + ' 従来音声へ切り替えます。');
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
  voice.addEventListener('click', async () => { if (micEnabled) stopVoice(); else await startVoice(false); });
  form.addEventListener('submit', submitTyped, true);
  input?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) void submitTyped(event);
  }, true);

  window.addEventListener('beforeunload', () => {
    shouldReconnect = false;
    clearTimeout(reconnectTimer);
    clearTimeout(rotationTimer);
    markAudioStreamEnd();
    stopPlayback(false);
    try { liveSocket?.close(1000, 'page_unload'); } catch {}
    if (micStream) micStream.getTracks().forEach((track) => track.stop());
  }, { once: true });

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
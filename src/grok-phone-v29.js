import { groundingDecisionV22 } from './grounding-policy-v22.js';
import { collectGroundedEvidenceV26 } from './search-v26.js';
import { streamGrokConversationV29, GROK_CONVERSATION_MODEL_V29 } from './grok-conversation-v29.js';
import { GrokJapaneseTTSV29, GROK_TTS_MODEL_V29 } from './grok-japanese-tts-v29.js';

export const GROK_PHONE_STT_MODEL_V29 = 'xai/grok-stt';
export const GROK_PHONE_CODEC_V29 = 'mulaw';
export const GROK_PHONE_SAMPLE_RATE_V29 = 8000;
export const GROK_PHONE_TRANSPORT_V29 = 'twilio-bidirectional-media-stream';

const VOICE_THRESHOLD = 520;
const START_VOICE_FRAMES = 2;
const END_SILENCE_FRAMES = 25;
const PRE_ROLL_FRAMES = 10;
const MAX_UTTERANCE_BYTES = GROK_PHONE_SAMPLE_RATE_V29 * 14;

const PHONE_SYSTEM_PROMPT = `あなたはTalkSysという日本語の電話相談AIです。
電話で聞き取りやすい自然な日本語で、質問への答えを最初に出してください。通常は1〜3文です。
会話履歴から省略された対象や条件を引き継ぎ、既に分かっていることを聞き直さないでください。
検索していない現在情報、価格、在庫、営業時間、制度、製品仕様などを推測で断定しないでください。
URL、Markdown、内部処理は読み上げないでください。`;

const PHONE_GROUNDED_PROMPT = `あなたはTalkSysという日本語の電話相談AIです。
今回はWeb検索済みです。具体的な外部事実は提示された根拠に直接支えられる内容だけを使ってください。
結論を先に、通常1〜3文で答えてください。根拠にない店名、数値、価格、在庫、時刻、仕様を作らないでください。
URL、Markdown、検索処理の説明は読み上げないでください。`;

function bytesFromBase64(value) {
  try {
    const binary = atob(String(value || ''));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array(0);
  }
}

function base64FromBytes(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || new ArrayBuffer(0));
  let binary = '';
  const block = 0x8000;
  for (let i = 0; i < view.length; i += block) {
    binary += String.fromCharCode(...view.subarray(i, Math.min(view.length, i + block)));
  }
  return btoa(binary);
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function mulawSample(byte) {
  const value = (~byte) & 0xff;
  const sign = value & 0x80;
  const exponent = (value >> 4) & 0x07;
  const mantissa = value & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

export function mulawLevel(bytes) {
  if (!bytes?.length) return 0;
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 1) sum += Math.abs(mulawSample(bytes[i]));
  return sum / bytes.length;
}

function xmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function websocketUrl(request) {
  const url = new URL(request.url);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/phone/media';
  url.search = '';
  return url.toString();
}

export function twilioConnectTwiml(request, env = {}) {
  const stream = xmlEscape(websocketUrl(request));
  const token = String(env.TALKSYS_PHONE_TOKEN || '').trim();
  const parameter = token ? `<Parameter name="Token" value="${xmlEscape(token)}"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${stream}">${parameter}</Stream></Connect></Response>`;
}

function sendJson(socket, payload) {
  if (!socket || socket.readyState !== 1) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function extractSttText(result) {
  if (!result) return '';
  if (typeof result === 'string') return result.trim();
  return String(result.text ?? result.result?.text ?? result.response?.text ?? '').trim();
}

async function transcribeMulaw(ai, bytes, signal) {
  const file = `data:audio/basic;base64,${base64FromBytes(bytes)}`;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await ai.run(
        GROK_PHONE_STT_MODEL_V29,
        {
          file,
          audio_format: GROK_PHONE_CODEC_V29,
          sample_rate: GROK_PHONE_SAMPLE_RATE_V29,
          language: 'ja',
          format: true,
          keyterm: ['TalkSys', 'Windows', 'Let’s note', 'CF-SV8'],
        },
        signal ? { signal } : undefined,
      );
      const text = extractSttText(result);
      if (text) return text;
      throw new Error('Grok STT returned empty text');
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
    }
  }
  throw lastError || new Error('Grok STT failed');
}

function evidenceMessages(history, transcript, result) {
  const compact = (result.sources || []).slice(0, 7).map((item, index) => {
    const excerpt = String(item.excerpt || item.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 850);
    return `[${index + 1}] ${String(item.title || '').slice(0, 180)}\n${excerpt}`;
  }).join('\n\n');
  return [
    { role: 'system', content: PHONE_GROUNDED_PROMPT },
    ...history.slice(-12),
    { role: 'user', content: `${transcript}\n\n[検索根拠]\n${compact || '(確認できる根拠なし)'}` },
  ];
}

function normalMessages(history, transcript) {
  return [
    { role: 'system', content: PHONE_SYSTEM_PROMPT },
    ...history.slice(-14),
    { role: 'user', content: transcript },
  ];
}

async function collectText(iterable) {
  let text = '';
  for await (const chunk of iterable) text += String(chunk || '');
  return text.trim();
}

function phoneSession(socket, env) {
  const tts = new GrokJapaneseTTSV29(env.AI);
  let streamSid = '';
  let history = [];
  let closed = false;
  let playbackPending = false;
  let playbackMark = '';
  let turnAbort = null;
  let speaking = false;
  let voiceRun = 0;
  let silenceRun = 0;
  let preRoll = [];
  let utterance = [];
  let utteranceBytes = 0;
  let turnNumber = 0;
  const expectedToken = String(env.TALKSYS_PHONE_TOKEN || '').trim();

  const clearPlayback = () => {
    if (!streamSid || !playbackPending) return;
    sendJson(socket, { event: 'clear', streamSid });
    playbackPending = false;
    playbackMark = '';
  };

  const abortCurrentTurn = () => {
    if (turnAbort) {
      try { turnAbort.abort(); } catch {}
      turnAbort = null;
    }
    clearPlayback();
  };

  const sendAudio = async (text, signal, label = 'reply') => {
    if (!streamSid || !text || signal?.aborted) return;
    const audio = await tts.synthesizeTelephony(text, signal);
    if (!audio || signal?.aborted) return;
    playbackPending = true;
    playbackMark = `${label}-${++turnNumber}`;
    sendJson(socket, {
      event: 'media',
      streamSid,
      media: { payload: base64FromBytes(new Uint8Array(audio)) },
    });
    sendJson(socket, {
      event: 'mark',
      streamSid,
      mark: { name: playbackMark },
    });
  };

  const answerUtterance = async (audioBytes) => {
    abortCurrentTurn();
    const controller = new AbortController();
    turnAbort = controller;
    const { signal } = controller;
    try {
      const transcript = await transcribeMulaw(env.AI, audioBytes, signal);
      if (!transcript || signal.aborted) return;

      const decision = groundingDecisionV22(transcript, history);
      let messages;
      if (decision.search) {
        try { await sendAudio('少し調べますね。', signal, 'search'); } catch {}
        const result = await collectGroundedEvidenceV26(transcript, history, { signal });
        if (signal.aborted) return;
        messages = result.sources?.length
          ? evidenceMessages(history, transcript, result)
          : [
              { role: 'system', content: `${PHONE_SYSTEM_PROMPT}\n必要な外部根拠を確認できませんでした。推測で埋めず、確認に必要な条件を1つだけ聞いてください。` },
              ...history.slice(-12),
              { role: 'user', content: transcript },
            ];
      } else {
        messages = normalMessages(history, transcript);
      }

      const reply = await collectText(streamGrokConversationV29(env.AI, messages, {
        signal,
        maxTokens: 260,
        openTimeoutMs: 1800,
        firstTokenTimeoutMs: 2200,
        retryTimeoutMs: 3200,
        streamIdleTimeoutMs: 2800,
        streamTotalTimeoutMs: 10500,
        sessionAffinity: streamSid ? `talksys-phone-${streamSid.slice(-40)}` : '',
      }));
      if (!reply || signal.aborted) return;

      history.push({ role: 'user', content: transcript }, { role: 'assistant', content: reply });
      history = history.slice(-16);
      await sendAudio(reply, signal, 'answer');
    } catch (error) {
      if (!signal.aborted) {
        try { await sendAudio('もう一度お願いします。', signal, 'recover'); } catch {}
      }
    } finally {
      if (turnAbort === controller) turnAbort = null;
    }
  };

  const finalizeUtterance = () => {
    if (!utteranceBytes) return;
    const audio = concatBytes(utterance);
    speaking = false;
    voiceRun = 0;
    silenceRun = 0;
    preRoll = [];
    utterance = [];
    utteranceBytes = 0;
    if (audio.length >= 320) void answerUtterance(audio);
  };

  const resetCapture = () => {
    speaking = false;
    voiceRun = 0;
    silenceRun = 0;
    preRoll = [];
    utterance = [];
    utteranceBytes = 0;
  };

  const handleMedia = (payload) => {
    const bytes = bytesFromBase64(payload);
    if (!bytes.length) return;
    const level = mulawLevel(bytes);
    const voiced = level >= VOICE_THRESHOLD;

    if (!speaking) {
      preRoll.push(bytes);
      if (preRoll.length > PRE_ROLL_FRAMES) preRoll.shift();
      if (voiced) {
        voiceRun += 1;
        if (voiceRun >= START_VOICE_FRAMES) {
          if (playbackPending || turnAbort) abortCurrentTurn();
          speaking = true;
          utterance = preRoll.slice();
          utteranceBytes = utterance.reduce((sum, chunk) => sum + chunk.length, 0);
          preRoll = [];
          silenceRun = 0;
        }
      } else {
        voiceRun = 0;
      }
      return;
    }

    utterance.push(bytes);
    utteranceBytes += bytes.length;
    if (voiced) silenceRun = 0;
    else silenceRun += 1;

    if (silenceRun >= END_SILENCE_FRAMES || utteranceBytes >= MAX_UTTERANCE_BYTES) finalizeUtterance();
  };

  socket.addEventListener('message', (event) => {
    if (closed || typeof event.data !== 'string') return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.event === 'start') {
      streamSid = String(message.streamSid || message.start?.streamSid || '');
      const format = message.start?.mediaFormat || {};
      if (format.encoding && format.encoding !== 'audio/x-mulaw') {
        try { socket.close(1003, 'mulaw required'); } catch {}
        return;
      }
      if (Number(format.sampleRate || 8000) !== 8000 || Number(format.channels || 1) !== 1) {
        try { socket.close(1003, '8k mono required'); } catch {}
        return;
      }
      if (expectedToken && String(message.start?.customParameters?.Token || '') !== expectedToken) {
        try { socket.close(1008, 'phone token mismatch'); } catch {}
        return;
      }
      void sendAudio('こんにちは。どのようなご相談でしょうか？', undefined, 'greeting').catch(() => {});
      return;
    }
    if (message.event === 'media') {
      handleMedia(message.media?.payload);
      return;
    }
    if (message.event === 'mark' && String(message.mark?.name || '') === playbackMark) {
      playbackPending = false;
      playbackMark = '';
      return;
    }
    if (message.event === 'stop') {
      resetCapture();
      abortCurrentTurn();
      closed = true;
    }
  });

  socket.addEventListener('close', () => {
    closed = true;
    resetCapture();
    abortCurrentTurn();
  });

  socket.addEventListener('error', () => {
    resetCapture();
    abortCurrentTurn();
  });
}

export function handlePhoneIncoming(request, env) {
  return new Response(twilioConnectTwiml(request, env), {
    status: 200,
    headers: {
      'content-type': 'text/xml; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export function handlePhoneMedia(request, env) {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('WebSocket upgrade required', { status: 426 });
  }
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  phoneSession(server, env);
  return new Response(null, { status: 101, webSocket: client });
}

export function phoneHealth(env = {}) {
  return {
    ok: true,
    transport: GROK_PHONE_TRANSPORT_V29,
    provider: 'twilio-compatible',
    inboundPath: '/phone/incoming',
    mediaPath: '/phone/media',
    inputCodec: 'audio/x-mulaw',
    sampleRate: GROK_PHONE_SAMPLE_RATE_V29,
    channels: 1,
    sttModel: GROK_PHONE_STT_MODEL_V29,
    conversationModel: GROK_CONVERSATION_MODEL_V29,
    ttsModel: GROK_TTS_MODEL_V29,
    ttsCodec: 'mulaw',
    bargeInClear: true,
    phoneTokenConfigured: Boolean(String(env.TALKSYS_PHONE_TOKEN || '').trim()),
    phoneNumberConfiguredByTalkSys: false,
  };
}

export const __test = { bytesFromBase64, base64FromBytes, concatBytes, extractSttText, transcribeMulaw };

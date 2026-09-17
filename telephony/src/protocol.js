export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-live';
export const GEMINI_LIVE_ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export const SYSTEM_INSTRUCTION = [
  'あなたはTalkSysの電話窓口です。日本語で自然かつ簡潔に応答してください。',
  '電話なので一度に長く話しすぎず、相手が話し始めたら割り込みを優先してください。',
  '価格、在庫、時刻、制度など現在確認が必要な情報は、根拠なしに具体値を作らないでください。',
  '聞き取れない内容は推測で補完せず、短く聞き返してください。',
  '利用者が電話を切ろうとしている場合は簡潔に終了してください。',
].join('');

export function clean(value, max = 300) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function xmlEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function flag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

export function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function buildTexml({ host, protocol = 'https:', token, callSid = '', from = '', to = '' }) {
  const mediaUrl = new URL(`wss://${host}/telnyx/media`);
  const statusUrl = new URL(`${protocol}//${host}/telnyx/stream-status`);
  mediaUrl.searchParams.set('token', token);
  statusUrl.searchParams.set('token', token);

  const parameters = [
    callSid ? `<Parameter name="call_sid" value="${xmlEscape(callSid)}" />` : '',
    from ? `<Parameter name="from" value="${xmlEscape(from)}" />` : '',
    to ? `<Parameter name="to" value="${xmlEscape(to)}" />` : '',
  ].filter(Boolean).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Connect><Stream url="${xmlEscape(mediaUrl.toString())}" track="inbound_track" codec="PCMU" bidirectionalMode="rtp" bidirectionalCodec="PCMU" bidirectionalSamplingRate="8000" statusCallback="${xmlEscape(statusUrl.toString())}" statusCallbackMethod="POST" enableReconnect="true">${parameters}</Stream></Connect></Response>`;
}

export function buildGeminiSetup(env = {}, resumeHandle = '') {
  const setup = {
    model: `models/${clean(env.GEMINI_LIVE_MODEL || DEFAULT_GEMINI_MODEL, 100)}`,
    generationConfig: { responseModalities: ['AUDIO'] },
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contextWindowCompression: {
      triggerTokens: String(clampInt(env.TELEPHONY_CONTEXT_TRIGGER_TOKENS, 25000, 4000, 120000)),
      slidingWindow: {
        targetTokens: String(clampInt(env.TELEPHONY_CONTEXT_TARGET_TOKENS, 8000, 2000, 60000)),
      },
    },
    sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
  };

  // Transcription is intentionally opt-in: Google bills generated transcript tokens
  // in addition to native audio usage.
  if (flag(env.TELEPHONY_TRANSCRIPTION, false)) {
    setup.inputAudioTranscription = {};
    setup.outputAudioTranscription = {};
  }

  return { setup };
}

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

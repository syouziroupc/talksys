import talksys from './entry.js';
import { handleTelephonyRequest } from './telephony/index.js';

export const INTEGRATED_ENTRY_REVISION = 'talksys-integrated-entry-v1';

async function runTalkSysTurn(request, env, ctx, body) {
  const url = new URL('/api/turn', request.url);
  const internalRequest = new Request(url.toString(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-talksys-source': 'telnyx',
      'x-talksys-integrated-entry': INTEGRATED_ENTRY_REVISION,
    },
    body: JSON.stringify(body || {}),
  });
  const response = await talksys.fetch(internalRequest, env, ctx);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || `talksys_turn_${response.status}`);
  }
  return payload;
}

export default {
  async fetch(request, env, ctx) {
    const telephonyResponse = await handleTelephonyRequest(request, env, ctx, {
      turn: (body) => runTalkSysTurn(request, env, ctx, body),
    });
    if (telephonyResponse) return telephonyResponse;
    return talksys.fetch(request, env, ctx);
  },
};

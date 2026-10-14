import { createHash } from 'node:crypto';

const productionUrl = String(process.env.PRODUCTION_URL || 'https://talksys.syouziroupc.workers.dev').replace(/\/$/, '');
const geminiKey = String(process.env.GEMINI_API_KEY || '').trim();
const auditPhoneNumber = String(process.env.AUDIT_PHONE_NUMBER || '').trim();

if (!geminiKey) throw new Error('GEMINI_API_KEY is required for phone AI boundary audit');

const diagnosticToken = createHash('sha256')
  .update(`${geminiKey}:talksys-phone-ai-boundary-audit-v1`)
  .digest('hex');

const nativeFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url;
  if (url === `${productionUrl}/api/turn` && String(init?.method || 'GET').toUpperCase() === 'POST') {
    let body = {};
    try { body = JSON.parse(String(init?.body || '{}')); } catch {}
    const headers = new Headers(init?.headers || {});
    headers.set('content-type', 'application/json');
    headers.set('x-talksys-diagnostic', diagnosticToken);
    return nativeFetch(`${productionUrl}/api/internal/phone-ai-boundary-audit`, {
      ...init,
      headers,
      body: JSON.stringify({
        text: body?.text || '',
        history: Array.isArray(body?.history) ? body.history : [],
        ...(auditPhoneNumber ? { phoneNumber: auditPhoneNumber } : {}),
      }),
    });
  }
  return nativeFetch(input, init);
};

await import('./answer-quality-audit.mjs');

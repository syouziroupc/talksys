import OpenAI from 'openai';

const REVISION = 'talksys-openai-live-sip-poc-r1';
const LIVE_MODEL = 'gpt-live-1';

const LIVE_INSTRUCTIONS = [
  'あなたはTalkSysの電話接続検証用AIです。',
  '日本語で自然に会話してください。',
  '電話なので、一度の応答は原則1〜4文程度に簡潔にしてください。',
  '相手の発話が不明瞭な場合は推測せず、短く聞き返してください。',
  'この段階は電話接続試験です。営業行為、契約確定、料金確約、個人情報の収集は行わないでください。',
  '現在情報や外部事実を根拠なく断定しないでください。',
].join('\n');

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function getOpenAI(env) {
  return new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    project: env.OPENAI_PROJECT_ID || undefined,
    webhookSecret: env.OPENAI_WEBHOOK_SECRET || undefined,
  });
}

function requiredConfig(env) {
  const missing = [];
  if (!env.OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  if (!env.OPENAI_PROJECT_ID) missing.push('OPENAI_PROJECT_ID');
  if (!env.OPENAI_WEBHOOK_SECRET) missing.push('OPENAI_WEBHOOK_SECRET');
  return missing;
}

async function acceptLiveSession(sessionId, env) {
  const response = await fetch(`https://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/accept`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
      'openai-project': env.OPENAI_PROJECT_ID,
    },
    body: JSON.stringify({
      session: {
        type: 'live',
        model: LIVE_MODEL,
        instructions: LIVE_INSTRUCTIONS,
      },
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`live_accept_failed:${response.status}:${text.slice(0, 700)}`);
  }
  return { transport: 'live', status: response.status };
}

async function acceptRealtimeCall(callId, env) {
  const response = await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/accept`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
      'openai-project': env.OPENAI_PROJECT_ID,
    },
    body: JSON.stringify({
      type: 'realtime',
      model: LIVE_MODEL,
      instructions: LIVE_INSTRUCTIONS,
      output_modalities: ['audio'],
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`realtime_accept_failed:${response.status}:${text.slice(0, 700)}`);
  }
  return { transport: 'realtime', status: response.status };
}

async function handleOpenAIWebhook(request, env) {
  const missing = requiredConfig(env);
  if (missing.length) return json({ ok: false, error: 'missing_configuration', missing }, 503);

  const rawBody = await request.text();
  let event;
  try {
    event = await getOpenAI(env).webhooks.unwrap(rawBody, request.headers);
  } catch (error) {
    console.warn('OpenAI webhook signature rejected', String(error?.message || error));
    return json({ ok: false, error: 'invalid_webhook_signature' }, 400);
  }

  const type = String(event?.type || '');
  const data = event?.data || {};

  try {
    if (type === 'live.transport.incoming' || type === 'live.call.incoming') {
      const sessionId = String(data.session_id || data.id || data.call_id || '').trim();
      if (!sessionId) return json({ ok: false, error: 'missing_live_session_id', type }, 422);
      const accepted = await acceptLiveSession(sessionId, env);
      console.log('Accepted GPT-Live SIP session', { type, sessionId, accepted });
      return json({ ok: true, accepted: true, model: LIVE_MODEL, type, ...accepted });
    }

    if (type === 'realtime.call.incoming') {
      const callId = String(data.call_id || data.id || '').trim();
      if (!callId) return json({ ok: false, error: 'missing_realtime_call_id', type }, 422);
      const accepted = await acceptRealtimeCall(callId, env);
      console.log('Accepted GPT-Live Realtime SIP call', { type, callId, accepted });
      return json({ ok: true, accepted: true, model: LIVE_MODEL, type, ...accepted });
    }

    return json({ ok: true, ignored: true, type });
  } catch (error) {
    console.error('SIP accept failed', { type, error: String(error?.message || error) });
    return json({ ok: false, error: 'sip_accept_failed', type, detail: String(error?.message || error) }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      const missing = requiredConfig(env);
      return json({
        ok: missing.length === 0,
        revision: REVISION,
        model: LIVE_MODEL,
        purpose: 'isolated GPT-Live SIP phone PoC; production TalkSys is untouched',
        configured: {
          openaiApiKey: Boolean(env.OPENAI_API_KEY),
          openaiProjectId: Boolean(env.OPENAI_PROJECT_ID),
          openaiWebhookSecret: Boolean(env.OPENAI_WEBHOOK_SECRET),
        },
        missing,
      }, missing.length ? 503 : 200);
    }

    if (request.method === 'POST' && url.pathname === '/webhooks/openai') {
      return handleOpenAIWebhook(request, env);
    }

    return json({
      ok: false,
      error: 'not_found',
      routes: ['GET /health', 'POST /webhooks/openai'],
    }, 404);
  },
};

# TalkSys External API PoC — GPT-Live SIP

This PoC is intentionally isolated from the production TalkSys worker.

## Goal

Prove one thing first: a normal phone call can reach `gpt-live-1` over SIP and hold a natural Japanese voice conversation.

Production TalkSys is not modified by this PoC. The frozen reference branch is `backup/legacy-2026-09-15`.

## Minimal architecture

```text
PSTN caller
  -> SIP provider / phone number (PoC: Twilio Elastic SIP Trunk)
  -> sip:proj_xxx@sip.api.openai.com;transport=tls
  -> OpenAI Live / gpt-live-1
  -> caller

Control plane only:
OpenAI incoming-call webhook
  -> Cloudflare Worker /webhooks/openai
  -> OpenAI /v1/live/sessions/{id}/accept
```

The audio media path does not pass through Cloudflare. Cloudflare is only the trusted webhook/control/tool backend. This reduces latency and avoids rebuilding STT, TTS, VAD, RTP and SIP media handling inside TalkSys.

## Required services

1. Existing Cloudflare account.
2. OpenAI API project with API billing enabled. `gpt-live-1` is not available on the API free tier.
3. One SIP/PSTN provider and one phone number. For the first PoC, Twilio Elastic SIP Trunking is preferred because Twilio documents the OpenAI SIP interop directly.

No ChatGPT Plus/Pro subscription is required for the API path.

## Worker secrets

Set these as Cloudflare Worker secrets; never commit them.

- `OPENAI_API_KEY` — project-scoped API key for the same OpenAI project used in the SIP URI.
- `OPENAI_PROJECT_ID` — `proj_...` project identifier.
- `OPENAI_WEBHOOK_SECRET` — signing secret shown when creating the OpenAI webhook.

## Deploy

From this directory:

```bash
npm install
npm run check
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put OPENAI_PROJECT_ID
npx wrangler secret put OPENAI_WEBHOOK_SECRET
npm run deploy
```

After deployment, verify:

```text
GET https://talksys-openai-live-sip-poc.<account>.workers.dev/health
```

All three `configured` fields must be true.

## OpenAI webhook

In the same OpenAI project used by `OPENAI_PROJECT_ID`, create a webhook pointing to:

```text
https://talksys-openai-live-sip-poc.<account>.workers.dev/webhooks/openai
```

Subscribe to the incoming Live SIP event (`live.transport.incoming`). The worker also accepts the compatibility events `live.call.incoming` and `realtime.call.incoming` so the PoC can survive API migration differences while we test.

Copy the webhook signing secret into the Worker secret `OPENAI_WEBHOOK_SECRET`.

## SIP trunk

Set the SIP trunk origination destination to:

```text
sip:proj_xxxxxxxxx@sip.api.openai.com;transport=tls
```

The `proj_...` value must be the same OpenAI project used by the webhook and API key.

For Twilio Elastic SIP Trunking:

1. Create/purchase one phone number.
2. Create one Elastic SIP Trunk.
3. Add the OpenAI URI above as the Origination URI.
4. Attach the phone number to that trunk.
5. Call the number from a normal Japanese phone.

## Pass criteria for phase 1

- Incoming PSTN call reaches OpenAI SIP.
- OpenAI webhook reaches Cloudflare.
- Cloudflare verifies the webhook signature.
- Worker accepts the call with `gpt-live-1`.
- Caller and GPT-Live can exchange at least 10 natural Japanese turns.
- Barge-in/interruption works without the old TalkSys VAD/STT/TTS pipeline.
- No production TalkSys route or Worker is changed.

## Explicitly deferred

Do not add these until the basic call path passes:

- GPT-5.6 Terra/Sol backend delegation.
- Web search.
- HelpSys knowledge/tools.
- Lead qualification or sales actions.
- Outbound dialing.
- Human transfer.
- CRM/calendar integration.

Those become phase 2+ only after the SIP call itself is stable.

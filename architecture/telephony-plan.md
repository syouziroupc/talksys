# TalkSys Telephony Isolation Plan

This branch isolates the new telephone integration from the in-progress answer-quality work.

## Guardrails

- Do not modify the existing browser TalkSys UI or `/api/turn` behavior.
- Do not modify answer-generation, search, grounding, truth-gate, or Gemini quality code while that work is active.
- Telephone work lives behind new routes and new modules only.
- No Telnyx phone number is assigned until the telephony endpoints are deployed and verified.

## Phase 1: telephone shell

- Add a separate `/phone` management page.
- Add `/telephony-health` status reporting without changing conversation behavior.
- Add placeholders for `/telnyx/voice` and `/telnyx/media` behind isolated modules.
- Keep call-content persistence optional and disabled by default.

## Phase 2: media bridge

- Implement Telnyx TeXML webhook response.
- Implement the media WebSocket bridge.
- Connect the telephone path to the selected realtime model without changing the browser TalkSys path.

## Phase 3: storage

- Store only lightweight call metadata in D1.
- Add R2 only for long transcripts or recordings if needed.
- Do not record audio by default.

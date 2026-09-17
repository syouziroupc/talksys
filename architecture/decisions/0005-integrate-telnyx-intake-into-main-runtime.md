# ADR 0005: Telnyx intake is part of the main TalkSys runtime

## Status

Accepted.

## Context

TalkSys was originally intended to answer phone calls, but the first Telnyx prototype became a separate Worker with its own direct realtime model path. That duplicated the AI stack, increased cost, and created a second answer-quality surface while the main TalkSys routing and grounding work was still active.

The production TalkSys already has the components needed for the phone path: Japanese STT, the canonical `/api/turn` answer route, Japanese TTS, the Workers AI binding, and the existing conversation-log D1 database.

## Decision

Use one production Worker entry point, `src/integrated-entry.js`.

The integrated entry routes only telephony-specific paths to `src/telephony/index.js`. All ordinary browser and API traffic is delegated unchanged to the existing `src/entry.js` terminal answer boundary.

The phone path is:

1. Telnyx TeXML accepts the inbound call and streams inbound PCMU audio.
2. The telephony adapter performs VAD and reuses the existing TalkSys STT implementation.
3. Recognized text is sent back through the existing TalkSys `/api/turn` code path; the telephony adapter does not select or host a separate answer model.
4. The existing TalkSys Japanese TTS produces MP3 audio.
5. Telnyx bidirectional MP3 playback returns that audio to the caller.
6. The existing TalkSys D1 stores only call metadata and text messages for the phone management screen. Recording is not enabled.

Each call owns an independent WebSocket-local conversation state. Durable Objects, R2, a second database, and a separate realtime AI model are not required for basic concurrent calls.

## Consequences

- Existing answer-quality work remains in the canonical TalkSys answer path.
- Telephone answers automatically inherit future main TalkSys answer improvements.
- No additional fixed-cost AI/voice subsystem is introduced.
- `TELEPHONY_ENABLED` remains false by default until Telnyx credentials and the inbound number are ready.
- `TELEPHONY_SHARED_TOKEN` and optionally `TELEPHONY_ADMIN_TOKEN` are runtime secrets and must not be committed.
- The earlier isolated `talksys-telephony` Worker becomes disposable after the integrated path is verified.
- Real-call latency, VAD thresholds, and barge-in quality still require validation after the 050 number is active.

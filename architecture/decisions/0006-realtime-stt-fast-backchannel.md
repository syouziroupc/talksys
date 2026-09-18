# ADR 0006: Add realtime transcription and fast conversational backchannels

## Status

Accepted

## Context

The production browser voice path waits for local VAD silence and then performs batch Whisper transcription before any conversational response can begin. That creates a separate turn-taking delay even when Gemini itself is fast. The v58 noise and interruption work must remain intact, and raw VAD noise must not cancel an in-flight answer.

## Decision

Add a small canonical turn-taking capability in `src/voice-fast-reaction.js`.

The production browser keeps the existing v58 adaptive VAD and Whisper batch transcription as the authoritative fallback, while additionally streaming 16 kHz PCM to Workers AI Deepgram Nova-3 through `/api/realtime-stt`. Realtime endpointing may trigger the existing batch commit earlier and may produce only a short conversational backchannel. It does not directly authorize factual content or replace the final Gemini answer.

Fast reactions are deterministic, short, and context-sensitive. Examples include greetings, thanks, a lookup acknowledgement, or a minimal listening cue. The final Gemini request receives the already-spoken backchannel so it continues naturally instead of repeating the same acknowledgement.

Phone intake reuses the same fast-reaction policy after its authoritative STT completes. A future phone realtime-STT change may extend the same capability rather than create a separate reaction system.

## Consequences

- Realtime STT failure is non-fatal; Whisper batch STT remains available.
- Noise/VAD alone still cannot cancel a Gemini turn.
- Fast reactions carry no factual claims and do not replace the final answer.
- The client may use a WebSocket only for the explicit same-origin realtime STT route; the retired `/agents/` voice path remains prohibited.
- New turn-taking behavior should extend `src/voice-fast-reaction.js`, `src/talk-client-v45.js`, and `src/integrated-entry.js` rather than add another parallel voice subsystem.

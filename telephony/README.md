# TalkSys Telephony Worker

Independent telephone integration for TalkSys.

This directory is intentionally isolated from the existing browser TalkSys runtime while answer-quality work is in progress.

Initial scope:

- separate phone management UI
- Telnyx TeXML webhook endpoint
- Telnyx media WebSocket endpoint
- telephony health endpoint
- no call-content persistence by default

The existing browser UI, `/api/turn`, search/grounding stack, and Gemini answer-quality code are not modified by this work.

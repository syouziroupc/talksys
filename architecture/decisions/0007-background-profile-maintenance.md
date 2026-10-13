# 0007 — Background profile maintenance

Status: Accepted

## Context

TalkSys already has a persistent caller profile store and an asynchronous preload path. The live voice pipeline is latency-sensitive and has regression locks around speech recognition, turn taking, answer generation, speech synthesis, and media delivery.

The existing `src/conversation-memory.js` was reviewed before this change. It manages bounded session context and does not perform persistent profile maintenance from historical call logs.

## Decision

- Keep profile-maintenance model calls outside the live call path.
- Add `src/phone-memory-maintenance.js` as the canonical background maintenance capability.
- Reuse the existing Workers AI binding with a small extraction model.
- Accept only additions that include a matching user-utterance evidence span.
- Make automatic updates additive-only in the first version.
- Preserve optimistic profile version checks so concurrent manual edits win.
- Keep a runtime kill switch for background maintenance.
- Add `src/runtime-entry.js` as a thin production wrapper. HTTP requests continue to delegate unchanged to `src/integrated-entry.js`; scheduled maintenance is hosted by the wrapper.

## Consequences

A maintenance failure cannot block a normal call. Unsupported or uncertain memories are discarded. Destructive edits remain manual until a later version has dedicated contradiction and rollback tests. The entrypoint change must pass the complete regression suite and Wrangler dry-run before merge.

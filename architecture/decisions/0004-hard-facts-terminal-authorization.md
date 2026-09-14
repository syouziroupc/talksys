# ADR 0004: Add a terminal hard-facts authorization boundary

## Status

Accepted.

## Context

TalkSys can retrieve relevant prose yet still produce an unsupported concrete claim when retrieval is incomplete, contradictory, or semantically insufficient for the requested task. Exact transit routes are the clearest case: keyword-relevant web snippets do not prove station order, transfer continuity, train identity, or departure time. Continuing generation after that gap creates an epistemic fail-open condition.

The repository also carried historical rollback markers and one-shot migration/diagnostic workflows. Those are not part of the production architecture and encourage treating obsolete plans as rollback products.

## Decision

1. The unversioned `src/entry.js` becomes the production runtime entry while delegating ordinary orchestration to the existing worker.
2. `src/entry.js` applies a final claim-level fail-close policy to `/api/turn` responses.
3. Exact transit sequence claims require structured `transit_route` evidence. Generic web results may inform context but never authorize concrete transfer/train/time instructions.
4. When a dynamic factual lookup has no usable external evidence, newly invented prices, times, rates, versions, and model-like identifiers are removed while stable non-specific guidance remains.
5. The gate records machine-readable `truthGate` diagnostics and exposes `/truth-gate-health` for production verification.
6. Historical rollback markers are removed from Wrangler configuration. Completed one-shot workflows are deleted rather than retained as fallback plans.

## Consequences

The system may return a partial answer instead of an exact route or current value when the required evidence type is absent. This is intentional: the failure is localized to the unauthorized claim rather than turning the whole response into a generic refusal. Exact transit utility now depends on adding or enabling a structured route provider rather than trusting prose retrieval.

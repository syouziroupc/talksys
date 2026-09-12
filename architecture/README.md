# TalkSys architecture registry

This directory exists to prevent duplicate subsystems and accidental "reinvention" of capabilities that already exist.

## Required workflow before implementation

Before adding a subsystem, helper, router, verifier, planner, memory layer, search layer, or version-suffixed source file:

1. Read `architecture/capabilities.json`.
2. Search the repository for the requested responsibility and nearby symbols.
3. Classify the change as one of:
   - `REUSE`: existing capability already satisfies the requirement.
   - `EXTEND`: existing canonical capability should be changed.
   - `REPLACE`: existing capability is intentionally superseded; this requires a decision record and registry update.
   - `NEW`: no existing capability covers the responsibility; this requires a decision record and registry entry before code is added.
4. Prefer `REUSE` or `EXTEND`.
5. Do not create a new `*-vNN.*` canonical source file just because the product release number changed. Product releases belong in Git history/tags/releases, not in the source filename.

## Current migration rule

The repository contains many historical version-suffixed files. They are legacy artifacts and are not a pattern to continue. During cleanup they will be removed, archived, or renamed in small no-behavior-change steps.

Until that cleanup reaches a capability, the path recorded as `canonical` in `capabilities.json` is authoritative even if its filename contains an old version suffix.

## v46 rule

v46 is a product/release milestone, not permission to create parallel implementations such as:

- `search-v46.js`
- `fact-verifier-v46.js`
- `truth-controller-v46.js`
- `grounding-v46.js`

The current v46 hallucination/latency work must first be mapped onto existing capabilities. For example:

- Director parallelization / hedged retrieval -> `search.execution`
- stronger retrieval relevance / evidence gating -> `evidence.validation`
- factual-risk routing -> `grounding.policy`
- top-level fail-closed behavior -> `runtime.entry`

If a genuinely new responsibility is discovered, add an ADR and registry entry before implementation.

## Decision records

Architecture decisions should be placed under `architecture/decisions/` with names such as:

`0001-reuse-first-capability-registry.md`

An ADR records why a new capability or replacement is necessary. Old decisions should be superseded, not silently overwritten.

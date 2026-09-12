# TalkSys architecture registry

This directory exists to prevent duplicate subsystems and accidental "reinvention" of capabilities that already exist.

## Required workflow before implementation

Before adding a subsystem, helper, router, verifier, planner, memory layer, search layer, or version-suffixed source file:

1. Read `architecture/capabilities.json`.
2. Search the repository for the requested responsibility and nearby symbols.
3. Also inspect `legacyPriorArt` in the registry. Old code may contain useful logic even when it is not on the production path.
4. Classify the change as one of:
   - `REUSE`: existing capability already satisfies the requirement.
   - `EXTEND`: existing canonical capability should be changed.
   - `REPLACE`: existing capability is intentionally superseded; this requires a decision record and registry update.
   - `NEW`: no existing capability covers the responsibility; this requires a decision record and registry entry before code is added.
5. Prefer `REUSE` or `EXTEND`.
6. Do not create a new `*-vNN.*` canonical source file just because the product release number changed. Product releases belong in Git history/tags/releases, not in the source filename.

## Canonical does not mean one file per capability

A production file may currently contain several responsibilities. For example, the current production worker contains both runtime orchestration and factual-routing logic, while the current search implementation contains planning, provider execution and evidence relevance gating.

The registry therefore allows multiple capability IDs to point at the same canonical file. This is preferable to pretending that an older standalone helper is still the production implementation.

If a capability is later extracted into its own stable module, perform that extraction as an explicit refactor and update the registry in the same change.

## Current migration rule

The repository contains many historical version-suffixed files. They are legacy artifacts and are not a pattern to continue. During cleanup they will be removed, archived, or renamed in small no-behavior-change steps.

Until that cleanup reaches a capability, the path recorded as `canonical` in `capabilities.json` is authoritative even if its filename contains an old version suffix.

Files listed under `legacyPriorArt` are not production-canonical merely because they contain useful or more sophisticated logic. They must be reviewed before reuse to avoid reviving obsolete paths blindly.

## v46 rule

v46 is a product/release milestone, not permission to create parallel implementations such as:

- `search-v46.js`
- `fact-verifier-v46.js`
- `truth-controller-v46.js`
- `grounding-v46.js`

The current v46 hallucination/latency work must first be mapped onto existing capabilities. For example:

- Director parallelization / hedged retrieval -> `search.planning` and `search.execution`
- stronger retrieval relevance / evidence gating -> `evidence.validation`
- factual-risk routing -> `grounding.policy`
- fail-closed grounded answer behavior -> `answer.synthesis`

If a genuinely new responsibility is discovered, add an ADR and registry entry before implementation.

## Decision records

Architecture decisions should be placed under `architecture/decisions/` with names such as:

`0001-reuse-first-capability-registry.md`

An ADR records why a new capability or replacement is necessary. Old decisions should be superseded, not silently overwritten.

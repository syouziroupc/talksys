# ADR 0001: Reuse-first capability registry

- Status: Accepted
- Date: 2026-09-12

## Context

TalkSys has accumulated historical version-suffixed source files across runtime, search, voice, UI and supporting subsystems. This makes it difficult to determine which implementation is authoritative and increases the risk that a developer or coding agent creates a second implementation for an existing responsibility.

The immediate v46 work includes hallucination reduction and latency improvements. Those changes overlap with responsibilities that already exist in the repository, including search execution, grounding policy, evidence relevance gating and runtime orchestration.

## Decision

TalkSys will maintain `architecture/capabilities.json` as the canonical registry of production capabilities.

Before creating a new subsystem, implementation work must be classified as `REUSE`, `EXTEND`, `REPLACE`, or `NEW`.

`REUSE` and `EXTEND` are preferred. `REPLACE` and `NEW` require a decision record and an update to the capability registry.

New canonical source files must not use product-version suffixes such as `-v46` merely to represent a new TalkSys release. Existing version-suffixed canonical files remain temporarily valid until they are migrated in separate no-behavior-change cleanup steps.

## Consequences

- v46 work is mapped onto existing capabilities before code is added.
- Historical files are not deleted as part of this decision.
- Runtime behavior is unchanged by this ADR.
- Later cleanup can rename or archive legacy files incrementally without mixing architecture cleanup with hallucination fixes.
- CI may progressively enforce registry integrity and, later, prevent newly introduced duplicate/version-suffixed canonical implementations.

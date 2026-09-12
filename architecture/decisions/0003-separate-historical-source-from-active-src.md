# ADR 0003: Separate historical source from active src

Status: Accepted

## Context

TalkSys keeps many old versioned workers and clients under `src/` so historical regression tests and rollback contracts can inspect them. They are not reachable from the current production entry, but their presence makes repository search noisy and encourages accidental reuse or duplicate implementations.

Git history already preserves every prior revision, but some historical tests still intentionally inspect old source snapshots. Removing all of those snapshots at once would create unnecessary risk.

## Decision

Historical source that is no longer part of the production import graph may be moved from `src/` to `archive/` in small, independently validated changes.

Rules:

1. `src/` is for current production code and explicitly retained implementation prior art only.
2. `archive/` is historical evidence, not an implementation source for new work.
3. Production code must never import from `archive/`.
4. Archived code may import old `src/` dependencies temporarily while a historical cluster is migrated incrementally; those imports must never flow back into the production graph.
5. Every migration must first prove that the file is unreachable from `runtime.entry`.
6. Tests that exist only to assert historical behavior may be updated to read the archived path.
7. Every archive move must run architecture checks, the full regression suite, and the Wrangler dry-run before merge.
8. New product versions must not be added to `archive/` as a normal development workflow. Git history/releases remain the primary history mechanism; `archive/` exists only to drain existing legacy source out of active `src/` safely.

## Consequences

- Repository searches can distinguish active implementation from historical evidence by path.
- Cleanup can proceed one small cluster at a time without discarding rollback evidence.
- `archive/` must not become a second active source tree.

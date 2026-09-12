# ADR 0002: Enforce reuse-first source changes in CI

Status: Accepted

## Context

TalkSys contains many historical version-suffixed implementations. That makes it easy to add another parallel worker, search layer, verifier, planner, or helper instead of extending the current production capability.

Documentation alone is not enough because a new file can bypass it.

## Decision

CI will run a reuse gate on every change.

The gate enforces these rules:

1. Newly added `src/*.js` files must already be represented in `architecture/capabilities.json` as a canonical implementation or companion.
2. Newly added version-suffixed files such as `search-v46.js` are rejected. Product release numbers belong in Git history/releases, not new source filenames.
3. Adding a new capability ID or replacing a capability's canonical implementation requires a new ADR in the same change.
4. Extending an existing canonical implementation remains the default and does not require a new ADR merely because behavior is improved.

## Consequences

- Existing historical files remain untouched for now.
- New parallel subsystems become difficult to introduce accidentally.
- Legitimate new capabilities require an explicit architectural decision.
- Cleanup can proceed separately from functional v46 changes.

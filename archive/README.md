# TalkSys historical source archive

Files under this directory are retained only as historical evidence for old rollback/regression contracts.

They are **not** current TalkSys implementation code.

Rules:

- Never choose a file under `archive/` as the starting point for a new feature or bug fix.
- Search `architecture/capabilities.json` for the current canonical capability first.
- Production code under `src/` must never import from `archive/`.
- Archive moves are incremental and must preserve all tests before merge.
- New releases are recorded in Git history/tags/releases, not by routinely adding new archived source snapshots.

See `architecture/decisions/0003-separate-historical-source-from-active-src.md`.

# TalkSys Discord V92 reproducibility baseline

Source baseline: `6c4fb083a3ff3b7b243b8873d7762e14a326ffaa`

The immutable source reference is the branch `archive/discord-v92-golden`.
Do not commit changes to that branch.

This branch exists only to make the V92 runtime reproducible enough for validation.

## Fixed here

- Node baseline: 22.12.0
- @discordjs/voice: 0.19.0
- discord.js: 14.22.1
- ffmpeg-static: 5.2.0
- opusscript: 0.0.8
- prism-media: 1.3.5

## Important limitation

The original V92 tree did not contain `package-lock.json`.
Therefore the exact historical transitive dependency tree cannot be proven from Git history alone.

Before calling this runtime "V92-GOLDEN-RUNTIME":

1. Generate `package-lock.json` from this branch in a working npm registry environment.
2. Install with `npm ci`.
3. Run the Discord voice regression matrix.
4. Record Node/npm versions and the final lock hash.
5. Keep all new work off `archive/discord-v92-golden`.

## Validation target

The purpose is to reproduce V92 transport behavior first. Web-direct development belongs on
`feature/discord-web-direct` and must not modify the frozen V92 source branch.

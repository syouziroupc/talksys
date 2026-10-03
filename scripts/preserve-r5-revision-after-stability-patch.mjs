import fs from 'node:fs';

const path = 'discord-voice-smoke/src/index.mjs';
let source = fs.readFileSync(path, 'utf8');
const from = "const DISCORD_BRIDGE_REVISION = 'talksys-discord-bridge-v93-stability-coordinator-r1';";
const to = "const DISCORD_BRIDGE_REVISION = 'talksys-discord-bridge-v92-resilience-r5';\nconst DISCORD_STABILITY_PATCH_REVISION = 'talksys-r5-stability-coordinator-p1';";
if (!source.includes(from)) throw new Error('patched bridge revision marker missing');
if (source.indexOf(from) !== source.lastIndexOf(from)) throw new Error('patched bridge revision marker not unique');
source = source.replace(from, to);
const hb = '      revision: DISCORD_BRIDGE_REVISION,';
if (!source.includes(hb)) throw new Error('heartbeat revision marker missing');
source = source.replace(hb, "      revision: DISCORD_BRIDGE_REVISION,\n      stabilityPatch: DISCORD_STABILITY_PATCH_REVISION,");
const boot = "mirrorRuntimeLog('BOOT', `bridge=${DISCORD_BRIDGE_REVISION}`);";
if (!source.includes(boot)) throw new Error('boot revision marker missing');
source = source.replace(boot, `${boot}\nmirrorRuntimeLog('BOOT', \`stabilityPatch=\${DISCORD_STABILITY_PATCH_REVISION}\`);`);
fs.writeFileSync(path, source);
console.log('R5 bridge revision preserved; stability patch revision recorded separately');

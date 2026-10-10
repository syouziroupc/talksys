import assert from 'node:assert/strict';
import fs from 'node:fs';

const path = '.github/workflows/configure-telnyx-production.yml';
const source = fs.readFileSync(path, 'utf8');

assert.match(source, /TELEPHONY_SHARED_TOKEN:\s*\$\{\{\s*secrets\.TELEPHONY_SHARED_TOKEN\s*\}\}/);
assert.doesNotMatch(source, /randomBytes\s*\(\s*32\s*\)/);
assert.doesNotMatch(source, /Rotate production telephony shared token/);

const preflightIndex = source.indexOf('Preflight Telnyx account and target before Cloudflare mutation');
const cloudflareMutationIndex = source.indexOf('Sync production telephony shared token to Cloudflare');
const telnyxMutationIndex = source.indexOf('Upsert TalkSys TeXML application and assign 050 number');
assert.ok(preflightIndex >= 0, 'Telnyx preflight step must exist');
assert.ok(cloudflareMutationIndex > preflightIndex, 'Telnyx preflight must run before Cloudflare token mutation');
assert.ok(telnyxMutationIndex > cloudflareMutationIndex, 'Telnyx mutation must run after Cloudflare token sync');

assert.match(source, /TELNYX_API_KEY\/TELNYX_TOKEN\/TELNYX_API_V2_KEY GitHub Actions secret is missing/);
assert.match(source, /TELEPHONY_SHARED_TOKEN GitHub Actions secret is missing/);
assert.match(source, /Owned phone number \$\{target\} was not found in the Telnyx account/);
assert.match(source, /Multiple TeXML applications named \$\{appName\}; refusing ambiguous update/);

assert.match(source, /codec=\\"PCMU\\"/);
assert.match(source, /bidirectionalMode=\\"rtp\\"/);
assert.match(source, /bidirectionalCodec=\\"PCMU\\"/);
assert.doesNotMatch(source, /bidirectionalMode=\\"mp3\\"/);

console.log('Telnyx production workflow contract OK');

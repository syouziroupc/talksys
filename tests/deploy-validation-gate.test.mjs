import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');

test('production deploy only auto-triggers from the dedicated marker on main', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /push:/);
  assert.match(workflow, /branches:\s*\[main\]/);
  assert.match(workflow, /\.deploy\/production-trigger\.txt/);
});

test('production deploy is restricted to main and waits for a successful validate check for the exact SHA', () => {
  assert.match(workflow, /checks:\s*read/);
  assert.match(workflow, /GITHUB_REF.*refs\/heads\/main/);
  assert.match(workflow, /for attempt in \$\(seq 1 60\)/);
  assert.match(workflow, /commits\/\$GITHUB_SHA\/check-runs\?per_page=100/);
  assert.match(workflow, /run\?\.name === 'validate'/);
  assert.match(workflow, /run\?\.head_sha === sha/);
  assert.match(workflow, /run\?\.status === 'completed'/);
  assert.match(workflow, /run\?\.conclusion === 'success'/);
  assert.match(workflow, /Timed out waiting for successful Validate TalkSys check/);
});

test('production deploy revalidates architecture, source graph, archived syntax, tests, and Wrangler bundle', () => {
  assert.match(workflow, /npm run architecture:check/);
  assert.match(workflow, /npm run architecture:graph/);
  assert.match(workflow, /find src archive -type f -name '\*\.js'/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npx wrangler deploy --dry-run/);
  assert.match(workflow, /npx wrangler deploy --secrets-file "\$secrets_file"/);
});

test('production deploy preserves the Cloudflare Discord secret and uploads only the rotating Gemini secret', () => {
  assert.match(workflow, /GEMINI_API_KEY:\s*\$\{\{ secrets\.GEMINI_API_KEY \}\}/);
  assert.doesNotMatch(workflow, /DISCORD_BRIDGE_TOKEN:\s*\$\{\{ secrets\.DISCORD_BRIDGE_TOKEN \}\}/);
  assert.match(workflow, /test -n "\$\{GEMINI_API_KEY:-\}"/);
  assert.match(workflow, /wrangler secret list --format json/);
  assert.match(workflow, /row\?\.name === 'DISCORD_BRIDGE_TOKEN'/);
  assert.match(workflow, /JSON\.stringify\(\{ GEMINI_API_KEY: gemini \}\)/);
  assert.match(workflow, /--secrets-file "\$secrets_file"/);
  assert.match(workflow, /d\.discordBridgeConfigured===true/);
  assert.match(workflow, /Verify Discord bridge auth is enforced/);
  assert.match(workflow, /"\$http_code" == "401"/);
  assert.match(workflow, /\/gemini-health/);
  assert.match(workflow, /generationProvider==='gemini'/);
  assert.match(workflow, /generationModel==='gemini-3\.5-flash-lite'/);
  assert.match(workflow, /interactions\+workers-ai-region-rescue/);
  assert.match(workflow, /interactionsRegionFallback==='workers-ai-v45'/);
  assert.match(workflow, /legacyGlmExecution===false/);
});

test('post-deploy contract is derived from checked-out source instead of stale hard-coded revisions', () => {
  assert.match(workflow, /Verify current production contract/);
  assert.match(workflow, /src\/worker-v44\.js/);
  assert.match(workflow, /CLIENT_REVISION/);
  assert.match(workflow, /UI_REVISION/);
  assert.match(workflow, /STT_REVISION/);
  assert.match(workflow, /EXPECTED_REVISION/);
  assert.doesNotMatch(workflow, /talksys-v45-standalone-answer-core/);
  assert.doesNotMatch(workflow, /talksys-v45-standalone-http-adaptive-vad/);
});

test('production deploy keeps UI, microphone, deterministic, weather, and contextual smoke checks', () => {
  assert.match(workflow, /Verify live v45 UI and microphone client/);
  assert.match(workflow, /Production answer smoke/);
  assert.match(workflow, /talksys-v47-web-stability-freeze-r1/);
  assert.match(workflow, /\/api\/transcribe/);
  assert.match(workflow, /\/api\/turn/);
  assert.match(workflow, /12345÷15/);
  assert.match(workflow, /別府市の今日の天気は？/);
  assert.match(workflow, /cloudflare-region-rescue/);
  assert.match(workflow, /大学のレポート用に中古ノートPCを探してる。予算は3万円。/);
});


test('answer smoke enforces quality-first search before the blocking realtime STT check', () => {
  const answerIndex = workflow.indexOf('- name: Production answer smoke');
  const realtimeIndex = workflow.indexOf('- name: Verify realtime STT websocket upgrade');
  assert.ok(answerIndex >= 0);
  assert.ok(realtimeIndex > answerIndex);
  assert.doesNotMatch(workflow, /Verify realtime STT websocket upgrade[\s\S]*continue-on-error: true/);
  assert.match(workflow, /Sec-WebSocket-Version: 13/);
  assert.match(workflow, /Sec-WebSocket-Key:/);
  assert.match(workflow, /HTTP\/1\\\.\[01\] 101/);

  assert.match(workflow, /"text":"こんにちは"/);
  assert.match(workflow, /d\.search!==false/);
  assert.match(workflow, /d\.genericVerificationAttempted!==false/);

  assert.match(workflow, /12345÷15/);
  assert.match(workflow, /d\.search!==true/);
  assert.match(workflow, /d\.genericVerificationAttempted!==false/);
  assert.match(workflow, /d\.genericVerificationSucceeded!==false/);
  assert.match(workflow, /Number\.isFinite\(d\.timings\?\.primaryMs\)/);
  assert.match(workflow, /Number\.isFinite\(d\.timings\?\.verifierMs\)/);
  assert.match(workflow, /generationProvider!=='workers-ai'/);
  assert.match(workflow, /startsWith\('cloudflare-region-rescue:'\)/);
});

test('production deploy archives prior D1 revisions after deploy', () => {
  assert.match(workflow, /Archive prior D1 conversation revisions/);
  assert.match(workflow, /\/api\/internal\/archive-conversation-logs/);
  assert.match(workflow, /expected_archive_revision/);
  assert.match(workflow, /INTEGRATED_ENTRY_REVISION/);
  assert.match(workflow, /EXPECTED_ARCHIVE_REVISION/);
});

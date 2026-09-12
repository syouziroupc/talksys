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
  assert.match(workflow, /npx wrangler deploy\s*$/m);
});

test('production deploy keeps post-deploy contract, UI, microphone, deterministic, weather, and contextual smoke checks', () => {
  assert.match(workflow, /Verify standalone v45 production contract/);
  assert.match(workflow, /Verify live v45-only UI and microphone client/);
  assert.match(workflow, /Production answer smoke/);
  assert.match(workflow, /talksys-v45-standalone-answer-core/);
  assert.match(workflow, /talksys-v45-standalone-http-adaptive-vad/);
  assert.match(workflow, /\/api\/transcribe/);
  assert.match(workflow, /\/api\/turn/);
  assert.match(workflow, /12345÷15/);
  assert.match(workflow, /別府市の今日の天気は？/);
  assert.match(workflow, /大学のレポート用に中古ノートPCを探してる。予算は3万円。/);
});

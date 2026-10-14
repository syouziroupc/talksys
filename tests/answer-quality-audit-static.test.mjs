import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const runner = fs.readFileSync('scripts/answer-quality-audit.mjs', 'utf8');
const workflow = fs.readFileSync('.github/workflows/direct-answer-quality-audit.yml', 'utf8');
const cases = JSON.parse(fs.readFileSync('qa/answer-quality-cases.json', 'utf8'));

test('direct answer audit runner has valid JavaScript syntax', () => {
  const checked = spawnSync(process.execPath, ['--check', 'scripts/answer-quality-audit.mjs'], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
});

test('direct answer audit bypasses telephony and targets production turn endpoint', () => {
  assert.match(runner, /\/api\/turn/);
  assert.match(runner, /channel:\s*'web'/);
  assert.doesNotMatch(runner, /telnyx|PCMU|TELEPHONY_|\/api\/transcribe|\/api\/voice\/synthesize/i);
});

test('direct answer audit locks reviewer to the production model and independent Google Search', () => {
  assert.match(runner, /production_model_unknown/);
  assert.match(runner, /audit_model_mismatch/);
  assert.match(runner, /tools:\s*\[\{ type: 'google_search' \}\]/);
  assert.match(runner, /response_format/);
  assert.match(runner, /authoritativeJst/);
});

test('standard suite covers broad factual categories', () => {
  assert.ok(cases.length >= 10);
  const categories = new Set(cases.map((item) => item.category));
  for (const category of ['transit', 'weather', 'law', 'software-current', 'product-price', 'business-hours', 'market-current']) {
    assert.ok(categories.has(category), `missing category: ${category}`);
  }
});

test('workflow exposes manual arbitrary-question audit and visible reports', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /question:/);
  assert.match(workflow, /GITHUB_STEP_SUMMARY/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /answer-quality-report/);
});

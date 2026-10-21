import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const runner = fs.readFileSync('scripts/answer-quality-audit.mjs', 'utf8');
const phoneBoundaryRunner = fs.readFileSync('scripts/answer-quality-audit-phone-boundary.mjs', 'utf8');
const runtimeEntry = fs.readFileSync('src/runtime-entry.js', 'utf8');
const telephony = fs.readFileSync('src/telephony/index.js', 'utf8');
const workflow = fs.readFileSync('.github/workflows/direct-answer-quality-audit.yml', 'utf8');
const cases = JSON.parse(fs.readFileSync('qa/answer-quality-cases.json', 'utf8'));

test('answer audit runners have valid JavaScript syntax', () => {
  for (const path of ['scripts/answer-quality-audit.mjs', 'scripts/answer-quality-audit-phone-boundary.mjs']) {
    const checked = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    assert.equal(checked.status, 0, `${path}: ${checked.stderr || checked.stdout}`);
  }
});

test('base answer audit remains transport-neutral and phone wrapper swaps only the AI boundary', () => {
  assert.match(runner, /\/api\/turn/);
  assert.match(phoneBoundaryRunner, /\/api\/internal\/phone-ai-boundary-audit/);
  assert.match(phoneBoundaryRunner, /talksys-phone-ai-boundary-audit-v1/);
  assert.doesNotMatch(phoneBoundaryRunner, /\/telnyx\/media|\/telnyx\/voice|\/api\/transcribe|\/api\/voice\/synthesize|PCMU/i);
});

test('phone AI audit endpoint injects post-STT phone payload and captures pre-TTS JSON answer', () => {
  assert.match(runtimeEntry, /inputBoundary:\s*'post-stt-pre-ai'/);
  assert.match(runtimeEntry, /outputBoundary:\s*'post-ai-pre-tts'/);
  assert.match(runtimeEntry, /channel:\s*'phone'/);
  assert.match(runtimeEntry, /phoneProfile/);
  assert.match(runtimeEntry, /SELECT display_name, personalization_text, memory_text, enabled, version FROM phone_profiles WHERE phone_number=\?/);
  assert.match(runtimeEntry, /integratedEntry\.fetch\(turnRequest/);
});

test('phone audit payload contract remains aligned with live answerWithTalkSys boundary', () => {
  const contractPatterns = [
    /channel:\s*'phone'/,
    /\bsessionId\b/,
    /\butteranceId\b/,
    /\bspokenBackchannel\b/,
    /\bphoneProfile\b/,
  ];
  for (const pattern of contractPatterns) {
    assert.match(telephony, pattern, `live phone boundary missing ${pattern}`);
    assert.match(runtimeEntry, pattern, `audit phone boundary missing ${pattern}`);
  }
  assert.match(telephony, /slice\(-16\)/);
  assert.match(runtimeEntry, /slice\(-16\)/);
});

test('live Telnyx media routes remain present and are not replaced by the audit endpoint', () => {
  assert.match(telephony, /url\.pathname\s*===\s*'\/telnyx\/voice'/);
  assert.match(telephony, /url\.pathname\s*===\s*'\/telnyx\/media'/);
  assert.match(telephony, /mediaBridge\(request\s*,\s*env\s*,\s*deps\)/);
  // V130 wraps the media env for memory jobs, but delegates speech to the same live core.
  assert.match(runtimeEntry, /if \(url\.pathname === '\/telnyx\/media'\)/);
  assert.match(runtimeEntry, /return integratedEntry\.fetch\(request, delegatedEnv, ctx\)/);
  assert.doesNotMatch(runtimeEntry, /\bmediaBridge\s*\(/);
});

test('direct answer audit locks reviewer to the production model and independent Google Search', () => {
  assert.match(runner, /production_model_unknown/);
  assert.match(runner, /audit_model_mismatch/);
  assert.match(runner, /tools:\s*\[\{ type: 'google_search' \}\]/);
  assert.match(runner, /response_format/);
  assert.match(runner, /authoritativeJst/);
});

test('judge citation metadata absence is a warning while production grounding remains structural', () => {
  assert.match(runner, /judge\.evidence\?\.searched === true/);
  assert.doesNotMatch(runner, /judge\.evidence\?\.citations\?\.length > 0\s*&&\s*judge\.result\?\.verdict/);
  assert.match(runner, /citation-metadata-warning/);
  assert.match(runner, /source_count/);
  assert.match(runner, /citation_count/);
});

test('standard suite covers broad factual categories', () => {
  assert.ok(cases.length >= 10);
  const categories = new Set(cases.map((item) => item.category));
  for (const category of ['transit', 'weather', 'law', 'software-current', 'product-price', 'business-hours', 'market-current']) {
    assert.ok(categories.has(category), `missing category: ${category}`);
  }
});

test('workflow exposes manual audit, caller profile input, and production secret scope', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /question:/);
  assert.match(workflow, /phone_number:/);
  assert.match(workflow, /environment:\s*production/);
  assert.match(workflow, /GEMINI_API_KEY:\s*\$\{\{ secrets\.GEMINI_API_KEY \}\}/);
  assert.match(workflow, /test -n "\$\{GEMINI_API_KEY:-\}"/);
  assert.match(workflow, /answer-quality-audit-phone-boundary\.mjs/);
  assert.match(workflow, /GITHUB_STEP_SUMMARY/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /answer-quality-report/);
});

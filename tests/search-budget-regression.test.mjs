import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runNonStreamingCascade } from '../src/cloudflare-llm.js';
import {
  SEARCH_TOTAL_BUDGET_MS,
  SEARCH_PLANNER_BUDGET_MS,
  SEARCH_FETCH_BUDGET_MS,
  SEARCH_COVERAGE_BUDGET_MS,
} from '../src/search-orchestrator.js';

const orchestrator = await readFile(new URL('../src/search-orchestrator.js', import.meta.url), 'utf8');
const worker = await readFile(new URL('../src/worker-v14.js', import.meta.url), 'utf8');
const audit = await readFile(new URL('../src/search-answer-v18.js', import.meta.url), 'utf8');

test('precision search has explicit bounded phase budgets while normal chat remains separate', () => {
  assert.equal(SEARCH_TOTAL_BUDGET_MS, 17000);
  assert.equal(SEARCH_PLANNER_BUDGET_MS, 2800);
  assert.equal(SEARCH_FETCH_BUDGET_MS, 4400);
  assert.equal(SEARCH_COVERAGE_BUDGET_MS, 2200);
  assert.match(orchestrator, /High-model query planning never blocks the first deterministic retrieval pass/);
  assert.match(orchestrator, /Promise\.all\(\[plannerPromise, firstSearchPromise\]\)/);
  assert.match(worker, /normalConversationLiveOnly: true/);
  assert.match(worker, /searchPrecisionOnly: true/);
  assert.match(worker, /searchSecondProgressSpeechMs: 5500/);
});

test('a hanging non-streaming model cannot block the whole cascade', async () => {
  const started = Date.now();
  const ai = {
    run(model) {
      if (model === 'slow') return new Promise(() => {});
      return Promise.resolve({ choices: [{ message: { content: 'fallback ok' } }] });
    },
  };
  const result = await runNonStreamingCascade(ai, ['slow', 'fast'], [{ role: 'user', content: 'test' }], {
    perModelTimeoutMs: 40,
  });
  assert.equal(result.text, 'fallback ok');
  assert.equal(result.model, 'fast');
  assert.ok(Date.now() - started < 500);
});

test('answer audit is single-pass and mechanical guard replaces recursive re-auditing', () => {
  assert.match(audit, /Mechanical evidence guard is the final authority/);
  assert.match(audit, /perModelTimeoutMs: 2500/);
  assert.doesNotMatch(audit, /const second = await auditAnswer/);
});

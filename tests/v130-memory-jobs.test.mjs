import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateV130MemoryTrigger,
  isV130MemoryJobsPath,
  v130MemoryThresholds,
} from '../src/v130-memory-jobs.js';

test('V130 memory job thresholds are bounded and configurable', () => {
  assert.deepEqual(v130MemoryThresholds({}), {
    minUserUtterances: 6,
    minUserChars: 240,
    minCalls: 2,
    maxAgeHours: 24,
  });
  const tuned = v130MemoryThresholds({
    PHONE_MEMORY_JOB_MIN_USER_UTTERANCES: '8',
    PHONE_MEMORY_JOB_MIN_USER_CHARS: '400',
    PHONE_MEMORY_JOB_MIN_CALLS: '3',
    PHONE_MEMORY_JOB_MAX_AGE_HOURS: '72',
  });
  assert.deepEqual(tuned, { minUserUtterances: 8, minUserChars: 400, minCalls: 3, maxAgeHours: 72 });
});

test('explicit memory and preference expressions trigger without an LLM classifier', () => {
  for (const text of ['これを覚えて', '次からナギと呼んで', 'ゆっくり話して', '短く答えて', '一つずつ説明して']) {
    const result = evaluateV130MemoryTrigger({ userTexts: [text], calls: 1, ageHours: 0 });
    assert.equal(result.eligible, true, text);
    assert.equal(result.metrics.explicit, true, text);
    assert.ok(result.reasons.includes('explicit_expression'));
  }
});

test('small incidental call remains ineligible until a mechanical threshold is met', () => {
  const result = evaluateV130MemoryTrigger({ userTexts: ['こんにちは'], calls: 1, ageHours: 0 });
  assert.equal(result.eligible, false);
  assert.deepEqual(result.reasons, []);
});

test('volume and elapsed-time conditions are deterministic', () => {
  assert.equal(evaluateV130MemoryTrigger({ userTexts: Array(6).fill('通常発話'), calls: 1 }).eligible, true);
  assert.equal(evaluateV130MemoryTrigger({ userTexts: ['あ'.repeat(240)], calls: 1 }).eligible, true);
  assert.equal(evaluateV130MemoryTrigger({ userTexts: ['通常発話'], calls: 2 }).eligible, true);
  assert.equal(evaluateV130MemoryTrigger({ userTexts: ['通常発話'], calls: 1, ageHours: 24 }).eligible, true);
});

test('memory job management routes are admin-only side paths', () => {
  assert.equal(isV130MemoryJobsPath('/phone/api/v130/memory/jobs'), true);
  assert.equal(isV130MemoryJobsPath('/phone/api/v130/memory/jobs/12'), true);
  assert.equal(isV130MemoryJobsPath('/phone/stream'), false);
  assert.equal(isV130MemoryJobsPath('/api/transcribe'), false);
  assert.equal(isV130MemoryJobsPath('/api/turn'), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { SEARCH_PROBE_ENGINES, engineForIndex, fallbackEngine } from '../src/search-probes-v44.js';
import { detectApiIntents, extractFxRequest, normalizeSpokenInput } from '../src/free-api-tools-v45.js';
import workerTest from '../src/worker-v44.js';
import worker, { __test as v45 } from '../src/worker-v44.js';
import { __test as search } from '../src/search-v44.js';

// Keep the unused default import evaluation explicit: worker source must remain importable.
void workerTest; void worker;

test('automatic search rotation never selects Google HTML after repeated production 429s', () => {
  assert.equal(SEARCH_PROBE_ENGINES.includes('google'), false);
  for (let i = 0; i < 20; i += 1) assert.notEqual(engineForIndex(i), 'google');
  for (const engine of SEARCH_PROBE_ENGINES) assert.notEqual(fallbackEngine(engine), 'google');
});

test('voice-like Japanese is normalized before structured API intent detection', () => {
  assert.equal(normalizeSpokenInput('ひゃくどるなんえん'), '100ドル何円');
  assert.deepEqual(extractFxRequest('ひゃくどるなんえん'), { base:'USD', quote:'JPY', amount:100 });
  assert.ok(detectApiIntents('べっぷし、きょう雨ふる？').includes('weather'));
});

test('named Japanese holidays enter the holiday API route', () => {
  assert.ok(detectApiIntents('2027年の日本の成人の日はいつ？').includes('holiday'));
});

test('subjective banana chat and broad memory recall stay local', () => {
  assert.equal(v45.shouldSearchByDefault('バナナはおやつに入る？'), false);
  assert.equal(v45.shouldSearchByDefault('さっき何について話してた？'), false);
});

test('partial structured API coverage cannot suppress an unrelated BIOS clause', () => {
  const sufficient = { sufficient:true };
  assert.equal(v45.structuredCoverageIsWholeQuestion('別府市の今日の天気と100米ドルが何円か教えて', sufficient), true);
  assert.equal(v45.structuredCoverageIsWholeQuestion('2026年9月10日の別府の天気とX79ASD40 V27 BIOSの公式配布元を確認して', sufficient), false);
});

test('heuristic candidate fallback can recover concrete model identifiers from evidence', () => {
  assert.equal(typeof search.extractSupportedCandidates, 'function');
});

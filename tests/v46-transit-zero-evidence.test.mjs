import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { guardUnsupportedTransitEntities, transitEvidenceFallback } from '../src/worker-v44.js';
import { transitEndpointsV46, transitQueriesV46 } from '../src/search-v45.js';

test('transit endpoints and seed queries are deterministic and model-free', () => {
  assert.deepEqual(transitEndpointsV46('大分から行橋まで電車でどうやって行けばいい？'), ['大分', '行橋']);
  const q = transitQueriesV46('大分から行橋まで電車でどうやって行けばいい？');
  assert.equal(q.length, 3);
  assert.ok(q.every(x => x.includes('大分') && x.includes('行橋')));
});

test('zero-evidence transit never leaks parametric route specifics', () => {
  const out = guardUnsupportedTransitEntities(
    '大分から小倉までは特急ソニックで約1時間半です。行橋は小倉より手前です。',
    '大分から行橋まで電車でどうやって行けばいい？',
    { evidenceUseful: false, results: [] },
  );
  assert.equal(out, transitEvidenceFallback());
  assert.doesNotMatch(out, /小倉|ソニック|1時間半|鹿児島本線/);
});

test('deep turn bypasses the answer model for transit when retrieval is insufficient', () => {
  const source = fs.readFileSync(new URL('../src/worker-v44.js', import.meta.url), 'utf8');
  assert.match(source, /transit_external_evidence_unavailable/);
  assert.match(source, /transitZeroEvidenceFailClosed: true/);
  assert.match(source, /answer = \{ text: transitEvidenceFallback\(\), ms: 0 \}/);
});

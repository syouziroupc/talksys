import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTurn, localDeterministicAnswer } from '../src/worker-v44.js';

test('DOI identifiers never enter local arithmetic routing', () => {
  const text = 'DOI 10.1038/s41586-020-2649-2 の文献情報を確認して';
  assert.equal(localDeterministicAnswer(text), null);
  const decision = classifyTurn(text, []);
  assert.equal(decision.mode, 'external');
  assert.ok((decision.apiIntents || []).includes('scholarly_metadata'));
});

test('bare DOI form also bypasses arithmetic interpretation', () => {
  const text = '10.1038/s41586-020-2649-2 を確認して';
  assert.equal(localDeterministicAnswer(text), null);
  assert.equal(classifyTurn(text, []).mode, 'external');
});

test('ordinary arithmetic remains deterministic after DOI guard', () => {
  const result = localDeterministicAnswer('12345÷15');
  assert.equal(result?.kind, 'arithmetic');
  assert.match(result?.answer || '', /823/);
});

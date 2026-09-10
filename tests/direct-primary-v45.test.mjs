import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveDirectPrimaryTargets, __test } from '../src/direct-primary-v45.js';

test('known MSI motherboard resolves official support and specification directly', () => {
  const targets = resolveDirectPrimaryTargets('MSI X79A-GD45の最新BIOSを公式で確認して');
  assert.ok(targets.some(x => x.url === 'https://jp.msi.com/Motherboard/X79A-GD45/Specification'));
  assert.ok(targets.some(x => x.url === 'https://jp.msi.com/Motherboard/X79A-GD45/support'));
  assert.ok(targets.every(x => x.model === 'X79A-GD45'));
});

test('direct source resolver does not invent URLs for unknown vendors', () => {
  assert.deepEqual(resolveDirectPrimaryTargets('謎メーカー ZZ-999 の最新BIOS'), []);
});

test('firmware evidence classifier requires version-like evidence for latest version claims', () => {
  assert.equal(__test.evidenceKind('X79A-GD45 BIOS provides Plug and Play BIOS').hasVersionLike, false);
  assert.equal(__test.evidenceKind('X79A-GD45 BIOS Version 2.8 2014-08-11').hasVersionLike, true);
});

test('worker advertises and returns partial primary-source diagnostics', () => {
  const worker = fs.readFileSync(new URL('../src/worker-v44.js', import.meta.url), 'utf8');
  assert.match(worker, /searchDirectPrimaryResolver: true/);
  assert.match(worker, /searchPartialEvidenceAnswering: true/);
  assert.match(worker, /partial_external_evidence_stable_answer/);
  assert.match(worker, /directPrimaryDiagnostics/);
});

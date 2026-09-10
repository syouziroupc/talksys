import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { needsSearchDirector, stageEvidence, __test } from '../src/search-v45.js';

test('shopping comparison remains shopping in deterministic director fallback', () => {
  const p = __test.simplePlan('3万円以下で動画視聴用の中古ノートPCを候補から比較して選んで', []);
  assert.equal(p.intent, 'shopping');
  assert.equal(p.researchMode, 'discover_then_verify');
  assert.equal(p.candidateType, 'product_model');
  assert.ok(p.queries.some(q => /3万円以下.*中古.*ノートパソコン.*型番/.test(q)));
});

test('simple known-model BIOS lookup is compact and manufacturer-scoped', () => {
  assert.equal(needsSearchDirector('MSI X79A-GD45の最新BIOSを公式で確認して'), false);
  const p = __test.simplePlan('MSI X79A-GD45の最新BIOSを公式で確認して', []);
  assert.equal(p.plannerTransport, 'deterministic-simple');
  assert.ok(p.queries.includes('X79A-GD45 BIOS site:msi.com'));
  assert.ok(p.queries.includes('X79A-GD45 BIOS'));
});

test('official support evidence never accepts a non-manufacturer host', () => {
  const bad = stageEvidence('X79A-GD45 BIOS', { title:'X79A-GD45 BIOS download', snippet:'BIOS archive', url:'https://example.com/x79' }, 'verification', 'official_support');
  assert.equal(bad.relevant, false);
  const good = stageEvidence('X79A-GD45 BIOS', { title:'Support for X79A-GD45', snippet:'BIOS Driver Utility', url:'https://www.msi.com/Motherboard/X79A-GD45/support' }, 'verification', 'official_support');
  assert.equal(good.relevant, true);
});

test('retrieval failure flows to stable-only answer instead of throwing to old research failure', () => {
  const worker = fs.readFileSync(new URL('../src/worker-v44.js', import.meta.url), 'utf8');
  assert.match(worker, /web_retrieval_failed_no_evidence/);
  assert.doesNotMatch(worker, /if \(!apiOk\.length\) throw error/);
  assert.match(worker, /検索機能が無効・禁止・使えないとは絶対に説明しない/);
});

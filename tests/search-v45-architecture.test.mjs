import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  SEARCH_V44_MAX_ENGINE_RETRIES,
  SEARCH_V44_MAX_QUERIES,
  SEARCH_V44_MAX_ROUNDS,
  SEARCH_V44_REVISION,
  SEARCH_V45_DIRECTOR_TIMEOUT_MS,
  SEARCH_V45_GENERAL_WEB_SEARCH_ENABLED,
  SEARCH_V45_PROVIDER,
  SEARCH_V45_TOTAL_BUDGET_MS,
  needsSearchDirector,
  stageEvidence,
} from '../src/search-v45.js';

test('v45 keeps formal APIs and direct primary first with resilient rotating web fallback', () => {
  assert.equal(SEARCH_V45_PROVIDER, 'formal-structured-apis+direct-primary+rotating-web');
  assert.equal(SEARCH_V45_GENERAL_WEB_SEARCH_ENABLED, true);
  assert.equal(SEARCH_V44_MAX_ENGINE_RETRIES, 2);
  assert.ok(SEARCH_V44_MAX_QUERIES <= 8);
  assert.ok(SEARCH_V44_MAX_ROUNDS <= 3);
  assert.ok(SEARCH_V45_TOTAL_BUDGET_MS <= 12000);
  assert.ok(SEARCH_V45_DIRECTOR_TIMEOUT_MS <= 2200);
  assert.match(SEARCH_V44_REVISION, /api-primary-multi-engine-web/);
  const worker = fs.readFileSync(new URL('../src/worker-v44.js', import.meta.url), 'utf8');
  assert.match(worker, /from '\.\/search-v45\.js'/);
  assert.match(worker, /searchEngineRotation: true/);
  assert.match(worker, /searchSingleProvider: false/);
  assert.match(worker, /searchGeneralWebEnabled: SEARCH_V45_GENERAL_WEB_SEARCH_ENABLED/);
});

test('Qwen director is reserved for genuinely complex research, not routine shopping or simple official lookup', () => {
  assert.equal(needsSearchDirector('MSI X79A-GD45の最新BIOSを公式で確認して'), false);
  assert.equal(needsSearchDirector('3万円以下で動画視聴用の中古ノートPCを候補から比較して選んで'), false);
  assert.equal(needsSearchDirector('CF-SV9とThinkPad X280を比較して、3万円以下かつUSB-C充電対応の候補を選んで'), true);
});

test('discovery gate favors recall while verification is stricter', () => {
  const result = { title: 'Panasonic Let’s note CF-SV9 中古ノートパソコン', snippet: '整備済みノートPC', url: 'https://example.com/item' };
  assert.equal(stageEvidence('3万円以下 中古 ノートパソコン', result, 'discovery', 'seller').relevant, true);
  const generic = { title: 'パソコンの選び方', snippet: '初心者向けの記事です', url: 'https://example.com/guide' };
  assert.equal(stageEvidence('CF-SV9 仕様', generic, 'verification', 'reference').relevant, false);
});

test('search failure keeps stable knowledge fallback instead of blanket give-up', () => {
  const worker = fs.readFileSync(new URL('../src/worker-v44.js', import.meta.url), 'utf8');
  assert.match(worker, /external_evidence_unavailable_stable_only/);
  assert.match(worker, /時間で変化しない一般的な判断基準/);
});
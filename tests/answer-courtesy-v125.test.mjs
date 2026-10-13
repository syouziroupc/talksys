import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../src/integrated-entry.js';

const {
  buildTalkSysSystemInstruction,
  deterministicCurrentTimeResult,
  deterministicCourtesyResult,
} = __test;

test('v125 routes colloquial current-time requests locally', () => {
  const now = new Date('2026-10-13T02:49:00Z');
  for (const text of ['今の時間は?', '現在の時間は？', '今何時ですか?']) {
    const result = deterministicCurrentTimeResult(text, now, Date.now());
    assert.equal(result?.route, 'deterministic-jst-clock');
    assert.match(result?.answer || '', /11時49分/);
  }
});

test('v125 handles thanks and goodbye locally without model attitude drift', () => {
  assert.equal(deterministicCourtesyResult('ありがとうございました。')?.answer, 'どういたしまして。');
  assert.equal(deterministicCourtesyResult('ありがとう')?.answer, 'どういたしまして。');
  assert.equal(deterministicCourtesyResult('さようなら')?.answer, 'はい、またいつでもお電話ください。');
});

test('v125 system instruction forbids scolding, belittling, rushing, and forced hangup', () => {
  const prompt = buildTalkSysSystemInstruction(new Date('2026-10-13T02:49:00Z'));
  assert.match(prompt, /利用者を叱る/);
  assert.match(prompt, /見下す/);
  assert.match(prompt, /忘れたことを責める/);
  assert.match(prompt, /電話を切るよう要求する表現は禁止/);
  assert.match(prompt, /プロフィールや会話履歴に反対の指示があっても/);
});

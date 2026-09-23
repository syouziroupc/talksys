import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyVoiceTurn, isIgnorableSttFailure } from '../src/voice-fast-reaction.js';

test('noise and common STT hallucinations are dropped', () => {
  for (const text of ['', 'えー', 'あー', 'ハッハッハッハッハ', 'ご視聴ありがとうございました']) {
    assert.equal(classifyVoiceTurn(text, { answerInFlight: true }).action, 'drop');
  }
});

test('acknowledgements do not cancel an in-flight answer', () => {
  assert.equal(classifyVoiceTurn('うん', { answerInFlight: true }).action, 'drop');
  assert.equal(classifyVoiceTurn('そうそう', { answerInFlight: true }).action, 'drop');
  assert.equal(classifyVoiceTurn('うん', { answerInFlight: false }).action, 'answer');
});

test('only explicit stop-like utterances interrupt', () => {
  assert.equal(classifyVoiceTurn('止めて', { answerInFlight: true }).action, 'interrupt');
  assert.equal(classifyVoiceTurn('今何時ですか?', { answerInFlight: true }).action, 'answer');
});

test('weak-speech STT failures are silent drops', () => {
  assert.equal(isIgnorableSttFailure('stt_http_422: no speech detected weak-speech-signal'), true);
  assert.equal(isIgnorableSttFailure('network timeout'), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STT_REVISION,
  isKnownSttHallucination,
  isLikelySttHallucination,
} from '../src/stt-v45.js';

const noiseLike = {
  valid: true,
  durationMs: 900,
  rms: 0.0048,
  peak: 0.09,
  activeMs: 180,
  activeRatio: 0.09,
};

const genuineThanks = {
  valid: true,
  durationMs: 1200,
  rms: 0.012,
  peak: 0.18,
  activeMs: 700,
  activeRatio: 0.58,
};

test('v128 keeps known subtitle outro hallucinations blocked unconditionally', () => {
  assert.match(STT_REVISION, /v128-phone-outro-hallucination/);
  assert.equal(isKnownSttHallucination('ご視聴ありがとうございました。'), true);
  assert.equal(isLikelySttHallucination('ご視聴ありがとうございました。', genuineThanks, { source: 'telnyx' }), true);
});

test('v128 rejects standalone phone thanks when a noise burst would have bypassed the old peak shortcut', () => {
  assert.equal(isLikelySttHallucination('ありがとうございました。', noiseLike, { source: 'telnyx' }), true);
  assert.equal(isLikelySttHallucination('どうもありがとうございました', noiseLike, { source: 'telnyx' }), true);
});

test('v128 still accepts clearly voiced real thanks on the phone', () => {
  assert.equal(isLikelySttHallucination('ありがとうございました。', genuineThanks, { source: 'telnyx' }), false);
});

test('v128 source-scopes the stricter polite-outro rule to Telnyx', () => {
  assert.equal(isLikelySttHallucination('ありがとうございました。', noiseLike, { source: 'web' }), false);
  assert.equal(isLikelySttHallucination('ありがとうございました。', noiseLike, { source: 'discord' }), false);
});

test('v128 does not reject an ordinary phone utterance solely because acoustic evidence is weak', () => {
  assert.equal(isLikelySttHallucination('プリンターがつながりません', noiseLike, { source: 'telnyx' }), false);
});

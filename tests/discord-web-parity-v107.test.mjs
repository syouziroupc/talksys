import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');

test('Discord v107 delegates semantic cue decisions to shared Worker endpoints', () => {
  assert.match(source, /talksys-discord-bridge-v107-web-parity-r1/);
  assert.match(source, /TALKSYS_BASE_URL \+ '\/api\/fast-reaction'/);
  assert.match(source, /TALKSYS_BASE_URL \+ '\/api\/search-preface'/);
  assert.doesNotMatch(source, /eou-local/);
  assert.doesNotMatch(source, /const reaction = fastReaction\(value\)/);
  assert.doesNotMatch(source, /samples\.map\(\(sample\) => fastReaction/);
});

test('Discord v107 keeps search preface independent from fast reaction', () => {
  assert.match(source, /const cue = await fetchSearchPreface\(text, signal\)/);
  assert.match(source, /if \(activeFastReaction\?\.done\)/);
  assert.match(source, /activeWaitCue = startWaitCue\(confirmedTranscript, utteranceId, controller\.signal\)/);
});

test('Discord v107 keeps freeze guards around shared services', () => {
  assert.match(source, /turn: 35000/);
  assert.match(source, /tts: 12000/);
  assert.match(source, /waitCue: 1800/);
  assert.match(source, /playback_start_timeout/);
  assert.match(source, /playback_timeout/);
  assert.match(source, /AbortSignal\.any/);
});

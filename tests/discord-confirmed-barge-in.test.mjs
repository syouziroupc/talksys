import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');
const start = source.indexOf('async function processConfirmedTranscript(');
const end = source.indexOf('\nasync function handleCapturedUtterance(', start);
const process = source.slice(start, end);

test('confirmed meaningful bot-overlap speech preempts current answer before queueing', () => {
  const overlap = process.indexOf("interruptActiveAnswer('confirmed-transcript-barge-in')");
  const queue = process.indexOf('if (answering) {', process.indexOf('shouldDropUncorroboratedBotOverlap'));
  assert.ok(overlap >= 0, 'confirmed barge-in preemption must exist');
  assert.ok(queue > overlap, 'preemption must happen before pending queue fallback');
  assert.match(process.slice(Math.max(0, overlap - 300), overlap + 160), /captureMetrics\?\.overlappedBotPlayback/);
});

test('echo/drop policy still runs before confirmed barge-in preemption', () => {
  const drop = process.indexOf('shouldDropUncorroboratedBotOverlap');
  const overlap = process.indexOf("interruptActiveAnswer('confirmed-transcript-barge-in')");
  assert.ok(drop >= 0 && drop < overlap);
});

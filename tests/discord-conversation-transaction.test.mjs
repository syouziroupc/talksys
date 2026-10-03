import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');

function functionBody(name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const next = source.indexOf('\nasync function ', start + 1);
  return source.slice(start, next >= 0 ? next : source.length);
}

test('talk fetches a candidate response without committing conversation state', () => {
  const talk = functionBody('talk');
  assert.doesNotMatch(talk, /previousInteractionId\s*=\s*body\.interactionId/);
  assert.doesNotMatch(talk, /history\.push\(/);
  assert.doesNotMatch(talk, /searchTrace\s*=\s*\{/);
});

test('conversation state has one explicit commit function', () => {
  assert.match(source, /function commitConversationTurn\(text, body\)/);
  assert.match(source, /previousInteractionId\s*=\s*body\.interactionId/);
  assert.match(source, /history\.push\(\{ role: 'user', content: text \}, \{ role: 'assistant', content: body\.answer \}\)/);
});

test('final answer commits only after playback completes and active turn is still valid', () => {
  const process = functionBody('processConfirmedTranscript');
  const playback = process.indexOf('await playMp3(tts.audio');
  const commit = process.indexOf('commitConversationTurn(confirmedTranscript, turn)');
  assert.ok(playback >= 0 && commit > playback, 'commit must occur after awaited playback');
  const guard = process.slice(playback, commit);
  assert.match(guard, /!controller\.signal\.aborted/);
  assert.match(guard, /turnSerial === activeTurnSerial/);
  assert.match(guard, /sessionEpoch === voiceEpoch/);
});

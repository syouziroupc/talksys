import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PHONE_GREETING_LATENCY_REVISION } from '../src/telephony/index.js';

test('v114 marks the greeting latency change', () => {
  assert.match(PHONE_GREETING_LATENCY_REVISION, /v114/);
});

test('phone start event does not await D1 before greeting playback', async () => {
  const source = await readFile(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /await upsertCall\(env,\{callId,from,to,status:'active'\}\)/);
  assert.match(source, /trackTask\(upsertCall\(env,\{callId,from,to,status:'active'\}\)/);
});

test('greeting PCMU is prepared before the Telnyx start handler uses it', async () => {
  const source = await readFile(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
  assert.match(source, /warmPhoneGreetingAudio/);
  assert.match(source, /const greetingAudioPromise=warmPhoneGreetingAudio/);
  assert.match(source, /preparedAudio:preparedGreeting\|\|undefined/);
  assert.match(source, /purpose:'greeting'/);
  assert.match(source, /`\$\{purpose\}_first_pcmu`/);
});

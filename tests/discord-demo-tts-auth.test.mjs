import test from 'node:test';
import assert from 'node:assert/strict';
import { __test as integrated } from '../src/integrated-entry.js';

test('Discord TTS rejects requests when the permanent shared token is not configured', () => {
  const legacyDemoRequest = new Request('https://talksys.test/api/voice/synthesize', {
    headers: { 'x-talksys-demo': 'discord-voice-smoke-20260918' },
  });
  assert.equal(integrated.discordVoiceTtsAuthorized(legacyDemoRequest, {}), false);
});

test('Discord TTS accepts only the exact permanent bearer token', () => {
  const env = { DISCORD_BRIDGE_TOKEN: 'shared-secret' };
  const good = new Request('https://talksys.test/api/voice/synthesize', {
    headers: { authorization: 'Bearer shared-secret' },
  });
  const wrong = new Request('https://talksys.test/api/voice/synthesize', {
    headers: { authorization: 'Bearer wrong-secret' },
  });
  const legacy = new Request('https://talksys.test/api/voice/synthesize', {
    headers: { 'x-talksys-demo': 'discord-voice-smoke-20260918' },
  });
  assert.equal(integrated.discordVoiceTtsAuthorized(good, env), true);
  assert.equal(integrated.discordVoiceTtsAuthorized(wrong, env), false);
  assert.equal(integrated.discordVoiceTtsAuthorized(legacy, env), false);
});

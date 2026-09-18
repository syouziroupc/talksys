import test from 'node:test';
import assert from 'node:assert/strict';
import { __test as integrated } from '../src/integrated-entry.js';

test('temporary Discord TTS demo is allowed only before the cutoff when no shared token exists', () => {
  const request = new Request('https://talksys.test/api/voice/synthesize', {
    headers: { 'x-talksys-demo': 'discord-voice-smoke-20260918' },
  });
  assert.equal(
    integrated.discordVoiceTtsAuthorized(request, {}, Date.parse('2026-09-18T07:30:00Z')),
    true,
  );
  assert.equal(
    integrated.discordVoiceTtsAuthorized(request, {}, Date.parse('2026-09-18T08:00:01Z')),
    false,
  );
});

test('configured shared token disables the temporary demo bypass', () => {
  const demoRequest = new Request('https://talksys.test/api/voice/synthesize', {
    headers: { 'x-talksys-demo': 'discord-voice-smoke-20260918' },
  });
  const authRequest = new Request('https://talksys.test/api/voice/synthesize', {
    headers: { authorization: 'Bearer shared-secret' },
  });
  const env = { DISCORD_BRIDGE_TOKEN: 'shared-secret' };
  assert.equal(integrated.discordVoiceTtsAuthorized(demoRequest, env, 0), false);
  assert.equal(integrated.discordVoiceTtsAuthorized(authRequest, env, 0), true);
});

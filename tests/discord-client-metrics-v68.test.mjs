import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');

test('Discord client metrics endpoint is bridge-authenticated and persisted to D1 conversation logs', () => {
  assert.match(source, /url\.pathname === '\/api\/voice-metrics'/);
  assert.match(source, /discordVoiceMetricsResponse\(request, env, ctx\)/);
  assert.match(source, /discordVoiceTtsAuthorized\(request, env\)/);
  assert.match(source, /scheduleConversationLog\(ctx, env, request, logBody, result, 'voice-metrics', 202\)/);
  assert.match(source, /route: 'discord-client-metrics'/);
});

test('Discord latency metrics accept only bounded known fields', () => {
  assert.match(source, /function compactClientTimings\(value = \{\}\)/);
  for (const key of ['sttMs','batchSttMs','turnStreamMs','serverTotalMs','primaryMs','verifierMs','firstAudioReadyMs','firstTtsMs','pipelineCompleteMs','playbackMs']) {
    assert.match(source, new RegExp("'" + key + "'"));
  }
  assert.match(source, /n >= 0 && n <= 600000/);
  assert.match(source, /sttReused/);
  assert.match(source, /ttsSource/);
});

test('voice health advertises the private client metrics endpoint', () => {
  assert.match(source, /discordVoiceMetricsEndpoint: '\/api\/voice-metrics'/);
});

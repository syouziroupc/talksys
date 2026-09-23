import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');

test('Discord client metrics endpoint remains bridge-authenticated and persisted', () => {
  assert.match(source, /url\.pathname === '\/api\/voice-metrics'/);
  assert.match(source, /discordVoiceMetricsResponse\(request, env, ctx\)/);
  assert.match(source, /discordVoiceTtsAuthorized\(request, env\)/);
  assert.match(source, /scheduleConversationLog\(ctx, env, request, logBody, result, 'voice-metrics', 202\)/);
});

test('Discord v79 latency metrics accept only current adapter fields', () => {
  assert.match(source, /function compactClientTimings\(value = \{\}\)/);
  for (const key of [
    'captureMs','sttMs','speechEndToSttFinalMs','fastReactionMs','answerStartMs','primaryMs',
    'verifierMs','answerGenerationTotalMs','firstAudioReadyMs','firstTtsMs',
    'pipelineCompleteMs','speechEndToPlaybackStartMs','ffmpegSpawnMs','playbackMs',
  ]) assert.match(source, new RegExp("'" + key + "'"));
  for (const dead of ['batchSttMs','turnStreamMs','serverTotalMs','sttReused','ttsSource']) {
    assert.doesNotMatch(source.slice(source.indexOf('function compactClientTimings'), source.indexOf('function compactVoiceTimeline')), new RegExp(dead));
  }
  assert.match(source, /n >= 0 && n <= 600000/);
});

test('voice timeline and transcript provenance are persisted', () => {
  assert.match(source, /function compactVoiceTimeline/);
  for (const key of [
    'discordReceiveStartAt','firstPcmAt','utteranceEndAt','fastReactionRequestedAt','fastReactionPlaybackAt','wavReadyAt',
    'transcribeStartAt','whisperCompleteAt','turnStartAt','finalAnswerAt',
    'ttsStartAt','ttsEndAt','playbackStartAt','pipelineCompleteAt',
  ]) assert.match(source, new RegExp("'" + key + "'"));
  assert.match(source, /realtimeTranscript/);
  assert.match(source, /confirmedTranscript/);
  assert.match(source, /geminiInputText/);
  assert.match(source, /transcriptMatch/);
});

test('voice health advertises Discord as a web audio adapter using /api/turn', () => {
  assert.match(source, /discordArchitecture: 'web-audio-adapter'/);
  assert.match(source, /discordFinalStt: 'whisper-large-v3-turbo-via-api-transcribe'/);
  assert.match(source, /discordRealtimeSttAuthoritative: false/);
  assert.match(source, /discordRealtimeSttRole: 'fast-reaction-only'/);
  assert.match(source, /discordFastReactionEndpoint: '\/api\/fast-reaction'/);
  assert.match(source, /discordRuntimeLogCommand: '\/logs'/);
  assert.match(source, /discordTurnEndpoint: '\/api\/turn'/);
});

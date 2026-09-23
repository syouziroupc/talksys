import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const integrated = fs.readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');
const bridge = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('Workers logs, traces, and Analytics Engine remain enabled', () => {
  assert.match(wrangler, /"logs": \{ "enabled": true, "head_sampling_rate": 1 \}/);
  assert.match(wrangler, /"traces": \{ "enabled": true, "head_sampling_rate": 1 \}/);
  assert.match(wrangler, /"binding": "TALKSYS_LATENCY"/);
  assert.match(wrangler, /"dataset": "talksys_latency"/);
});

test('web and Discord final answers use the same common TalkSys turn function', () => {
  assert.match(integrated, /export async function commonTalkSysTurn/);
  assert.match(integrated, /const result = await commonTalkSysTurn\(commonBody, env, signal\)/);
  assert.match(bridge, /TALKSYS_BASE_URL \+ '\/api\/turn'/);
  assert.doesNotMatch(bridge, /\/api\/turn-stream|talkStream/);
  assert.doesNotMatch(integrated, /url\.pathname === '\/api\/turn-stream'/);
});

test('Discord final STT is confirmed Whisper, never Nova', () => {
  assert.match(bridge, /transcribeCapturedUtterance/);
  assert.match(bridge, /\/api\/transcribe/);
  assert.match(bridge, /sttMode: 'whisper-batch'/);
  assert.match(bridge, /fallback: false/);
  assert.doesNotMatch(bridge, /\/api\/realtime-stt|speech_final|WebSocket|batchTranscribePcm16|type:\s*['"]Finalize['"]/);
});

test('utterance telemetry covers capture through Discord playback', () => {
  for (const field of [
    'utteranceId','sessionId','channel','captureMs','speechEndToSttFinalMs',
    'answerStartMs','primaryMs','verifierMs','answerGenerationTotalMs',
    'firstTtsMs','firstAudioReadyMs','speechEndToPlaybackStartMs',
    'pipelineCompleteMs','ffmpegSpawnMs','ttsProvider',
    'discordReceiveStartAt','firstPcmAt','utteranceEndAt','wavReadyAt',
    'transcribeStartAt','whisperCompleteAt','turnStartAt','finalAnswerAt',
    'ttsStartAt','ttsEndAt','playbackStartAt','pipelineCompleteAt',
  ]) assert.match(integrated + bridge, new RegExp(field));
  assert.match(integrated, /writeDataPoint/);
  assert.match(integrated, /transcribe-start/);
  assert.match(integrated, /transcribe-complete/);
});

test('transcript provenance can show realtime versus confirmed text without making realtime authoritative', () => {
  assert.match(integrated, /realtimeTranscript/);
  assert.match(integrated, /confirmedTranscript/);
  assert.match(integrated, /geminiInputText/);
  assert.match(integrated, /transcriptMatch/);
  assert.match(bridge, /realtimeTranscript: ''/);
  assert.match(bridge, /geminiInputText: confirmedTranscript/);
});

test('wait cue is independent from the final answer dependency chain', () => {
  assert.match(bridge, /activeWaitCue = startWaitCue/);
  assert.match(bridge, /const turn = await talk/);
  assert.match(bridge, /activeWaitCue\?\.stop\('final-answer-ready'\)/);
  assert.doesNotMatch(bridge, /await activeWaitCue\.done/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const integrated = readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');

test('generic verification remains enabled in the common web/Discord turn path', () => {
  assert.match(integrated, /export async function commonTalkSysTurn/);
  assert.match(integrated, /return runGeminiTurn\(body, env, signal, options\)/);
  assert.match(integrated, /shouldRunGenericVerification\(text, interaction\.payload\)/);
  assert.match(integrated, /runGenericGeminiVerification\(env, body, interaction, signal, now\)/);
  assert.match(integrated, /const result = await commonTalkSysTurn\(commonBody, env, signal\)/);
});

test('Discord confirmed Whisper is the only text allowed into common TalkSys', () => {
  assert.match(bridge, /confirmedTranscript = String\(body\.text\)\.trim\(\)/);
  assert.match(bridge, /const turn = await talk\(confirmedTranscript, utteranceId, controller\.signal\)/);
  assert.match(bridge, /geminiInputText: confirmedTranscript/);
  assert.doesNotMatch(bridge, /\/api\/realtime-stt|speech_final|WebSocket|type:\s*['"]Finalize['"]/);
});

test('Whisper is the normal path with a quality-first timeout', () => {
  assert.match(bridge, /stt: 30000/);
  assert.match(bridge, /async function transcribeCapturedUtterance/);
  assert.match(bridge, /TALKSYS_BASE_URL \+ '\/api\/transcribe'/);
  assert.match(bridge, /sttMode: 'web-whisper'/);
  assert.doesNotMatch(bridge, /batchSttMs|batchTranscribePcm16|fallbackController|realtimeSttBackoff|realtimeSttSockets/);
  assert.doesNotMatch(bridge, /batchTranscribePcm16|fallbackController|realtimeSttBackoff|realtimeSttSockets/);
});

test('wait audio cannot block final answer TTS', () => {
  assert.match(bridge, /activeWaitCue = startWaitCue/);
  assert.match(bridge, /const turn = await talk/);
  assert.match(bridge, /activeWaitCue\?\.stop\('final-answer-ready'\)/);
  assert.match(bridge, /player\.stop\(true\)/);
  assert.doesNotMatch(bridge, /await activeWaitCue\.done/);
});

test('latency metrics preserve the full quality-first pipeline', () => {
  for (const key of [
    'captureMs','sttMs','speechEndToSttFinalMs','primaryMs','verifierMs',
    'answerGenerationTotalMs','firstTtsMs','firstAudioReadyMs',
    'ffmpegSpawnMs','speechEndToPlaybackStartMs','pipelineCompleteMs',
  ]) assert.match(bridge + integrated, new RegExp(key));
});

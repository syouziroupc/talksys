import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TALK_CLIENT_V45 } from '../src/talk-client-v45.js';
import { WEB_VOICE_CAPTURE_POLICY } from '../src/voice-capture-policy.js';

const bridge = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');
const integrated = fs.readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');
const logSource = fs.readFileSync(new URL('../src/log-v42.js', import.meta.url), 'utf8');

test('Web capture policy remains canonical for browser capture and Discord audio normalization', () => {
  assert.equal(WEB_VOICE_CAPTURE_POLICY.targetRate, 16000);
  assert.equal(WEB_VOICE_CAPTURE_POLICY.silenceMs, 900);
  assert.equal(WEB_VOICE_CAPTURE_POLICY.highpassHz, 90);
  assert.match(TALK_CLIENT_V45, /SILENCE_MS=900/);
  assert.match(TALK_CLIENT_V45, /inputFilter\.frequency\.value=90/);
  assert.match(bridge, /highpass=f=\$\{WEB_VOICE_CAPTURE_POLICY\.highpassHz\},aresample=\$\{WEB_VOICE_CAPTURE_POLICY\.targetRate\}/);
});

test('Discord transport speaking gate is authoritative and browser VAD cannot discard speech', () => {
  assert.match(bridge, /Discord already gates outgoing voice by speaking state/);
  assert.match(bridge, /const pcm16Chunks = \[\]/);
  assert.match(bridge, /pcm16Chunks\.push\(Buffer\.from\(pcm16\)\)/);
  assert.match(bridge, /browserVadBypassed: true/);
  assert.match(bridge, /transportGated: true/);
  assert.match(bridge, /const DISCORD_SEGMENT_SILENCE_MS = WEB_VOICE_CAPTURE_POLICY\.silenceMs/);
  assert.match(bridge, /Date\.now\(\) - lastPcmAt >= DISCORD_SEGMENT_SILENCE_MS/);
  assert.doesNotMatch(bridge, /WebCompatibleCapture|captureMetrics\.voicedMs|captureMetrics\.snr|voiceProfiles|learnRejectedCapture|learnSuccessfulSpeech|learnSttFailure/);
});

test('Discord final STT always uses the same /api/transcribe Whisper path as web', () => {
  assert.match(bridge, /async function transcribeCapturedUtterance/);
  assert.match(bridge, /TALKSYS_BASE_URL \+ '\/api\/transcribe'/);
  assert.match(bridge, /content-type': 'audio\/wav'/);
  assert.match(bridge, /stt: 30000/);
  assert.match(bridge, /confirmedTranscript = String\(body\.text\)\.trim\(\)/);
  assert.match(bridge, /const turn = await talk\(confirmedTranscript, utteranceId, controller\.signal, speechAlternatives\)/);
  assert.match(bridge, /geminiInputText: confirmedTranscript/);
  assert.match(bridge, /\/api\/realtime-stt/);
  assert.match(bridge, /\/api\/fast-reaction/);
  assert.doesNotMatch(bridge, /batchTranscribePcm16|realtimeSttBackoff|realtimeSttSockets|type:\s*['"]Finalize['"]/i);
});

test('Discord uses only /api/turn for final answer generation', () => {
  assert.match(bridge, /TALKSYS_BASE_URL \+ '\/api\/turn'/);
  assert.doesNotMatch(bridge, /\/api\/turn-stream|talkStream|sentenceCount|queueSentence/);
  assert.doesNotMatch(integrated, /url\.pathname === '\/api\/turn-stream'/);
  assert.match(integrated, /export async function commonTalkSysTurn/);
});

test('playback still fails loudly, while greeting TTS failure no longer tears down VC connection', () => {
  assert.match(bridge, /playback_start_timeout/);
  assert.match(bridge, /connection greeting unavailable/);
  assert.doesNotMatch(bridge, /throw new Error\(\`connection_greeting_failed:/);
  assert.match(bridge, /synthesizeWindowsJapaneseTts/);
});

test('one utterance id correlates capture, Whisper, common turn, TTS and playback milestones', () => {
  for (const field of [
    'discordReceiveStartAt','firstPcmAt','utteranceEndAt','wavReadyAt',
    'transcribeStartAt','whisperCompleteAt','turnStartAt','finalAnswerAt',
    'ttsStartAt','ttsEndAt','playbackStartAt','pipelineCompleteAt',
  ]) assert.match(bridge + integrated, new RegExp(field));
  assert.match(bridge, /x-talksys-utterance': utteranceId/);
  assert.match(logSource, /confirmedTranscript/);
  assert.match(logSource, /geminiInputText/);
});

test('Discord dependency set no longer contains realtime websocket STT client', () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL('../discord-voice-smoke/package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.dependencies.ws, undefined);
});

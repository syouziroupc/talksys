import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TALK_CLIENT_V45 } from '../src/talk-client-v45.js';
import { WEB_VOICE_CAPTURE_POLICY } from '../src/voice-capture-policy.js';
import { WebCompatibleCapture } from '../discord-voice-smoke/src/web-compatible-capture.mjs';

const bridge = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');
const integrated = fs.readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');
const logSource = fs.readFileSync(new URL('../src/log-v42.js', import.meta.url), 'utf8');

function pcmFrame(amplitude, ms = WEB_VOICE_CAPTURE_POLICY.frameMs) {
  const samples = Math.round(WEB_VOICE_CAPTURE_POLICY.targetRate * ms / 1000);
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) out.writeInt16LE(amplitude, i * 2);
  return out;
}

test('shared Discord capture policy is locked to current web voice constants', () => {
  assert.equal(WEB_VOICE_CAPTURE_POLICY.targetRate, 16000);
  assert.equal(WEB_VOICE_CAPTURE_POLICY.silenceMs, 650);
  assert.equal(WEB_VOICE_CAPTURE_POLICY.minSpeechMs, 260);
  assert.equal(WEB_VOICE_CAPTURE_POLICY.maxUtteranceMs, 12000);
  assert.equal(WEB_VOICE_CAPTURE_POLICY.preRollFrames, 8);
  assert.equal(WEB_VOICE_CAPTURE_POLICY.minVoicedMs, 240);
  assert.equal(WEB_VOICE_CAPTURE_POLICY.minSnr, 1.55);
  assert.equal(WEB_VOICE_CAPTURE_POLICY.highpassHz, 90);
  assert.match(TALK_CLIENT_V45, /SILENCE_MS=650/);
  assert.match(TALK_CLIENT_V45, /MIN_SPEECH_MS=260/);
  assert.match(TALK_CLIENT_V45, /PRE_ROLL=8/);
  assert.match(TALK_CLIENT_V45, /inputFilter\.frequency\.value=90/);
});

test('web-compatible capture keeps pre-roll and waits for the web 650 ms silence window', () => {
  let now = 1000;
  const capture = new WebCompatibleCapture({ now: () => now });
  const quiet = pcmFrame(0);
  const voice = pcmFrame(7000);
  for (let i = 0; i < 4; i += 1) { capture.push(quiet, now); now += 40; }
  for (let i = 0; i < 8; i += 1) { capture.push(voice, now); now += 40; }
  assert.equal(capture.speech, true);
  assert.equal(capture.shouldFinalize(capture.lastPcmAt + 649), false);
  assert.equal(capture.shouldFinalize(capture.lastPcmAt + 650), true);
  const result = capture.finalize(capture.lastPcmAt + 650);
  assert.equal(result.metrics.speechDetected, true);
  assert.equal(result.metrics.preRollFrames, 8);
  assert.ok(result.pcm.length > 0);
  assert.ok(result.metrics.acceptedPcmBytes >= result.metrics.rawPcmBytes);
  assert.ok(result.metrics.durationMs >= WEB_VOICE_CAPTURE_POLICY.minSpeechMs);
});


test('very short Discord speech receives only silent pre-roll padding, not fabricated speech', () => {
  let now = 2000;
  const capture = new WebCompatibleCapture({ now: () => now });
  const voice = pcmFrame(7000);
  for (let i = 0; i < 3; i += 1) { capture.push(voice, now); now += 40; }
  assert.equal(capture.speech, true);
  const result = capture.finalize(now);
  assert.equal(result.metrics.voicedMs, 120);
  assert.equal(result.metrics.preRollFrames, 8);
  assert.equal(result.metrics.durationMs, 320);
  assert.equal(result.pcm.length, 8 * voice.length);
});

test('Discord final STT always uses the same /api/transcribe Whisper path as web', () => {
  assert.match(bridge, /async function transcribeCapturedUtterance/);
  assert.match(bridge, /TALKSYS_BASE_URL \+ '\/api\/transcribe'/);
  assert.match(bridge, /content-type': 'audio\/wav'/);
  assert.match(bridge, /REQUEST_BUDGET_MS = Object\.freeze\([\s\S]*stt: 30000/);
  assert.match(bridge, /confirmedTranscript = String\(body\.text\)\.trim\(\)/);
  assert.match(bridge, /await talk\(confirmedTranscript, utteranceId, controller\.signal\)/);
  assert.match(bridge, /geminiInputText: confirmedTranscript/);
  assert.doesNotMatch(bridge, /\/api\/realtime-stt|WebSocket|speech_final|batchTranscribePcm16|realtimeSttBackoff|realtimeSttSockets|type:\s*['"]Finalize['"]/i);
});

test('Discord uses only /api/turn for final answer generation and has no separate answer stream', () => {
  assert.match(bridge, /TALKSYS_BASE_URL \+ '\/api\/turn'/);
  assert.doesNotMatch(bridge, /\/api\/turn-stream|talkStream|sentenceCount|queueSentence/);
  assert.doesNotMatch(integrated, /url\.pathname === '\/api\/turn-stream'/);
  assert.match(integrated, /export async function commonTalkSysTurn/);
  assert.match(integrated, /const result = await commonTalkSysTurn\(commonBody, env, signal\)/);
});

test('wait cue is independent and is stopped before final answer TTS', () => {
  assert.match(bridge, /activeWaitCue = startWaitCue\(confirmedTranscript/);
  assert.match(bridge, /const turn = await talk\(confirmedTranscript/);
  assert.match(bridge, /activeWaitCue\?\.stop\('final-answer-ready'\)/);
  assert.match(bridge, /player\.stop\(true\)/);
  const stop = bridge.indexOf("activeWaitCue?.stop('final-answer-ready')");
  const tts = bridge.indexOf("timeline.ttsStartAt = Date.now()", stop);
  assert.ok(stop >= 0 && tts > stop);
});

test('one utterance id correlates capture, Whisper, common turn, TTS and playback milestones', () => {
  for (const field of [
    'discordReceiveStartAt','firstPcmAt','utteranceEndAt','wavReadyAt',
    'transcribeStartAt','whisperCompleteAt','turnStartAt','finalAnswerAt',
    'ttsStartAt','ttsEndAt','playbackStartAt','pipelineCompleteAt',
  ]) assert.match(bridge + integrated, new RegExp(field));
  assert.match(bridge, /x-talksys-utterance': utteranceId/);
  assert.match(bridge, /utteranceId,/);
  assert.match(integrated, /confirmedTranscript/);
  assert.match(integrated, /geminiInputText/);
  assert.match(logSource, /realtimeTranscript/);
  assert.match(logSource, /confirmedTranscript/);
  assert.match(logSource, /geminiInputText/);
  assert.match(logSource, /transcriptMatch/);
});

test('Discord dependency set no longer contains realtime websocket STT client', () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL('../discord-voice-smoke/package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.dependencies.ws, undefined);
});

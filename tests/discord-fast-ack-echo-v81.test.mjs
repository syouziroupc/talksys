import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const bridge = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');
const integrated = fs.readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');

test('Discord acknowledgement starts at utterance finalization before Whisper completes', () => {
  const finalize = bridge.indexOf('startImmediateAck(utteranceId, sessionEpoch, timeline);');
  const stt = bridge.indexOf('await handleCapturedUtterance({', finalize);
  assert.ok(finalize >= 0 && stt > finalize);
  assert.match(bridge, /const IMMEDIATE_ACK_PROMPT = 'はい、少し確認しますね。'/);
  assert.match(bridge, /warmImmediateAckAudio/);
  assert.match(bridge, /immediate-ack=/);
  assert.doesNotMatch(
    bridge.slice(bridge.indexOf('async function processConfirmedTranscript'), bridge.indexOf('async function handleCapturedUtterance')),
    /activeWaitCue = startWaitCue\(confirmedTranscript[\s\S]*?(?!if \(!timeline\.immediateAckRequestedAt\))/,
  );
});

test('post-STT wait cue is skipped when the immediate acknowledgement was already requested', () => {
  assert.match(bridge, /if \(!timeline\.immediateAckRequestedAt\) \{[\s\S]*activeWaitCue = startWaitCue/);
  assert.match(bridge, /activeImmediateAck\?\.stop\?\.\('final-answer-ready'\)/);
  assert.match(bridge, /activeImmediateAck\?\.stop\?\.\(reason\)/);
});

test('renewed user speech cancels an acknowledgement even while TTS is still pending', () => {
  assert.match(bridge, /if \(!answering && !activeImmediateAck && player\.state\.status !== AudioPlayerStatus\.Playing\) return false/);
  assert.match(bridge, /activeImmediateAck\?\.stop\?\.\(reason\)/);
});

test('confirmed Whisper transcript is filtered only when it matches overlapping recent bot speech', () => {
  assert.match(bridge, /import \{ sameUtterance \} from '\.\.\/\.\.\/src\/voice-fast-reaction\.js'/);
  assert.match(bridge, /function looksLikeRecentBotEcho/);
  assert.match(bridge, /overlaps && sameUtterance\(value, record\.text\)/);
  assert.match(bridge, /\[echo-guard\] suppressed bot echo/);
  const guard = bridge.indexOf('const echoRecord = looksLikeRecentBotEcho(stt.confirmedTranscript, timeline);');
  const turn = bridge.indexOf('await processConfirmedTranscript({', guard);
  assert.ok(guard >= 0 && turn > guard);
});

test('recovery prompt cannot start over a newer user utterance', () => {
  assert.match(bridge, /lastUserSpeechAt > failedUtteranceEndAt \|\| lastUserPcmAt > failedUtteranceEndAt/);
  assert.match(bridge, /\[recovery\] suppressed because a new user utterance started/);
  assert.match(bridge, /speakRecoveryPrompt\('stt-failed', sessionEpoch, timeline\.utteranceEndAt \|\| 0\)/);
});

test('Cloudflare telemetry accepts immediate acknowledgement and echo suppression fields', () => {
  assert.match(integrated, /'immediateAckMs'/);
  assert.match(integrated, /typeof value\?\.echoSuppressed === 'boolean'/);
  assert.match(integrated, /'immediateAckRequestedAt'/);
  assert.match(integrated, /'immediateAckPlaybackAt'/);
  assert.match(integrated, /echoSuppressed: Boolean\(timings\.echoSuppressed\)/);
});

test('v81 preserves authoritative Whisper and common turn architecture', () => {
  assert.match(bridge, /talksys-discord-bridge-v81-fast-ack-echo-guard-r1/);
  assert.match(integrated, /talksys-v81-fast-ack-echo-guard-r1/);
  assert.match(bridge, /TALKSYS_BASE_URL \+ '\/api\/transcribe'/);
  assert.match(bridge, /TALKSYS_BASE_URL \+ '\/api\/turn'/);
  assert.doesNotMatch(bridge, /\/api\/realtime-stt|WebSocket|speech_final|batchTranscribePcm16/);
});

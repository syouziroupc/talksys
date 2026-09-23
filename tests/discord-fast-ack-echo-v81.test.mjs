import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const bridge = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');
const integrated = fs.readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');

test('Discord uses the same Web fast-reaction decision path', () => {
  assert.match(bridge, /import \{ fastReaction, sameUtterance \} from '\.\.\/\.\.\/src\/voice-fast-reaction\.js'/);
  assert.match(bridge, /\/api\/realtime-stt/);
  assert.match(bridge, /\/api\/fast-reaction/);
  assert.match(bridge, /setTimeout\(async \(\) => \{[\s\S]*fetchFastReaction\(value\)[\s\S]*\}, 90\)/);
  assert.match(bridge, /handleRealtimeMessage/);
  assert.match(bridge, /payload\?\.speech_final/);
  assert.doesNotMatch(bridge, /const IMMEDIATE_ACK_PROMPT|startImmediateAck|warmImmediateAckAudio/);
});

test('Nova realtime text is reaction-only and Whisper remains authoritative', () => {
  assert.match(bridge, /triggerWebFastReaction/);
  assert.match(bridge, /confirmedTranscript = String\(body\.text\)\.trim\(\)/);
  assert.match(bridge, /const turn = await talk\(confirmedTranscript, utteranceId, controller\.signal\)/);
  assert.match(bridge, /geminiInputText: confirmedTranscript/);
  assert.doesNotMatch(bridge, /talk\((?:value|transcript|realtimeTranscript|helper\.interim)/);
  assert.doesNotMatch(bridge, /processConfirmedTranscript\(\{[\s\S]{0,300}(?:realtimeTranscript|helper\.interim|latestRealtimeTranscript)/);
});

test('Discord fast reaction audio is prewarmed from the shared fastReaction function', () => {
  assert.match(bridge, /async function warmFastReactionAudio/);
  assert.match(bridge, /samples\.map\(\(sample\) => fastReaction\(sample\)\)/);
  assert.match(bridge, /fastReactionAudioCache/);
  assert.match(bridge, /warmFastReactionAudio\(\)\.catch/);
});

test('speech overlapping bot playback cannot create reaction echo loops', () => {
  assert.match(bridge, /startedDuringBotPlayback/);
  assert.match(bridge, /if \(active\.startedDuringBotPlayback\)[\s\S]*deferred bot-overlap/);
  assert.match(bridge, /looksLikeRecentBotEcho/);
  assert.match(bridge, /overlaps && sameUtterance\(value, record\.text\)/);
});

test('recovery prompt cannot start over a newer user utterance', () => {
  assert.match(bridge, /lastUserSpeechAt > failedUtteranceEndAt \|\| lastUserPcmAt > failedUtteranceEndAt/);
  assert.match(bridge, /\[recovery\] suppressed because a new user utterance started/);
});

test('Discord exposes a live runtime log in the text channel', () => {
  assert.match(bridge, /function attachRuntimeLogChannel/);
  assert.match(bridge, /function mirrorRuntimeLog/);
  assert.match(bridge, /runtimeLogMessage\.edit/);
  assert.match(bridge, /name: 'logs'/);
  assert.match(bridge, /await attachRuntimeLogChannel\(interaction\.channel\)/);
  assert.match(bridge, /TalkSys Discord runtime/);
});

test('Cloudflare telemetry accepts fast-reaction timing and transcript provenance', () => {
  assert.match(integrated, /'fastReactionMs'/);
  assert.match(integrated, /'fastReactionRequestedAt'/);
  assert.match(integrated, /'fastReactionPlaybackAt'/);
  assert.match(integrated, /discordRealtimeSttRole: 'fast-reaction-only'/);
  assert.match(integrated, /discordFastReactionEndpoint: '\/api\/fast-reaction'/);
  assert.match(integrated, /discordRuntimeLogCommand: '\/logs'/);
});

test('v83 preserves authoritative Whisper and common turn architecture', () => {
  assert.match(bridge, /talksys-discord-bridge-v83-stable-turn-gating-r1/);
  assert.match(integrated, /talksys-v82-web-fast-reaction-live-log-r1/);
  assert.match(bridge, /TALKSYS_BASE_URL \+ '\/api\/transcribe'/);
  assert.match(bridge, /TALKSYS_BASE_URL \+ '\/api\/turn'/);
  assert.doesNotMatch(bridge, /\/api\/turn-stream|batchTranscribePcm16|type:\s*['"]Finalize['"]/);
});


test('v83 does not abort answer generation on every Discord speaking-start', () => {
  assert.match(bridge, /const botAudiblySpeaking = Boolean\(activeBotPlaybackRecord\) \|\| player\.state\.status === AudioPlayerStatus\.Playing/);
  assert.match(bridge, /if \(botAudiblySpeaking\) \{\s*interruptActiveAnswer\('user-barge-in'\)/);
  assert.doesNotMatch(bridge, /receiver\.speaking\.on\('start',[\s\S]{0,500}interruptActiveAnswer\('user-speech'\)/);
  assert.match(bridge, /lastUserSpeechAt > \(timeline\.utteranceEndAt \|\| 0\)/);
  assert.match(bridge, /stale answer suppressed/);
});

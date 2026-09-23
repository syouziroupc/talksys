import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const integrated = readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');

test('v84 common Gemini path is single-pass grounded without serial verification', () => {
  assert.match(integrated, /export async function commonTalkSysTurn/);
  assert.match(integrated, /return runGeminiTurn\(body, env, signal, options\)/);
  assert.match(integrated, /shouldRunGenericVerification\(_text = '', _payload = \{\}\)/);
  assert.match(integrated, /return false/);
  assert.match(integrated, /reason: 'v84-single-pass-grounded'/);
  assert.doesNotMatch(integrated, /if \(shouldRunGenericVerification\(text, interaction\.payload\)\)/);
});

test('Discord confirmed Whisper is the only text allowed into common TalkSys', () => {
  assert.match(bridge, /confirmedTranscript = String\(body\.text\)\.trim\(\)/);
  assert.match(bridge, /const turn = await talk\(confirmedTranscript, utteranceId, controller\.signal\)/);
  assert.match(bridge, /geminiInputText: confirmedTranscript/);
  assert.match(bridge, /\/api\/realtime-stt/);
  assert.match(bridge, /\/api\/fast-reaction/);
  assert.doesNotMatch(bridge, /type:\s*['"]Finalize['"]/);
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
    'captureMs','sttMs','speechEndToSttFinalMs','fastReactionMs','primaryMs','verifierMs',
    'answerGenerationTotalMs','firstTtsMs','firstAudioReadyMs',
    'ffmpegSpawnMs','speechEndToPlaybackStartMs','pipelineCompleteMs',
  ]) assert.match(bridge + integrated, new RegExp(key));
});


test('v84 factual grounding fails closed when Gemini returns no URL citations', () => {
  assert.match(integrated, /export function interactionCitationCount/);
  assert.match(integrated, /export function requiresGroundedEvidence/);
  assert.match(integrated, /const groundingFailClosed = groundingRequired && citationCount === 0/);
  assert.match(integrated, /未確認の固有事実や数値は断定しません/);
});

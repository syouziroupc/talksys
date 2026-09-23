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
  assert.match(integrated, /const groundingFailClosed = groundingRequired && !groundingSearchPerformed/);
  assert.match(integrated, /推測では答えず/);
});


test('v84 uses Cloudflare MeloTTS only on the Discord voice endpoint', () => {
  assert.match(integrated, /ttsProvider: 'cloudflare-melotts'/);
  assert.match(integrated, /x-talksys-tts-model': '@cf\/myshell-ai\/melotts'/);
  const synthStart = integrated.indexOf('async function discordVoiceSynthesize');
  const healthStart = integrated.indexOf('async function voiceHealth', synthStart);
  const endpoint = integrated.slice(synthStart, healthStart);
  assert.doesNotMatch(endpoint, /synthesizeGeminiJapaneseTts|gemini-tts-fallback/);
});

test('v84 strict grounding specifically covers dynamic local facts', () => {
  assert.match(integrated, /STRICT_DYNAMIC_GROUNDING_RE/);
  assert.match(integrated, /住所\|所在地\|場所/);
  assert.match(integrated, /営業時間/);
  assert.match(integrated, /価格/);
  assert.match(integrated, /在庫/);
  assert.match(integrated, /何時/);
  assert.match(integrated, /交通/);
  assert.match(integrated, /groundingSourceCount/);
});

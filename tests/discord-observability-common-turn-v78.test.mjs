import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const integrated = fs.readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');
const bridge = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('Workers logs, traces, and Analytics Engine latency dataset are enabled at full development sampling', () => {
  assert.match(wrangler, /"logs": \{ "enabled": true, "head_sampling_rate": 1 \}/);
  assert.match(wrangler, /"traces": \{ "enabled": true, "head_sampling_rate": 1 \}/);
  assert.match(wrangler, /"binding": "TALKSYS_LATENCY"/);
  assert.match(wrangler, /"dataset": "talksys_latency"/);
});

test('web and Discord final answers use the same common TalkSys turn function', () => {
  assert.match(integrated, /export async function commonTalkSysTurn/);
  assert.match(integrated, /const result = await commonTalkSysTurn\(commonBody, env, signal\)/);
  assert.match(integrated, /discordTurnStreamResponse[\s\S]*runTalkSysTurn\(request, env, commonBody, request\.signal, ctx\)/);
  assert.doesNotMatch(integrated, /type: 'speculative'/);
  assert.doesNotMatch(bridge, /onSpeculative|speculativeText|speculativeAudioPromise/);
});

test('utterance telemetry contains requested cross-channel latency dimensions', () => {
  for (const field of [
    'utteranceId',
    'sessionId',
    'channel',
    'speechEndToSttFinalMs',
    'batchSttMs',
    'answerStartMs',
    'primaryMs',
    'verifierMs',
    'answerGenerationTotalMs',
    'firstTtsMs',
    'firstAudioReadyMs',
    'speechEndToPlaybackStartMs',
    'pipelineCompleteMs',
    'ffmpegSpawnMs',
    'ttsProvider',
  ]) {
    assert.match(integrated + bridge, new RegExp(field));
  }
  assert.match(integrated, /writeDataPoint/);
  assert.match(integrated, /talksys-latency/);
  assert.match(integrated, /subrequest: 'Gemini interactions'/);
});

test('Nova speech_final bypasses the 1600ms Discord silence safety timer', () => {
  assert.match(bridge, /EndBehaviorType\.AfterSilence, duration: 1600/);
  assert.match(bridge, /if \(payload\?\.speech_final && text\)/);
  assert.match(bridge, /endInput\('speech-final'\)/);
  assert.match(bridge, /if \(reason === 'speech-final'\) \{\s*complete\('speech-final'\);/s);
  assert.doesNotMatch(bridge, /setTimeout\(\(\) => complete\('speech-final'\), 100\)/);
  assert.match(bridge, /if \(!text && pcm16\.length\)/);
});

test('Discord uses non-answer wait cues and first-sentence-priority TTS', () => {
  assert.match(bridge, /\/api\/search-preface/);
  assert.match(bridge, /\/api\/fast-reaction/);
  assert.match(bridge, /const waitCuePromise = playWaitCue/);
  assert.match(bridge, /firstSentenceReadyPromise = timedSynthesize\(safe\)/);
  assert.match(bridge, /Promise\.resolve\(firstSentenceReadyPromise\)[\s\S]*timedSynthesize\(safe\)/);
  assert.match(bridge, /ffmpeg-first-output=/);
});

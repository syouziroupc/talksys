import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PHONE_PROFILE_PRELOAD_REVISION } from '../src/telephony/index.js';

const telephony = await readFile(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
const integrated = await readFile(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');

test('v116a revision is explicit', () => {
  assert.match(PHONE_PROFILE_PRELOAD_REVISION, /v116a/);
});

test('profile preload reads once from the caller number and is background tracked', () => {
  assert.match(telephony, /async function loadCallerProfileForSession\(env, phoneNumber\)/);
  assert.match(telephony, /SELECT display_name, personalization_text, memory_text, enabled, version FROM phone_profiles WHERE phone_number=\?/);
  assert.match(telephony, /trackTask\(loadCallerProfileForSession\(env,profilePhoneAtStart\)\.then/);
  assert.doesNotMatch(telephony, /await\s+loadCallerProfileForSession\(/);
});

test('profile preload is session-local and observable without logging profile contents', () => {
  assert.match(telephony, /callerProfileSession=\{status:'idle',phoneNumber:'',profile:null\}/);
  assert.match(telephony, /'profile_load_start'/);
  assert.match(telephony, /'profile_load_end'/);
  assert.match(telephony, /'profile_load_error'/);
  const preloadLog = telephony.match(/console\.log\(JSON\.stringify\(\{type:'phone_profile_preload'[\s\S]*?\}\)\);/u)?.[0] || '';
  assert.ok(preloadLog);
  assert.doesNotMatch(preloadLog, /displayName|personalizationText|memoryText/);
});

test('v116a does not send caller profile to TalkSys/Gemini', () => {
  const answerStart = telephony.indexOf('async function answerWithTalkSys');
  const answerEnd = telephony.indexOf('async function warmFastAckAudio', answerStart);
  const answerBlock = telephony.slice(answerStart, answerEnd);
  assert.ok(answerStart >= 0 && answerEnd > answerStart);
  assert.doesNotMatch(answerBlock, /callerProfile|caller_profile|personalizationText|memoryText|displayName/);
  assert.doesNotMatch(integrated, /callerProfileInstruction|CALLER_PROFILE_CONTEXT_REVISION/);
});

test('v116a leaves the existing answer function signature intact', () => {
  assert.match(telephony, /async function answerWithTalkSys\(deps, text, history, signal, spokenBackchannel = '', sessionId = '', utteranceId = ''\)/);
});

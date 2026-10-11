import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PHONE_PROFILE_PRELOAD_REVISION } from '../src/telephony/index.js';

const telephony = await readFile(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
const integrated = await readFile(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');

test('v116a revision remains explicit', () => {
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

test('v118 sends only sanitized preloaded profile text into TalkSys', () => {
  const answerStart = telephony.indexOf('async function answerWithTalkSys');
  const answerEnd = telephony.indexOf('async function warmFastAckAudio', answerStart);
  const answerBlock = telephony.slice(answerStart, answerEnd);
  assert.ok(answerStart >= 0 && answerEnd > answerStart);
  assert.match(answerBlock, /callerProfile = null/);
  assert.match(answerBlock, /displayName: clean\(callerProfile\?\.displayName \|\| '', 80\)/);
  assert.match(answerBlock, /personalizationText: clean\(callerProfile\?\.personalizationText \|\| '', 4000\)/);
  assert.match(answerBlock, /memoryText: clean\(callerProfile\?\.memoryText \|\| '', 8000\)/);
  assert.match(answerBlock, /\.\.\.\(phoneProfile \? \{ phoneProfile \} : \{\}\)/);
  assert.match(integrated, /function phoneProfileContext\(body = \{\}\)/);
});

test('v118 profile usage remains outside the audio pipeline', () => {
  assert.match(telephony, /callerProfileSession\.status==='ready'\?callerProfileSession\.profile:null/);
  assert.match(telephony, /const turnPromise=answerWithTalkSys/);
  assert.doesNotMatch(telephony, /await\s+loadCallerProfileForSession\(/);
  const mediaStart = telephony.indexOf("if(message?.event==='media'");
  const finish = telephony.indexOf('const finishUtterance');
  const audioRegion = telephony.slice(finish, mediaStart);
  assert.doesNotMatch(audioRegion, /await\s+loadCallerProfileForSession/);
});

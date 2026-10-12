import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PHONE_PROFILE_REVISION, isTelephonyPath } from '../src/telephony/index.js';

test('v115 exposes profile revision and route without changing media routes', () => {
  assert.match(PHONE_PROFILE_REVISION, /v115/);
  assert.equal(isTelephonyPath('/phone/api/profiles/%2B819012345678'), true);
  assert.equal(isTelephonyPath('/telnyx/media'), true);
  assert.equal(isTelephonyPath('/telnyx/voice'), true);
});

test('profile storage is separate from call and message tables', async () => {
  const source = await readFile(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
  assert.match(source, /CREATE TABLE IF NOT EXISTS phone_profiles/);
  assert.match(source, /phone_number TEXT PRIMARY KEY/);
  assert.match(source, /personalization_text TEXT NOT NULL DEFAULT ''/);
  assert.match(source, /memory_text TEXT NOT NULL DEFAULT ''/);
  assert.match(source, /version INTEGER NOT NULL DEFAULT 1/);
});

test('profile API remains behind admin authorization and supports conflict detection', async () => {
  const source = await readFile(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
  const getStart = source.indexOf('async function phoneProfileGet');
  const putStart = source.indexOf('async function phoneProfilePut');
  assert.ok(getStart > 0 && putStart > getStart);
  assert.match(source.slice(getStart, putStart), /adminAuthorized\(request, env\)/);
  assert.match(source.slice(putStart, source.indexOf('async function listCalls')), /adminAuthorized\(request, env\)/);
  assert.match(source, /version_conflict/);
  assert.match(source, /display_name_too_long/);
  assert.match(source, /personalization_text_too_long/);
  assert.match(source, /memory_text_too_long/);
});

test('profile storage is not queried synchronously inside the live TalkSys turn', async () => {
  const source = await readFile(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
  const finishStart = source.indexOf('const finishUtterance=()=>');
  const deadline = source.indexOf('const deadline=', finishStart);
  const runtime = source.slice(finishStart, deadline);
  assert.doesNotMatch(runtime, /personalization_text|memory_text|phoneProfileGet|phone_profiles/);
});

test('admin UI edits profile using safe value/textContent paths', async () => {
  const source = await readFile(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
  assert.match(source, /id="profilePersonalization"/);
  assert.match(source, /id="profileMemory"/);
  assert.match(source, /profilePhone'\)\.textContent/);
  assert.match(source, /profileName'\)\.value/);
  assert.match(source, /method:'PUT'/);
});

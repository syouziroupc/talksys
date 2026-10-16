import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  V130_FLAG_VALUES,
  handleV130ControlPlane,
  isV130ControlPlanePath,
  readV130Flag,
} from '../src/v130-control-plane.js';

const protectedCoreBlobs = Object.freeze({
  '../src/stt-v45.js': '5dd18cb20c70b354aaeaf4bb9590e05e0b34496d',
  '../src/telephony/phone-tts.js': 'ea3f923b9d305f6485f8240d13db3f7945cb5c03',
  '../src/telephony/phone-noise-suppressor.js': 'aecd45edad3c130c45d61789ac3995bc54fc03c1',
  '../src/telephony/codec.js': 'e16846af3ff4de269427618968778d5177b55a0c',
  '../src/voice-fast-reaction.js': 'fddfbca99e50af7a8e22cbd163ad64fc0fcaa55d',
});

function gitBlobSha(content) {
  const bytes = Buffer.from(content);
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

test('V130 feature flags have fail-closed mode sets', () => {
  assert.deepEqual([...V130_FLAG_VALUES.memory_jobs], ['off', 'shadow', 'active']);
  assert.deepEqual([...V130_FLAG_VALUES.onboarding], ['off', 'allowlist', 'all']);
  for (const values of Object.values(V130_FLAG_VALUES)) assert.equal(values.has('off'), true);
});

test('V130 feature flag read fails closed when storage is unavailable', async () => {
  assert.equal(await readV130Flag({}, 'memory_jobs'), 'off');
  assert.equal(await readV130Flag({ TALKSYS_LOG_DB: null }, 'structured_profile'), 'off');
  assert.equal(await readV130Flag({}, 'not-a-real-flag'), 'off');
});

test('V130 control-plane paths are isolated from live telephony routes', () => {
  assert.equal(isV130ControlPlanePath('/phone/api/v130/flags'), true);
  assert.equal(isV130ControlPlanePath('/phone/api/v130/profiles/%2B819012345678'), true);
  assert.equal(isV130ControlPlanePath('/phone/api/v130/trash/calls/abc/trash'), true);
  assert.equal(isV130ControlPlanePath('/phone/api/v130/trash/users/%2B819012345678/purge'), true);
  assert.equal(isV130ControlPlanePath('/phone'), false);
  assert.equal(isV130ControlPlanePath('/phone/stream'), false);
  assert.equal(isV130ControlPlanePath('/api/transcribe'), false);
  assert.equal(isV130ControlPlanePath('/api/turn'), false);
});

test('V130 management API rejects missing admin authorization before storage access', async () => {
  const response = await handleV130ControlPlane(new Request('https://example.test/phone/api/v130/flags'), {});
  assert.equal(response.status, 401);
  const payload = await response.json();
  assert.equal(payload.error, 'unauthorized');
});

test('V130 migration is expand-only and initializes all flags OFF', async () => {
  const sql = await readFile(new URL('../migrations/0001_v130_expand.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(sql, /\bDROP\s+(?:TABLE|COLUMN)\b/i);
  assert.doesNotMatch(sql, /\bRENAME\s+(?:TABLE|COLUMN|TO)\b/i);
  assert.match(sql, /ALTER TABLE phone_calls ADD COLUMN lifecycle_state/i);
  assert.match(sql, /ALTER TABLE phone_profiles ADD COLUMN speech_rate/i);
  for (const flag of ['log_management', 'structured_profile', 'memory_jobs', 'onboarding', 'trash_delete', 'hard_delete']) {
    assert.match(sql, new RegExp(`\\('${flag}', 'off'`));
  }
  assert.match(sql, /phone_user_trash/);
  assert.match(sql, /phone_memory_jobs/);
  assert.match(sql, /phone_onboarding_state/);
});

test('V130 protected audio and reaction modules remain byte-identical to the V129 baseline', async () => {
  for (const [path, expectedSha] of Object.entries(protectedCoreBlobs)) {
    const content = await readFile(new URL(path, import.meta.url));
    assert.equal(gitBlobSha(content), expectedSha, `${path} changed during V130`);
  }
});

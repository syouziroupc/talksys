import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldPersistPhoneLatencyEvent, PHONE_D1_WRITE_POLICY_REVISION } from '../src/telephony/phone-d1-write-policy.js';

const example = { callId: 'call-1', turnId: 'call-1-utterance-1', stage: 'answer_audio_ready', elapsedMs: 200 };

test('default and unexpected policy values retain every original D1 event', () => {
  assert.match(PHONE_D1_WRITE_POLICY_REVISION, /v131/);
  assert.equal(shouldPersistPhoneLatencyEvent({}, example), true);
  assert.equal(shouldPersistPhoneLatencyEvent({ PHONE_D1_LATENCY_POLICY: 'full' }, example), true);
  assert.equal(shouldPersistPhoneLatencyEvent({ PHONE_D1_LATENCY_POLICY: 'garbage' }, example), true);
  assert.equal(shouldPersistPhoneLatencyEvent({ PHONE_D1_LATENCY_POLICY: 'compact' }, { stage: 'answer_audio_ready' }), true);
});

test('critical error, usage, latency and initial greeting data are never sampled out', () => {
  const config = { PHONE_D1_LATENCY_POLICY: 'compact', PHONE_D1_LATENCY_SAMPLE_ONE_IN: '100' };
  for (const stage of [
    'runtime_revision', 'profile_load_end', 'input_calibration', 'noise_suppression_summary',
    'speech_end_estimate', 'stt_end', 'turn_start', 'answer_ready',
    'api_usage', 'tts_usage', 'ack_cache_miss', 'ack_slow_stt_armed',
    'duplicate_suppressed', 'progress_skipped', 'stt_rejected', 'turn_error',
    'tts_error', 'greeting_prepared', 'answer_first_pcmu', 'ack_first_pcmu',
  ]) {
    assert.equal(shouldPersistPhoneLatencyEvent(config, { ...example, stage }), true, stage);
  }
  assert.equal(shouldPersistPhoneLatencyEvent(config, { ...example, detail: { error: 'timeout' } }), true);
  assert.equal(shouldPersistPhoneLatencyEvent(config, { ...example, detail: { ok: false } }), true);
  assert.equal(shouldPersistPhoneLatencyEvent(config, { ...example, elapsedMs: 5000 }), true);
});

test('routine healthy stages are deterministically sampled per whole turn', () => {
  const config = { PHONE_D1_LATENCY_POLICY: 'compact', PHONE_D1_LATENCY_SAMPLE_ONE_IN: '10' };
  const stages = ['answer_tts_start', 'answer_audio_ready', 'answer_complete', 'vad_finalize', 'stt_start'];
  let keep = 0, omit = 0;
  for (let i = 0; i < 400; i++) {
    const turnId = 'call-' + i;
    const outcome = stages.map((stage) => shouldPersistPhoneLatencyEvent(config, { ...example, turnId, stage }));
    assert.equal(new Set(outcome).size, 1, 'all normal stages of one turn share sampling decision');
    if (outcome[0]) keep++; else omit++;
  }
  assert.ok(keep > 0 && omit > 0);
  assert.equal(shouldPersistPhoneLatencyEvent(config, example), shouldPersistPhoneLatencyEvent(config, example));
});

test('sampling can be disabled without changing event contents', () => {
  const config = { PHONE_D1_LATENCY_POLICY: 'compact', PHONE_D1_LATENCY_SAMPLE_ONE_IN: '1' };
  assert.equal(shouldPersistPhoneLatencyEvent(config, example), true);
  assert.equal(shouldPersistPhoneLatencyEvent(config, { ...example, stage: 'vad_finalize' }), true);
  assert.equal(shouldPersistPhoneLatencyEvent({ ...config, PHONE_D1_LATENCY_SAMPLE_ONE_IN: '-1' }, example), shouldPersistPhoneLatencyEvent({ PHONE_D1_LATENCY_POLICY: 'compact' }, example));
});

test('the guard does not mutate events, env, or audio configuration', () => {
  const env = Object.freeze({ PHONE_D1_LATENCY_POLICY: 'compact', PHONE_D1_LATENCY_SAMPLE_ONE_IN: '10', TELEPHONY_VAD_RMS: '0.0045' });
  const event = Object.freeze({ ...example, detail: Object.freeze({ purpose: 'answer' }) });
  shouldPersistPhoneLatencyEvent(env, event);
  assert.equal(env.TELEPHONY_VAD_RMS, '0.0045');
  assert.deepEqual(event.detail, { purpose: 'answer' });
});

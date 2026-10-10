import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');

test('phone latency v90 persists per-turn stage telemetry and exposes it in the admin UI', () => {
  assert.match(source, /phone_latency_events/);
  assert.match(source, /appendLatencyEvent/);
  assert.match(source, /speech_end_estimate/);
  assert.match(source, /stt_start/);
  assert.match(source, /stt_end/);
  assert.match(source, /turn_start/);
  assert.match(source, /answer_ready/);
  assert.match(source, /answer_first_pcmu/);
  assert.match(source, /pending_stt_wait_start/);
  assert.match(source, /pending_stt_wait_end/);
  assert.match(source, /\/latency/);
  assert.match(source, /遅延タイムライン/);
});

test('phone latency v90 uses a prewarmed PCMU receipt acknowledgement only after confirmed STT', () => {
  assert.match(source, /const\s+FAST_ACK_TEXT\s*=\s*'はい、少々お待ちください。'/);
  assert.match(source, /warmFastAckAudio/);
  assert.match(source, /fastAckAudioCache/);
  assert.match(source, /ack_cache_hit/);
  assert.match(source, /ack_cache_miss/);
  const sttEnd = source.search(/queueLatency\(turnId,\s*'stt_end'/);
  const ackHit = source.search(/queueLatency\(turnId,\s*'ack_cache_hit'/);
  assert.ok(sttEnd >= 0 && ackHit > sttEnd, 'receipt ack must only occur after successful STT');
});

test('phone latency v90 correlates phone turns with the shared TalkSys latency logger', () => {
  assert.match(source, /utteranceId:\s*clean\(utteranceId,\s*200\)/);
  assert.match(source, /answerWithTalkSys\(deps,\s*stt\.text,\s*history,\s*controller\.signal,\s*spokenBackchannel,\s*callId,\s*turnId\)/);
});

test('phone latency v90 preserves the proven PCMU Telnyx transport and answer quality path', () => {
  assert.match(source, /talksys-telephony-v87-grok-pcmu-paced/);
  assert.match(source, /streamPcmu20ms\(audio\.bytes/);
  assert.match(source, /synthesizePhonePcmu\(env,\s*spoken,\s*deps\)/);
  assert.match(source, /channel:\s*'phone'/);
  assert.doesNotMatch(source, /gemini-3\.8-live/i);
  assert.doesNotMatch(source, /bidirectionalMode="mp3"/);
});

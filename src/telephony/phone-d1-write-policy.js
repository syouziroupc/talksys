// Optional D1 telemetry compaction. This policy never changes speech, response,
// TTS, message history, call status, or in-process console observability.
export const PHONE_D1_WRITE_POLICY_REVISION = 'talksys-phone-d1-write-policy-v131-r1';

const ALWAYS_PERSIST = new Set([
  'runtime_revision',
  'profile_load_end',
  'profile_load_error',
  'input_calibration',
  'noise_suppression_summary',
  'speech_end_estimate',
  'stt_end',
  'turn_start',
  'answer_ready',
  'api_usage',
  'tts_usage',
  'ack_cache_miss',
  'ack_slow_stt_armed',
  'ack_slow_stt_unprepared',
  'ack_slow_stt_committed',
  'duplicate_suppressed',
  'progress_skipped',
]);
const FAILURE_STAGE = /(?:error|fail|rejected|timeout|abort|cancel)/i;
const FIRST_AUDIO_STAGE = /_first_pcmu$/;
const GREETING_STAGE = /^greeting_/;
const DEFAULT_SAMPLE_ONE_IN = 10;
const DEFAULT_SLOW_MS = 5000;

function integerSetting(value, fallback, maximum) {
  if (value === null || value === undefined || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && Number.isInteger(n) && n >= 1
    ? Math.min(maximum, n)
    : fallback;
}

function stableHash(value) {
  // FNV-1a 32-bit: a deterministic selection for the complete lifetime of a turn.
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// The default remains full fidelity. Only an explicit 'compact' enables omission.
// A compact turn still retains all critical checkpoints, failures and slow stages.
// Routine details are stored for 1/N entire turns; console logs remain unchanged.
export function shouldPersistPhoneLatencyEvent(env = {}, event = {}) {
  if (String(env?.PHONE_D1_LATENCY_POLICY || '').trim().toLowerCase() !== 'compact') return true;
  const stage = String(event?.stage || '').trim();
  const turnId = String(event?.turnId || '').trim();
  if (!stage || !turnId) return true;
  if (ALWAYS_PERSIST.has(stage) || FAILURE_STAGE.test(stage) || FIRST_AUDIO_STAGE.test(stage) || GREETING_STAGE.test(stage)) return true;
  if (event?.detail && typeof event.detail === 'object'
    && (event.detail.error || event.detail.failed || event.detail.ok === false)) return true;

  const slowMs = integerSetting(env?.PHONE_D1_LATENCY_SLOW_MS, DEFAULT_SLOW_MS, 600000);
  const elapsed = Number(event?.elapsedMs);
  if (Number.isFinite(elapsed) && elapsed >= slowMs) return true;

  const sampleOneIn = integerSetting(env?.PHONE_D1_LATENCY_SAMPLE_ONE_IN, DEFAULT_SAMPLE_ONE_IN, 100);
  return sampleOneIn === 1 || stableHash(turnId) % sampleOneIn === 0;
}

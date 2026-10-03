import { sameUtterance } from './voice-fast-reaction.js';

export const VOICE_TRANSCRIPT_ARBITER_REVISION = 'talksys-r6-transcript-arbiter-v1';

function clean(value = '') {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function compactToken(value = '') {
  return clean(value).toLowerCase().replace(/[\s。、，,.！？!?「」『』（）()・ー~〜_-]/g, '');
}

function realtimeConfidence(captureMetrics = {}) {
  const direct = Number(captureMetrics?.realtimeConfidence);
  if (Number.isFinite(direct)) return Math.max(0, Math.min(1, direct));
  const words = Array.isArray(captureMetrics?.realtimeWords) ? captureMetrics.realtimeWords : [];
  const values = words.map((item) => Number(item?.confidence)).filter(Number.isFinite);
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function classifySttFailure(error = '') {
  const value = clean(error).toLowerCase();
  if (!value) return 'unknown';
  if (/hallucinated transcript|hallucination-guard/.test(value)) return 'hallucination';
  if (/no speech detected|empty-transcript|stt_empty_transcript|captured_pcm_empty/.test(value)) return 'no-speech';
  if (/weak-speech-signal|weak speech/.test(value)) return 'weak-speech';
  if (/timeout|timeouterror|timed out/.test(value)) return 'timeout';
  return 'other';
}

export function realtimeBelongsToUtterance(captureMetrics = {}, timeline = {}) {
  const speechStartedAt = Number(captureMetrics?.realtimeSpeechStartedAt || 0);
  if (!speechStartedAt) return false;
  const firstPcmAt = Number(timeline?.firstPcmAt || 0);
  if (!firstPcmAt) return true;
  return speechStartedAt >= firstPcmAt - 300;
}

function realtimeStrongEnough(captureMetrics = {}) {
  const confidence = realtimeConfidence(captureMetrics);
  return confidence !== null && confidence >= 0.82;
}

export function arbitrateSuccessfulTranscript({ whisperText = '', captureMetrics = {}, timeline = {} } = {}) {
  const whisper = clean(whisperText);
  const realtime = clean(captureMetrics?.realtimeTranscript || '');
  if (!whisper) return { action: 'drop', text: '', reason: 'whisper-empty' };
  if (!realtime || !realtimeBelongsToUtterance(captureMetrics, timeline)) {
    return { action: 'accept-whisper', text: whisper, reason: 'no-current-realtime' };
  }

  const whisperToken = compactToken(whisper);
  const realtimeToken = compactToken(realtime);
  const strongRealtime = realtimeStrongEnough(captureMetrics);

  // Whisper sometimes returns only the tail of a longer utterance (for example
  // 「時間は」 while Nova has 「フィリピンの今の時間は」). Do not let that
  // fragment become an authoritative turn when the current realtime transcript
  // is strongly supported.
  const obviousWhisperFragment = whisperToken.length <= 4
    && realtimeToken.length >= Math.max(6, whisperToken.length + 4);
  if (obviousWhisperFragment && strongRealtime) {
    return { action: 'accept-realtime', text: realtime, reason: 'whisper-short-fragment' };
  }

  if (sameUtterance(whisper, realtime)) {
    return { action: 'accept-whisper', text: whisper, reason: 'transcripts-agree' };
  }

  // If two substantial transcripts disagree and Nova has strong current-utterance
  // evidence, neither side is safe enough to silently guess. Drop the turn and
  // ask for a repeat instead of turning a recognition error into conversation state.
  if (strongRealtime && whisperToken.length >= 5 && realtimeToken.length >= 6) {
    return { action: 'drop', text: '', reason: 'high-confidence-transcript-conflict' };
  }

  return { action: 'accept-whisper', text: whisper, reason: 'whisper-default' };
}

export function rescueFailedWhisper({ error = '', captureMetrics = {}, timeline = {} } = {}) {
  const failure = classifySttFailure(error);
  const realtime = clean(captureMetrics?.realtimeTranscript || '');
  const current = realtimeBelongsToUtterance(captureMetrics, timeline);
  const strong = realtimeStrongEnough(captureMetrics);
  const token = compactToken(realtime);

  // Never promote Nova text after Whisper explicitly classified the audio as
  // no-speech or hallucination. This is the path that previously promoted
  // fragments such as 「？ 北」 into the conversation queue.
  if (failure === 'no-speech' || failure === 'hallucination') {
    return { action: 'drop', text: '', reason: `whisper-${failure}` };
  }

  // Rescue only failures where speech may genuinely exist but Whisper could not
  // finish, and only with strong evidence tied to this exact utterance.
  if ((failure === 'weak-speech' || failure === 'timeout') && current && strong && token.length >= 6) {
    return { action: 'accept-realtime', text: realtime, reason: `realtime-rescue-${failure}` };
  }

  return { action: 'drop', text: '', reason: `no-safe-rescue-${failure}` };
}

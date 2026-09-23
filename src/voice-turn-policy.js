export const VOICE_TURN_POLICY_REVISION = 'talksys-v84-unified-turn-policy-r1';

function clean(value, max = 1200) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, max);
}

const EXPLICIT_STOP_RE = /^(?:止めて|とめて|停止|中止|キャンセル|黙って|だまって|もういい|待って|まって)(?:ください|下さい|くれ|よ)?[。！!？?…\s]*$/i;
const ACK_ONLY_RE = /^(?:はい|うん|ううん|そう|そうそう|なるほど|了解|わかった|分かった|おっけー|オッケー|OK|ええ|ああ)[。！!？?…\s]*$/i;
const FILLER_ONLY_RE = /^(?:えー+と?|えっと|あの+|その+|うー+ん|んー+|えー|あー+|ん+|まあ|ほら)[。！!？?…\s]*$/i;
const LAUGHTER_ONLY_RE = /^(?:は+|ハ+|ふ+|フ+|笑+|w+|ｗ+)[ッっハはフふ笑wｗ\s。！!？?…]*$/i;
const KNOWN_STT_HALLUCINATION_RE = /^(?:ご視聴ありがとうございました|ご清聴ありがとうございました|字幕(?:をご覧いただき)?ありがとうございました)[。！!？?…\s]*$/i;

export function classifyVoiceTurn(text = '', { answerInFlight = false } = {}) {
  const value = clean(text);
  if (!value) return { action: 'drop', reason: 'empty', text: '' };
  if (EXPLICIT_STOP_RE.test(value)) return { action: 'interrupt', reason: 'explicit-stop', text: value };
  if (KNOWN_STT_HALLUCINATION_RE.test(value)) return { action: 'drop', reason: 'known-stt-hallucination', text: value };
  if (FILLER_ONLY_RE.test(value) || LAUGHTER_ONLY_RE.test(value)) {
    return { action: 'drop', reason: 'non-semantic', text: value };
  }
  if (answerInFlight && ACK_ONLY_RE.test(value)) {
    return { action: 'drop', reason: 'ack-during-answer', text: value };
  }
  return { action: 'answer', reason: 'meaningful', text: value };
}

export function isIgnorableSttFailure(error = '') {
  const value = clean(error, 1000);
  return /weak-speech-signal|no speech detected|stt_http_422|captured_pcm_empty/i.test(value);
}

export const FAST_REACTION_REVISION = 'talksys-v61-quality-buffer-r1';

function clean(value, max = 800) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, max);
}

const PURE_GREETING_RE = /^(?:もしもし|おはよう(?:ございます)?|こんにちは|こんばんは|やあ|どうも)[。！!？?…\s]*$/i;
const PURE_THANKS_RE = /^(?:ありがとう(?:ございます)?|ありがと|助かった|どうもありがとう)[。！!？?…\s]*$/i;
const FILLER_ONLY_RE = /^(?:えー+と?|えっと|あの+|その+|うー+ん|んー+|まあ|えー)[。！!？?…\s]*$/i;
const SEARCHISH_RE = /(?:検索|調べ|探して|見つけ|確認して|最新|現在|今日|明日|価格|値段|在庫|営業時間|時刻|電車|列車|運行|ニュース|天気|どこ|誰|いつ|何時|いくら|おすすめ|店|店舗|会社|製品|商品|型番|仕様|互換|対応)/i;
const REQUEST_RE = /(?:して|してほしい|教えて|お願い|頼む|考えて|見て|聞きたい|知りたい|相談|どうしたら|どうすれば)/i;
const QUESTION_RE = /[？?]|(?:ですか|ますか|なの|なのか|何|どれ|どっち|どう|なぜ|なんで|誰|どこ|いつ)$/i;
const LOOKUP_REACTIONS = Object.freeze([
  'はい、少し調べますね。',
  '関連情報を確認します。',
  '最新の情報を確認してみます。',
  '少し検索して確かめます。',
  '確認できる情報を調べています。',
]);

function stableVariantIndex(value = '', count = 1) {
  const text = clean(value, 800);
  let hash = 2166136261;
  for (const ch of text) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) % Math.max(1, count);
}


export function fastReaction(text = '') {
  const value = clean(text);
  if (!value || FILLER_ONLY_RE.test(value)) {
    return { kind: 'none', text: '', shouldSpeak: false, terminal: false };
  }
  if (PURE_GREETING_RE.test(value)) {
    const reply = /^おはよう/i.test(value) ? 'おはようございます。'
      : /^こんばんは/i.test(value) ? 'こんばんは。'
      : /^もしもし/i.test(value) ? 'はい、フォーンズです。'
      : 'こんにちは。';
    return { kind: 'greeting', text: reply, shouldSpeak: true, terminal: false };
  }
  if (PURE_THANKS_RE.test(value)) {
    return { kind: 'thanks', text: 'どういたしまして。', shouldSpeak: true, terminal: false };
  }
  if (SEARCHISH_RE.test(value)) {
    const text = LOOKUP_REACTIONS[stableVariantIndex(value, LOOKUP_REACTIONS.length)];
    return { kind: 'lookup', text, shouldSpeak: true, terminal: false };
  }
  if (REQUEST_RE.test(value)) {
    return { kind: 'request', text: 'はい、内容を確認しますね。', shouldSpeak: true, terminal: false };
  }
  if (QUESTION_RE.test(value)) {
    return { kind: 'question', text: 'はい、確認してお答えしますね。', shouldSpeak: true, terminal: false };
  }
  if (value.length >= 18) {
    return { kind: 'listening', text: 'はい、内容を確認しています。', shouldSpeak: true, terminal: false };
  }
  return { kind: 'none', text: '', shouldSpeak: false, terminal: false };
}

export function sameUtterance(a = '', b = '') {
  const norm = (v) => clean(v, 1200).replace(/[、。！？!?・「」『』"'\s]/g, '').toLowerCase();
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const min = Math.min(x.length, y.length);
  let prefix = 0;
  while (prefix < min && x[prefix] === y[prefix]) prefix += 1;
  if (prefix / Math.max(1, min) >= 0.72) return true;
  const grams = (s) => {
    const out = new Set();
    if (s.length < 2) out.add(s);
    else for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
    return out;
  };
  const gx = grams(x), gy = grams(y);
  let overlap = 0;
  for (const g of gx) if (gy.has(g)) overlap += 1;
  const union = new Set([...gx, ...gy]).size;
  return union > 0 && overlap / union >= 0.62;
}


export const VOICE_TURN_POLICY_REVISION = 'talksys-v91-short-rescue-policy-r1';

const EXPLICIT_STOP_RE = /^(?:止めて|とめて|停止|中止|キャンセル|黙って|だまって|もういい|待って|まって)(?:ください|下さい|くれ|よ)?[。！!？?…\s]*$/i;
const ACK_ONLY_RE = /^(?:はい|うん|ううん|そう|そうそう|なるほど|了解|わかった|分かった|おっけー|オッケー|OK|ええ|ああ)[。！!？?…\s]*$/i;
const TURN_FILLER_ONLY_RE = /^(?:えー+と?|えっと|あの+|その+|うー+ん|んー+|えー|あー+|ん+|まあ|ほら)[。！!？?…\s]*$/i;
const LAUGHTER_ONLY_RE = /^(?:は+|ハ+|ふ+|フ+|笑+|w+|ｗ+)[ッっハはフふ笑wｗ\s。！!？?…]*$/i;
const KNOWN_STT_HALLUCINATION_RE = /^(?:ご視聴ありがとうございました|ご清聴ありがとうございました|最後までご視聴ありがとうございました|ご視聴いただきありがとうございました|チャンネル登録(?:を)?(?:お願い(?:します|いたします)|よろしくお願いします)|字幕(?:をご覧いただき)?ありがとうございました)[。！!？?…\s]*$/i;

export function classifyVoiceTurn(text = '', { answerInFlight = false } = {}) {
  const value = clean(text, 1200);
  if (!value) return { action: 'drop', reason: 'empty', text: '' };
  if (EXPLICIT_STOP_RE.test(value)) return { action: 'interrupt', reason: 'explicit-stop', text: value };
  if (KNOWN_STT_HALLUCINATION_RE.test(value)) return { action: 'drop', reason: 'known-stt-hallucination', text: value };
  if (TURN_FILLER_ONLY_RE.test(value) || LAUGHTER_ONLY_RE.test(value)) {
    return { action: 'drop', reason: 'non-semantic', text: value };
  }
  if (answerInFlight && ACK_ONLY_RE.test(value)) {
    return { action: 'drop', reason: 'ack-during-answer', text: value };
  }
  return { action: 'answer', reason: 'meaningful', text: value };
}

export function isIgnorableSttFailure(error = '') {
  const value = clean(error, 1000);
  return /weak-speech-signal|no speech detected|empty-transcript|stt_empty_transcript|stt_http_422|captured_pcm_empty/i.test(value);
}

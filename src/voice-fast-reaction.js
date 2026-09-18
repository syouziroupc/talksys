export const FAST_REACTION_REVISION = 'talksys-v59-fast-reaction-r1';

function clean(value, max = 800) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, max);
}

const PURE_GREETING_RE = /^(?:もしもし|おはよう(?:ございます)?|こんにちは|こんばんは|やあ|どうも)[。！!？?…\s]*$/i;
const PURE_THANKS_RE = /^(?:ありがとう(?:ございます)?|ありがと|助かった|どうもありがとう)[。！!？?…\s]*$/i;
const FILLER_ONLY_RE = /^(?:えー+と?|えっと|あの+|その+|うー+ん|んー+|まあ|えー)[。！!？?…\s]*$/i;
const SEARCHISH_RE = /(?:検索|調べ|探して|見つけ|確認して|最新|現在|今日|明日|価格|値段|在庫|営業時間|時刻|電車|列車|運行|ニュース|天気|どこ|誰|いつ|何時|いくら|おすすめ|店|店舗|会社|製品|商品|型番|仕様|互換|対応)/i;
const REQUEST_RE = /(?:して|してほしい|教えて|お願い|頼む|考えて|見て|聞きたい|知りたい|相談|どうしたら|どうすれば)/i;
const QUESTION_RE = /[？?]|(?:ですか|ますか|なの|なのか|何|どれ|どっち|どう|なぜ|なんで|誰|どこ|いつ)$/i;

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
    return { kind: 'lookup', text: 'はい、調べます。', shouldSpeak: true, terminal: false };
  }
  if (REQUEST_RE.test(value)) {
    return { kind: 'request', text: 'はい。', shouldSpeak: true, terminal: false };
  }
  if (QUESTION_RE.test(value)) {
    return { kind: 'question', text: 'はい。', shouldSpeak: true, terminal: false };
  }
  if (value.length >= 18) {
    return { kind: 'listening', text: 'はい、聞いています。', shouldSpeak: true, terminal: false };
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

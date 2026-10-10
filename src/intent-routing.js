export const INTENT_ROUTING_REVISION = 'talksys-intent-routing-v113-r1';

function compact(value, max = 4000) {
  return String(value ?? '').normalize('NFKC').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

const LEADING_SOCIAL_RE = /^(?:(?:もしもし|おはよう(?:ございます)?|こんにちは|こんばんは|やあ|どうも|すみません|ちょっと)[、,。.!！?？…\s]*)+/i;
const SOCIAL_ONLY_RE = /^(?:元気(?:ですか|です|か)?|お元気(?:ですか)?|調子(?:は)?どう(?:ですか)?|ありがとう(?:ございます|ございました)?|ありがと|なるほど|そうなんですね|そうですね|うん|はい|いいですね|何か(?:話|話題)(?:を)?(?:して|してください|提供して|ありますか)?|何か話しましょう|暇(?:ですね|です)?|雑談(?:しよう|しましょう|して)?)[。.!！?？…\s]*$/i;
const ASSISTANT_META_RE = /^(?:あなた|君|フォーンズ|TalkSys|トークシス).{0,30}(?:誰|何者|名前|どこに住|住んで|どこにいる|何歳|元気|調子|人間|AI|エーアイ|できること|何ができる)/i;
const UNSAFE_ACTION_RE = /(?:攻撃(?:を)?(?:仕掛け|したい|する|して)|ハッキング(?:したい|する|して)|不正アクセス|侵入(?:したい|する|して)|破壊(?:したい|する|して)|殺(?:したい|す|して)|傷つけ(?:たい|る)|爆破(?:したい|する)|脅迫(?:したい|する)|マルウェア|ランサムウェア)/i;
const PRIVILEGE_INTERNAL_RE = /(?:私は|俺は|わたしは|自分は)?.{0,20}(?:管理者|開発者|社長|責任者)(?:です|である|だから|なので)|(?:システム|内部|秘密|プロンプト|指示|設定|APIキー|トークン|パスワード).{0,30}(?:全部|すべて|全て|見せ|教え|開示|公開)|(?:秘密保持契約|NDA).{0,20}(?:教え|開示)|(?:命令に服従|管理者権限|権限を与え)/i;
const LEGAL_FOLLOWUP_RE = /^(?:(?:これ|それ|この件|その件)[、,\s]*)?(?:法律的|法的|違法|合法).{0,20}(?:大丈夫|問題|どう|ですか|なの)|^(?:これ|それ).{0,16}(?:法律|違法|合法)/i;
const SPECULATION_FOLLOWUP_RE = /(?:推測して|想像で答え|仮定で答え|いいから推測|必ず推測)/i;
const PHONE_HANGUP_RE = /^(?:(?:電話|通話)(?:を|は)?\s*)?(?:切って|切れ|切ってください|終了して|終わって|終話して|電話を終えて|通話を終えて)(?:ください|下さい|くれ|もらえますか|よ)?[。.!！?？…\s]*$/i;

export function stripLeadingSocialPreamble(text = '') {
  const raw = compact(text);
  if (!raw) return '';
  const stripped = raw.replace(LEADING_SOCIAL_RE, '').trim();
  return stripped || '';
}

export function isPhoneHangupRequest(text = '') {
  return PHONE_HANGUP_RE.test(compact(text, 600));
}

function recentUserContext(body = {}) {
  const history = Array.isArray(body?.history) ? body.history.slice(-8) : [];
  return history
    .filter((item) => item?.role !== 'assistant')
    .map((item) => compact(item?.content, 1000))
    .filter(Boolean)
    .join(' ');
}

export function shouldSuppressExternalSearch(text = '', body = {}) {
  const raw = compact(text);
  const value = stripLeadingSocialPreamble(raw);
  if (!raw || !value) return true;
  if (SOCIAL_ONLY_RE.test(value)) return true;
  if (ASSISTANT_META_RE.test(value)) return true;
  if (isPhoneHangupRequest(value)) return true;
  if (UNSAFE_ACTION_RE.test(value) || PRIVILEGE_INTERNAL_RE.test(value)) return true;

  const prior = recentUserContext(body);
  if (LEGAL_FOLLOWUP_RE.test(value) && UNSAFE_ACTION_RE.test(prior)) return true;
  if (SPECULATION_FOLLOWUP_RE.test(value) && (UNSAFE_ACTION_RE.test(prior) || PRIVILEGE_INTERNAL_RE.test(prior))) return true;
  return false;
}

export function normalizedSearchRoutingText(text = '') {
  const raw = compact(text);
  const stripped = stripLeadingSocialPreamble(raw);
  return stripped || raw;
}

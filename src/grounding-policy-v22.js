export const GROUNDING_POLICY_V22_REVISION = 'grounding-by-default-v22';

const PURE_SOCIAL_RE = /^(?:こんにちは|こんにちわ|こんばんは|おはよう(?:ございます)?|やあ|どうも|もしもし|ありがとう(?:ございます)?|助かりました|了解(?:です)?|わかりました|なるほど|そうなんだ|そうですね|はい|うん|いいえ|いや|大丈夫(?:です)?|またね|さようなら)[。！!？?、\s]*$/i;
const CONSULTATION_OPEN_RE = /(?:について|ことで|の件で)?(?:相談したい(?:です)?|相談に乗って(?:ほしい|ください)(?:です)?|相談があります|悩んでいます|迷っています|困っています)[。！!？?\s]*$/i;
const USER_REQUIREMENT_RE = /(?:用途|予算|希望|条件|使い方|目的).{0,20}(?:です|は|が|で)|(?:しか|だけ|ぐらい|くらい).{0,18}(?:しない|しません|使わない|使いません|見ない|見ません)|(?:主に|だいたい|ほとんど).{0,24}(?:使います|見ます|します)|(?:欲しい|ほしい|したい|したくない|苦手です|得意です)[。！!？?\s]*$/i;
const PERSONAL_ADVICE_RE = /(?:どうすれば|どうしたら|どう考えれば|どう整理すれば|どう決めれば|どう伝えれば|どう断れば|どう進めれば).{0,40}(?:いい|よい|良い|いいかな|いいですか|よいですか)[。！!？?\s]*$/i;
const WRITING_TASK_RE = /(?:文章|メール|返信|メッセージ|文面|挨拶文|紹介文|説明文|キャッチコピー).{0,40}(?:作って|書いて|直して|整えて|短くして|丁寧にして|自然にして)/i;
const CREATIVE_TASK_RE = /(?:物語|詩|歌詞|ネタ|アイデア|名前|タイトル|キャッチコピー).{0,40}(?:考えて|作って|書いて)/i;
const SIMPLE_CALC_RE = /^[0-9０-９+＋\-−ー*＊×\/÷().（）,%％\s]+(?:は|=|＝)?[？?]?$/;

const EXPLICIT_SEARCH_RE = /(検索して|調べて|調べる|ウェブで|Webで|ネットで|最新情報|確認して|裏取り|根拠を確認)/i;
const CURRENT_FACT_RE = /(最新|現在|いま|今の|今日|明日|昨日|今年|今月|今週|ニュース|価格|値段|在庫|営業時間|営業中|天気|株価|為替|相場|発売|販売中|現行|法改正|制度改正|予定|日程|時刻表|運行|遅延|空席|予約状況|電話番号|連絡先|住所|所在地|アクセス|公式サイト|URL|ランキング|順位|スコア|結果)/i;
const REAL_WORLD_DOMAIN_RE = /(駅|路線|電車|鉄道|バス|飛行機|空港|乗り換え|乗換|経路|店舗|店頭|販売店|家電量販店|会社|企業|メーカー|病院|クリニック|大学|学校|ホテル|旅館|施設|役所|自治体|国|県|市|区|町|村|法律|条例|制度|税|保険|補助金|製品|商品|機種|モデル|型番|仕様|スペック|CPU|GPU|メモリ|SSD|OS|Windows|iPhone|Android|薬|医薬|病気|症状|選挙|議員|大統領|首相|知事|社長|CEO|選手|チーム|映画|番組|ゲーム|発売日|人口|面積|標高|距離|所要時間)/i;
const FACT_REQUEST_RE = /(何(?:ですか|なの|だ|が|を|円|時|分|年|人|件|台|m|メートル)?|誰|いつ|どこ|どれ|どの|いくら|何円|何時|何分|何年|何人|教えて|知りたい|知ってる|とは|って何|本当|正しい|事実|理由は|違いは|比較して|どっち|どちら|おすすめ|ある(?:の|かな|？|\?)|いる(?:の|かな|？|\?)|できますか|できる(?:の|かな|？|\?)|ありますか|いますか)/i;
const QUESTION_END_RE = /(?:ですか|ますか|なの|なのか|かな|だろう|でしょう|かね|？|\?)\s*$/i;
const NUMERIC_OR_DATE_RE = /(?:\d{1,4}(?:[.,]\d+)?|[０-９]{1,4})(?:年|月|日|円|万円|ドル|%|％|人|件|台|km|m|kg|GB|TB|GHz|MHz|W|V|分|時間|時)?/i;
const ENTITY_SUFFIX_RE = /[一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{2,30}(?:株式会社|有限会社|大学|病院|クリニック|ホテル|旅館|空港|駅|線|店|支店|営業所|センター|市|区|町|村|県|府|道|省|庁|省庁|協会|連盟|党|チーム)/i;
const MODEL_CODE_RE = /\b(?:[A-Z]{1,5}[- ]?[A-Z0-9]{2,}|[A-Za-z]+\s?\d{1,4}[A-Za-z0-9+.-]*)\b/;
const KATAKANA_ENTITY_RE = /[ァ-ヶー]{4,}/;
const FOLLOWUP_REFERENCE_RE = /(?:^|[\s、。])(それ|その(?:店|店舗|商品|製品|機種|会社|人|駅|場所|制度|法律|やつ)?|さっき|前の|こっち|そっち|あっち|同じ(?:もの|やつ|店)?)(?:[\s、。]|$)|^(?:じゃあ|で、?|それで|ちなみに|あと|ついでに)/i;
const ELLIPTICAL_FACT_RE = /^(?:それ|その)?(?:いくら|どこ|誰|いつ|何時|何分|何円|価格|値段|営業時間|住所|電話番号|在庫|発売日|社長|CEO|人口|距離|所要時間|おすすめ|どっち|どれ|詳しく|本当|正しい)/i;

function clean(value, max = 600) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function recentUserText(history, limit = 4) {
  return (Array.isArray(history) ? history : [])
    .filter((item) => item?.role === 'user')
    .map((item) => clean(item.content, 240))
    .filter(Boolean)
    .slice(-limit)
    .join(' ');
}

export function hasExternalFactRiskV22(text) {
  const value = clean(text, 1000);
  if (!value) return false;
  return EXPLICIT_SEARCH_RE.test(value)
    || CURRENT_FACT_RE.test(value)
    || REAL_WORLD_DOMAIN_RE.test(value)
    || NUMERIC_OR_DATE_RE.test(value)
    || ENTITY_SUFFIX_RE.test(value)
    || MODEL_CODE_RE.test(value)
    || KATAKANA_ENTITY_RE.test(value);
}

function isPureNonSearchTurn(value) {
  if (PURE_SOCIAL_RE.test(value)) return { match: true, reason: 'social' };
  if (SIMPLE_CALC_RE.test(value)) return { match: true, reason: 'simple-calculation' };
  if (WRITING_TASK_RE.test(value)) return { match: true, reason: 'writing-task' };
  if (CREATIVE_TASK_RE.test(value)) return { match: true, reason: 'creative-task' };
  if (CONSULTATION_OPEN_RE.test(value) && !FACT_REQUEST_RE.test(value)) return { match: true, reason: 'consultation-opening' };
  if (USER_REQUIREMENT_RE.test(value) && !FACT_REQUEST_RE.test(value) && !QUESTION_END_RE.test(value)) return { match: true, reason: 'user-requirement' };
  if (PERSONAL_ADVICE_RE.test(value) && !hasExternalFactRiskV22(value)) return { match: true, reason: 'subjective-advice' };
  return { match: false, reason: '' };
}

export function groundingDecisionV22(text, history = []) {
  const value = clean(text, 700);
  if (!value) return { search: false, reason: 'empty', riskTags: [] };

  const nonSearch = isPureNonSearchTurn(value);
  if (nonSearch.match) return { search: false, reason: nonSearch.reason, riskTags: [] };

  const riskTags = [];
  if (EXPLICIT_SEARCH_RE.test(value)) riskTags.push('explicit-verification');
  if (CURRENT_FACT_RE.test(value)) riskTags.push('current-or-live-fact');
  if (REAL_WORLD_DOMAIN_RE.test(value)) riskTags.push('real-world-domain');
  if (ENTITY_SUFFIX_RE.test(value) || MODEL_CODE_RE.test(value) || KATAKANA_ENTITY_RE.test(value)) riskTags.push('named-entity');
  if (NUMERIC_OR_DATE_RE.test(value)) riskTags.push('numeric-or-date');
  if (FACT_REQUEST_RE.test(value) || QUESTION_END_RE.test(value)) riskTags.push('factual-question');

  const historyText = recentUserText(history, 4);
  const contextualFollowup = (FOLLOWUP_REFERENCE_RE.test(value) || ELLIPTICAL_FACT_RE.test(value) || value.length <= 24)
    && hasExternalFactRiskV22(historyText)
    && (FACT_REQUEST_RE.test(value) || QUESTION_END_RE.test(value) || ELLIPTICAL_FACT_RE.test(value));
  if (contextualFollowup) riskTags.push('contextual-fact-followup');

  if (riskTags.length) {
    return { search: true, reason: riskTags[0], riskTags: [...new Set(riskTags)] };
  }

  if (FACT_REQUEST_RE.test(value) || QUESTION_END_RE.test(value)) {
    return { search: true, reason: 'factual-default', riskTags: ['factual-default'] };
  }

  return { search: false, reason: 'conversational-nonfact', riskTags: [] };
}

export function requiresGroundingSearchV22(text, history = []) {
  return groundingDecisionV22(text, history).search;
}

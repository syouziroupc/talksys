const FRESH_FACT_RE = /(最新|現在|いま|今の|今日|明日|昨日|ニュース|価格|値段|在庫|営業時間|営業中|天気|株価|為替|相場|発売|販売中|現行法|法改正|制度改正|予定|日程|時刻表|運行|空席|予約状況|電話番号|連絡先|問い合わせ先|住所|所在地|アクセス|公式サイト|公式ページ|URL)/i;
const CURRENT_NOW_RE = /(?:^|[\s、。！？])今(?:[0-9０-９]|いくら|何|どこ|誰|売|買|ある|いる|開|営業|価格|値段|在庫|ニュース|天気|株価|為替|相場)/i;
const EXPLICIT_SEARCH_RE = /(検索して|検索|調べて|調べる|ウェブで|Webで|ネットで調べ|最新情報)/i;
const LOCAL_PURCHASE_RE = /(?:どこ(?:か)?(?:で|に).{0,28}(?:買|購入|売)|買(?:え|える|いたい).{0,20}(?:場所|店|店舗)|(?:いい|良い|おすすめ).{0,12}(?:場所|店|店舗)|(?:近く|周辺|市内|県内).{0,24}(?:買|店|店舗|販売)|(?:店|店舗|販売店).{0,18}(?:ある|ない|開い|営業|在庫))/i;
const LOCATED_REAL_WORLD_RE = /(?:都|道|府|県|市|区|町|村|駅|丁目|番地).{0,72}(?:どこ|店|店舗|販売|買|購入|売って|営業時間|営業中|電話|住所|行ける|おすすめの場所)/i;
const NAMED_ENTITY_DETAIL_RE = /(?:店|店舗|支店|営業所|クリニック|病院|ホテル|旅館|施設|会社|センター|駅).{0,32}(?:電話番号|連絡先|住所|所在地|営業時間|在庫|公式サイト|URL|アクセス)/i;

export function requiresFreshSearch(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  return FRESH_FACT_RE.test(value)
    || CURRENT_NOW_RE.test(value)
    || EXPLICIT_SEARCH_RE.test(value)
    || LOCAL_PURCHASE_RE.test(value)
    || LOCATED_REAL_WORLD_RE.test(value)
    || NAMED_ENTITY_DETAIL_RE.test(value);
}

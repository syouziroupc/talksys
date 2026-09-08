const FRESH_FACT_RE = /(最新|現在|いま|今の|今日|明日|昨日|ニュース|価格|値段|在庫|営業時間|営業中|天気|株価|為替|相場|発売|販売中|現行法|法改正|制度改正|予定|日程|時刻表|運行|空席|予約状況)/i;
const CURRENT_NOW_RE = /(?:^|[\s、。！？])今(?:[0-9０-９]|いくら|何|どこ|誰|売|買|ある|いる|開|営業|価格|値段|在庫|ニュース|天気|株価|為替|相場)/i;
const EXPLICIT_SEARCH_RE = /(検索して|検索|調べて|調べる|ウェブで|Webで|ネットで調べ|最新情報)/i;
const LOCAL_PURCHASE_RE = /(どこで買|どこに売|買える(?:店|場所)|近くの?(?:店|店舗)|(?:店|店舗|販売店).{0,18}(?:ある|開い|営業|在庫)|(?:市内|県内).{0,18}(?:店|店舗|買))/i;

export function requiresFreshSearch(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  return FRESH_FACT_RE.test(value)
    || CURRENT_NOW_RE.test(value)
    || EXPLICIT_SEARCH_RE.test(value)
    || LOCAL_PURCHASE_RE.test(value);
}

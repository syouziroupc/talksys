import { collectWebEvidenceV21 } from './search-v21.js';
import { hasExternalFactRiskV22 } from './grounding-policy-v22.js';

export const SEARCH_TOOL_V22_REVISION = 'evidence-only-web-tool-v22-grounding-default';

const CONTEXT_NOISE_RE = /^(?:はい|うん|そう|そうだね|なるほど|ありがとう(?:ございます)?|お願いします?|えーと|うーん|じゃあ|それで|こんにちは|こんばんは|おはよう(?:ございます)?)[\s。、！？!?]*$/i;
const FOLLOWUP_REFERENCE_RE = /(?:それ|その(?:店|店舗|商品|製品|機種|会社|人|駅|場所|制度|法律|やつ)?|さっき|前の|こっち|そっち|あっち|同じ(?:もの|やつ|店)?|じゃあ|それで|ちなみに|あと|ついでに)/i;
const ELLIPTICAL_RE = /^(?:それ|その)?(?:どこ|どれ|どっち|誰|いつ|いくら|何円|何時|何分|何年|価格|値段|営業時間|住所|電話番号|在庫|発売日|社長|CEO|人口|距離|所要時間|安い|高い|おすすめ|詳しく|本当|正しい|どうなの)/i;
const GENERIC_SUBJECT_RE = /(?:もの|やつ|ところ|場所|店|店舗|店頭|それ|その|どれ|どっち|おすすめ|安いところ|高いところ)/i;
const SELF_CONTAINED_ENTITY_RE = /(?:[一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{2,30}(?:駅|線|店|支店|会社|株式会社|大学|病院|ホテル|空港|市|区|町|村|県|府|道)|\b[A-Z]{1,5}[- ]?[A-Z0-9]{2,}\b|[ァ-ヶー]{4,}|Windows|iPhone|Android)/i;
const DOMAIN_SUBJECT_RE = /(パソコン|PC|スマホ|スマートフォン|ノートPC|デスクトップ|CPU|GPU|メモリ|SSD|車|バイク|保険|税|法律|制度|薬|病気|電車|鉄道|バス|飛行機|ホテル|店舗|会社|企業|大学|学校)/i;
const SHOP_FOLLOWUP_RE = /(店|店舗|店頭|ショップ|買う|買いたい|購入|おすすめ|どこで買|どこにある|近く|周辺)/i;
const SHOP_MODIFIER_RE = /(中古|新品|整備済|リファービッシュ|アウトレット|安い|格安)/i;

function clean(value, max = 700) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function recentUserTurns(history, limit = 10) {
  const out = [];
  for (const item of Array.isArray(history) ? history : []) {
    if (item?.role !== 'user') continue;
    const value = clean(item.content, 220);
    if (!value || CONTEXT_NOISE_RE.test(value) || value === out.at(-1)) continue;
    out.push(value);
  }
  return out.slice(-limit);
}

function looksSelfContained(current) {
  if (SELF_CONTAINED_ENTITY_RE.test(current) || DOMAIN_SUBJECT_RE.test(current)) return true;
  const stations = [...current.matchAll(/([一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{1,24}?駅)(?=(?:から|まで|へ|に|で|の|を|が|は|と|周辺|近く|、|。|！|？|!|\?|\s|$))/g)];
  if (stations.length >= 2) return true;
  return false;
}

function canonicalDomainAnchor(text) {
  const value = clean(text, 260);
  if (/(パソコン|\bPC\b|ノートPC|デスクトップ|CPU|GPU|メモリ|SSD|Windows|MacBook|ThinkPad|レッツノート|Let'?s\s*note)/i.test(value)) return 'パソコン';
  if (/(スマホ|スマートフォン|iPhone|Android)/i.test(value)) return 'スマートフォン';
  if (/(車|自動車)/i.test(value)) return '自動車';
  if (/バイク|二輪/i.test(value)) return 'バイク';
  if (/(電車|鉄道|駅|路線)/i.test(value)) return '鉄道';
  if (/ホテル/i.test(value)) return 'ホテル';
  if (/(保険|税|法律|制度|薬|病気|会社|企業|大学|学校)/i.test(value)) return value.match(DOMAIN_SUBJECT_RE)?.[0] || '';
  return '';
}

function latestDomainAnchor(turns) {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const anchor = canonicalDomainAnchor(turns[i]);
    if (anchor) return anchor;
  }
  return '';
}

function latestShopModifier(turns) {
  for (let i = turns.length - 1; i >= Math.max(0, turns.length - 5); i -= 1) {
    const match = turns[i].match(SHOP_MODIFIER_RE);
    if (match?.[1]) return match[1];
  }
  return '';
}

export function resolveGroundedQuestionV22(query, history = []) {
  const current = clean(query, 500);
  if (!current) return '';
  const prior = recentUserTurns(history, 10).filter((item) => item !== current);
  if (!prior.length) return current;

  const selfContained = looksSelfContained(current);
  const genericNeedsPrior = GENERIC_SUBJECT_RE.test(current) && !DOMAIN_SUBJECT_RE.test(current);
  const needsContext = FOLLOWUP_REFERENCE_RE.test(current)
    || ELLIPTICAL_RE.test(current)
    || genericNeedsPrior
    || (!selfContained && current.length <= 34 && /(?:なら|だったら|では|の場合|について|どう|何|どこ|どれ|いくら|安い|高い)/i.test(current));

  if (!needsContext) return current;

  // Shopping/location follow-ups should inherit only the subject and active purchase
  // condition. Carrying whole earlier utterances (e.g. "YouTubeを見る") pollutes
  // queries and can turn a used-PC store search into an unrelated YouTube search.
  if (SHOP_FOLLOWUP_RE.test(current)) {
    const anchor = latestDomainAnchor(prior);
    const modifier = latestShopModifier(prior);
    if (anchor) return clean([anchor, modifier, current].filter(Boolean).join(' '), 650);
  }

  const usefulPrior = prior
    .filter((item) => hasExternalFactRiskV22(item) || DOMAIN_SUBJECT_RE.test(item) || SELF_CONTAINED_ENTITY_RE.test(item));
  if (!usefulPrior.length) return current;

  const nearest = usefulPrior.at(-1);
  const anchor = latestDomainAnchor(usefulPrior);
  if (anchor && canonicalDomainAnchor(nearest) !== anchor) {
    return clean([anchor, nearest, current].join(' '), 650);
  }
  return clean([nearest, current].join(' '), 650);
}

export async function collectGroundedEvidenceV22(query, history = [], options = {}) {
  const resolvedQuestion = resolveGroundedQuestionV22(query, history);
  const result = await collectWebEvidenceV21(resolvedQuestion, [], options);
  return {
    ...result,
    revision: SEARCH_TOOL_V22_REVISION,
    resolvedQuestion,
  };
}

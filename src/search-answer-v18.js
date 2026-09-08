import {
  answerWithCloudflareWebSearch,
  GROUNDING_CONVERSATION_MODEL,
  GROUNDING_FALLBACK_MODEL,
  QUALITY_CONVERSATION_MODEL,
  runNonStreamingCascade,
} from './cloudflare-llm.js';
import { formatSearchContext } from './web-search.js';

const BAD_SEARCH_BOILERPLATE_RE = /(ご提示いただいた|いただいた検索結果|情報源を提示|ページや情報があれば|改めてご提示|裏付けが十分ではありません|回答を差し上げることができません|確認できる範囲の選び方や比較なら続けられます)/i;
const GENERIC_SOURCE_TITLE_RE = /(おすすめ\s*\d+選|おすすめ一覧|選び方|ガイド|比較|ランキング|まとめ|特集|記事|コラム|スペック(?:の)?目安|診断|初心者向け|自作パソコン|ノートパソコン(?:\s*$|\s*[｜|]|を選|の選)|デスクトップパソコン(?:\s*$|\s*[｜|])|店舗一覧|店舗検索|取扱店舗|中古・アウトレットパソコン専門店.*おすすめ)/i;
const BUSINESS_NAME_RE = /(店|店舗|ショップ|電機|デンキ|カメラ|商事|センター|PC\s*DEPOT|パソコン工房|ドスパラ|エディオン|ヤマダ|ベスト電器|ケーズデンキ)/i;

function clean(value) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseAuditJson(text) {
  const raw = String(text || '').trim();
  const candidate = raw.match(/\{[\s\S]*\}/)?.[0] || raw;
  try {
    const data = JSON.parse(candidate);
    return {
      ok: data?.ok === true,
      answer: String(data?.answer || '').trim(),
      unsupported: Array.isArray(data?.unsupported) ? data.unsupported.map(clean).filter(Boolean).slice(0, 12) : [],
      reason: clean(data?.reason || '').slice(0, 300),
    };
  } catch {
    return { ok: false, answer: '', unsupported: [], reason: 'audit_parse_failed' };
  }
}

function evidenceText(sources) {
  return (sources || []).map((item) => `${item?.title || ''} ${item?.snippet || ''} ${item?.excerpt || ''} ${item?.url || ''}`)
    .join('\n')
    .toLowerCase();
}

function riskyNamedCandidates(answer) {
  const value = clean(answer);
  const matches = value.match(/[A-Za-z0-9一-龠々ヶぁ-んァ-ヶ・ー]{2,32}(?:別府店|大分店|本店|支店|店舗|ショップ|センター|電機|デンキ|カメラ|商事)/g) || [];
  return [...new Set(matches.map((item) => item.replace(/^(?:また|一方|例えば|候補は|なら)/, '').trim()).filter((item) => item.length >= 3))].slice(0, 12);
}

function unsupportedNamedCandidates(answer, sources) {
  const haystack = evidenceText(sources);
  return riskyNamedCandidates(answer).filter((name) => {
    const normalized = name.toLowerCase();
    if (haystack.includes(normalized)) return false;
    const withoutSuffix = normalized.replace(/(?:別府店|大分店|本店|支店|店舗|ショップ|センター)$/, '');
    return withoutSuffix.length >= 4 && !haystack.includes(withoutSuffix);
  });
}

function titleSegments(title) {
  return clean(title)
    .split(/\s*(?:[｜|]|—|–|\s-\s)\s*/)
    .map(clean)
    .filter(Boolean);
}

function sourceCandidateFromTitle(item) {
  const title = clean(item?.title);
  if (!title || GENERIC_SOURCE_TITLE_RE.test(title)) return '';

  for (const segment of titleSegments(title)) {
    if (!segment || GENERIC_SOURCE_TITLE_RE.test(segment)) continue;
    if (!BUSINESS_NAME_RE.test(segment)) continue;
    if (segment.length < 3 || segment.length > 64) continue;
    if (/^(?:公式|ホーム|トップ|検索結果|店舗情報)$/i.test(segment)) continue;
    return segment.replace(/^[【\[]|[】\]]$/g, '').trim();
  }
  return '';
}

function sourceTitleRescue(question, sources) {
  const candidates = [];
  for (const item of sources || []) {
    const candidate = sourceCandidateFromTitle(item);
    if (!candidate || candidates.includes(candidate)) continue;
    candidates.push(candidate);
    if (candidates.length >= 3) break;
  }

  const q = String(question || '');
  if (candidates.length) {
    const suffix = /(安い|安さ|格安|低価格|予算)/i.test(q)
      ? '安さ優先なら、まず中古在庫のある店を見て、同程度の価格なら保証が長い方を選ぶのがいいです。'
      : '価格だけでなく、保証と在庫を合わせて比べるのがいいです。';
    return `買う場所として検索根拠から確認できた候補は、${candidates.join('、')}です。${suffix}`;
  }

  if (/(パソコン|PC|ＰＣ)/i.test(q) && /(買|購入|店|店舗|販売|おすすめ)/i.test(q)) {
    return '具体的な店名まで信頼できる形では確認できませんでした。ネット閲覧やYouTube中心で安さを優先するなら、中古のWindows 11対応ノートを中心に、メモリ8GB以上、SSD256GB以上、保証付きで比較するのが現実的です。';
  }
  if (/(買|購入|店|店舗|販売)/i.test(q)) {
    return '具体的な店舗名は今回の検索で十分に確認できませんでした。保証重視なら正規販売店や大手量販店、価格重視なら中古専門店を中心に比較するのが現実的です。';
  }
  return '';
}

async function auditAnswer(ai, question, resolvedQuestion, answer, sources, options = {}) {
  const evidence = formatSearchContext((sources || []).slice(0, 12)) || '(直接のWeb根拠なし)';
  const models = [GROUNDING_FALLBACK_MODEL];
  const result = await runNonStreamingCascade(ai, models, [
    {
      role: 'system',
      content: `あなたはWeb根拠監査担当です。回答の流暢さではなく、根拠整合性だけを厳密に確認します。\n- 回答中の店舗名、会社名、施設名、製品名、価格、在庫、営業時間、日付、法律、現在の仕様など外部事実が、提示された検索根拠に現れているか確認する。\n- 特に店舗・会社・施設の固有名詞は、根拠にない名前を絶対に残さない。似た名前を推測で補完しない。\n- 一般論や論理的な比較は根拠外でもよいが、現在の具体的事実のように言い切らない。\n- 根拠不足部分だけ削除・言い換えし、質問への実用的な回答自体は残す。\n- 「検索結果がないので答えられない」のような逃げ回答にしない。\n- 電話で自然に聞ける日本語にする。MarkdownやURLは不要。\nJSONだけを返す: {"ok":true|false,"unsupported":["根拠のない主張"],"reason":"短い理由","answer":"根拠に合う修正版"}`,
    },
    {
      role: 'user',
      content: `元の質問: ${String(question || '').slice(0, 900)}\n解決した調査課題: ${String(resolvedQuestion || '').slice(0, 900)}\n\n監査対象回答:\n${String(answer || '').slice(0, 5000)}\n\n検索根拠:\n${evidence}`,
    },
  ], {
    signal: options.signal,
    maxTokens: 760,
    temperature: 0.01,
    perModelTimeoutMs: 2500,
    sessionAffinity: options.sessionAffinity,
  });
  return parseAuditJson(result.text);
}

export async function answerWithVerifiedWebSearch(ai, question, history, systemPrompt, options = {}) {
  const totalStarted = Date.now();
  const base = await answerWithCloudflareWebSearch(ai, question, history, systemPrompt, options);
  let text = String(base.text || '').trim();
  let audit = { ok: false, answer: '', unsupported: [], reason: 'not_run' };

  const auditStarted = Date.now();
  try {
    audit = await auditAnswer(ai, question, base.resolvedQuestion || question, text, base.sources || [], options);
    if (audit.answer) text = audit.answer;
  } catch {
    audit = { ok: false, answer: '', unsupported: [], reason: 'audit_budget_or_model_failure' };
  }
  const auditMs = Date.now() - auditStarted;

  // Mechanical evidence guard is the final authority. It now rejects generic article titles before any title-based rescue can be spoken.
  const unsupported = unsupportedNamedCandidates(text, base.sources || []);
  if (!text || BAD_SEARCH_BOILERPLATE_RE.test(text) || unsupported.length) {
    const rescue = sourceTitleRescue(base.resolvedQuestion || question, base.sources || []);
    if (rescue) text = rescue;
  }

  return {
    ...base,
    text: text || '確認できた情報を整理して、分かった範囲から答えます。',
    provider: 'cloudflare-workers-ai-bounded-verified-search-v18',
    auditPassed: unsupported.length === 0 && audit.ok === true,
    auditReason: audit.reason,
    unsupportedRemoved: [...new Set([...(audit.unsupported || []), ...unsupported])].slice(0, 12),
    timings: {
      ...(base.timings || {}),
      auditMs,
      totalSearchAnswerMs: Date.now() - totalStarted,
    },
  };
}

export { parseAuditJson, riskyNamedCandidates, unsupportedNamedCandidates, sourceCandidateFromTitle, sourceTitleRescue };

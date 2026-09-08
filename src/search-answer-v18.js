import {
  answerWithCloudflareWebSearch,
  GROUNDING_CONVERSATION_MODEL,
  GROUNDING_FALLBACK_MODEL,
  QUALITY_CONVERSATION_MODEL,
  runNonStreamingCascade,
} from './cloudflare-llm.js';
import { formatSearchContext } from './web-search.js';

const BAD_SEARCH_BOILERPLATE_RE = /(ご提示いただいた|いただいた検索結果|情報源を提示|ページや情報があれば|改めてご提示|裏付けが十分ではありません|回答を差し上げることができません|確認できる範囲の選び方や比較なら続けられます)/i;

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
  const matches = value.match(/[A-Za-z0-9一-龠々ヶぁ-んァ-ヶ・ー]{2,32}(?:別府店|大分店|本店|支店|店舗|ショップ|センター|電機|デンキ|カメラ|工房)/g) || [];
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

function sourceTitleRescue(question, sources) {
  const candidates = [];
  for (const item of sources || []) {
    const title = clean(item?.title);
    if (!title || candidates.includes(title)) continue;
    if (!/(店|店舗|ショップ|家電|パソコン|PC|ヤマダ|エディオン|ケーズ|ベスト|公式|販売)/i.test(title)) continue;
    candidates.push(title.slice(0, 90));
    if (candidates.length >= 3) break;
  }
  if (candidates.length) {
    return `検索で実在を確認できた候補としては、${candidates.map((item) => `「${item}」`).join('、')}があります。店頭在庫や当日の価格は変わるので、行く前にそこだけ確認するのが安全です。`;
  }
  if (/(買|購入|店|店舗|販売)/i.test(String(question || ''))) {
    return '具体的な店舗名は今回の検索で十分に確認できませんでした。ただ、買う場所としては、保証重視なら家電量販店、価格重視なら中古パソコン専門店、機種を決めているならメーカー直販か大手通販の順で比較するのが現実的です。';
  }
  return '';
}

async function auditAnswer(ai, question, resolvedQuestion, answer, sources, options = {}) {
  const evidence = formatSearchContext((sources || []).slice(0, 12)) || '(直接のWeb根拠なし)';
  const models = [GROUNDING_FALLBACK_MODEL, GROUNDING_CONVERSATION_MODEL, QUALITY_CONVERSATION_MODEL];
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
    maxTokens: 900,
    temperature: 0.01,
    sessionAffinity: options.sessionAffinity,
  });
  return parseAuditJson(result.text);
}

export async function answerWithVerifiedWebSearch(ai, question, history, systemPrompt, options = {}) {
  const base = await answerWithCloudflareWebSearch(ai, question, history, systemPrompt, options);
  let text = String(base.text || '').trim();
  let audit = { ok: false, answer: '', unsupported: [], reason: 'not_run' };

  try {
    audit = await auditAnswer(ai, question, base.resolvedQuestion || question, text, base.sources || [], options);
    if (audit.answer) text = audit.answer;
  } catch {}

  let unsupported = unsupportedNamedCandidates(text, base.sources || []);
  if (unsupported.length) {
    try {
      const second = await auditAnswer(
        ai,
        question,
        base.resolvedQuestion || question,
        `${text}\n\n機械検査で根拠にない可能性が高い固有名詞: ${unsupported.join('、')}。これらを必ず削除して、検索根拠に書かれた固有名詞だけで答え直すこと。`,
        base.sources || [],
        options,
      );
      if (second.answer) {
        text = second.answer;
        audit = second;
      }
    } catch {}
    unsupported = unsupportedNamedCandidates(text, base.sources || []);
  }

  if (!text || BAD_SEARCH_BOILERPLATE_RE.test(text) || unsupported.length) {
    const rescue = sourceTitleRescue(base.resolvedQuestion || question, base.sources || []);
    if (rescue) text = rescue;
  }

  return {
    ...base,
    text: text || '確認した情報を整理できなかったので、条件を保ったまま検索をやり直します。',
    provider: 'cloudflare-workers-ai-verified-deep-search-v18',
    auditPassed: audit.ok === true && unsupported.length === 0,
    auditReason: audit.reason,
    unsupportedRemoved: [...new Set([...(audit.unsupported || []), ...unsupported])].slice(0, 12),
  };
}

export { parseAuditJson, riskyNamedCandidates, unsupportedNamedCandidates, sourceTitleRescue };

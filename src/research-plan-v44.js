export const RESEARCH_PLAN_V44_REVISION = 'question-first-evidence-state-machine-v44';

function clean(value, max = 1200) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function unique(values, limit = 20) {
  const out = [];
  const seen = new Set();
  for (const raw of values || []) {
    const value = clean(raw, 320);
    if (value.length < 2) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function defaultFacetQuestion(resolvedQuestion, label) {
  const resolved = clean(resolvedQuestion, 900);
  return clean(`${resolved} — ${label}`, 1000);
}

export function normalizeResearchFacets(rawFacets, resolvedQuestion, intent = 'general') {
  const out = [];
  const seen = new Set();
  for (const [index, raw] of (Array.isArray(rawFacets) ? rawFacets : []).entries()) {
    if (!raw || typeof raw !== 'object') continue;
    const question = clean(raw.question || raw.subquestion || raw.goal, 700);
    const evidenceNeeded = clean(raw.evidence_needed || raw.evidenceNeeded || raw.required_fact || raw.requiredFact, 500);
    const primaryQuery = clean(raw.primary_query || raw.primaryQuery || raw.query, 320);
    if (!question || !primaryQuery) continue;
    const key = `${question.toLowerCase()}|${primaryQuery.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: clean(raw.id, 40) || `f${index + 1}`,
      question,
      evidenceNeeded: evidenceNeeded || question,
      preferredSources: unique(raw.preferred_sources || raw.preferredSources || [], 5),
      primaryQuery,
      backupQueries: unique(raw.backup_queries || raw.backupQueries || [], 2).filter((q) => q.toLowerCase() !== primaryQuery.toLowerCase()),
      priority: Math.max(1, Math.min(5, Number(raw.priority) || 3)),
    });
    if (out.length >= 6) break;
  }
  return out.length ? out : heuristicResearchFacets(resolvedQuestion, intent);
}

export function heuristicResearchFacets(resolvedQuestion, intent = 'general', location = '') {
  const q = clean(resolvedQuestion, 900);
  const loc = clean(location, 100);
  const facets = [];
  const add = (id, question, evidenceNeeded, primaryQuery, backupQueries = [], preferredSources = [], priority = 3) => {
    facets.push({ id, question, evidenceNeeded, primaryQuery: clean(primaryQuery, 320), backupQueries: unique(backupQueries, 2), preferredSources, priority });
  };

  if (intent === 'shopping') {
    add('candidate', defaultFacetQuestion(q, '条件に合う具体的な候補は何か'), '条件を満たす候補の存在', `${q} 候補`, [`${q} 製品`, `${q} 中古 新品`], ['販売ページ', 'メーカー'], 5);
    add('price', defaultFacetQuestion(q, '現在いくらで入手できるか'), '候補ごとの現在価格と販売元', `${q} 実売価格`, [`${q} 在庫 価格`], ['販売店', '公式ストア'], 5);
    add('fit', defaultFacetQuestion(q, '用途・条件を本当に満たすか'), '候補ごとの仕様・適合条件', `${q} 仕様`, [`${q} 対応 仕様`], ['メーカー', '仕様書'], 5);
    add('risk', defaultFacetQuestion(q, '弱点・不適合・注意点は何か'), '候補の欠点、制約、反証', `${q} 問題 注意点`, [`${q} 不具合 評判`], ['メーカーサポート', '独立レビュー'], 3);
  } else if (intent === 'comparison') {
    add('criteria', defaultFacetQuestion(q, '比較を決める評価軸は何か'), '比較対象ごとの同一指標', `${q} 仕様 比較`, [`${q} 公式 仕様`], ['公式仕様'], 5);
    add('difference', defaultFacetQuestion(q, '実質的な差は何か'), '差が結論を変える根拠', `${q} 違い`, [`${q} 比較 レビュー`], ['一次情報', '独立レビュー'], 5);
    add('counter', defaultFacetQuestion(q, '例外や反証はあるか'), '主結論を覆し得る条件', `${q} 問題 制限`, [`${q} 例外`], ['一次情報', '独立ソース'], 3);
  } else if (intent === 'local') {
    add('place', defaultFacetQuestion(q, '実在する候補地点はどこか'), '所在地が確認できる具体的候補', `${loc ? `${loc} ` : ''}${q}`, [`${loc ? `${loc} ` : ''}${q} 店舗`], ['公式店舗情報', '地図'], 5);
    add('availability', defaultFacetQuestion(q, '現在利用・購入できるか'), '営業時間・在庫・提供状況', `${loc ? `${loc} ` : ''}${q} 営業 在庫`, [], ['公式店舗情報'], 4);
    add('fit', defaultFacetQuestion(q, '利用者条件に最も合うのはどこか'), '条件別の比較材料', `${loc ? `${loc} ` : ''}${q} 比較`, [], ['公式', '独立レビュー'], 3);
  } else {
    add('core', defaultFacetQuestion(q, '直接の答えを決める事実は何か'), '質問へ直接答える一次的根拠', q, [`${q} 公式`], ['一次情報', '信頼できる解説'], 5);
    add('verify', defaultFacetQuestion(q, '別ソースで同じ結論を確認できるか'), '独立した裏取り', `${q} 解説`, [`${q} 資料`], ['独立ソース'], 3);
    add('counter', defaultFacetQuestion(q, '例外・条件・反証はあるか'), '断定を修正する例外条件', `${q} 例外 問題`, [], ['一次情報', '独立ソース'], 2);
  }
  return facets.slice(0, 6);
}

export function compileInitialQueries(plan, limit = 6) {
  const facets = Array.isArray(plan?.facets) ? [...plan.facets] : [];
  facets.sort((a, b) => (Number(b?.priority) || 0) - (Number(a?.priority) || 0));
  return unique(facets.map((facet) => facet?.primaryQuery), limit);
}

export function compileFollowupQueries(plan, coverage, usedQueries = [], limit = 6) {
  const used = new Set(unique(usedQueries, 100).map((q) => q.toLowerCase()));
  const missing = new Set((coverage?.missingFacets || coverage?.missing_facets || []).map((x) => clean(x, 40)));
  const out = [];
  const add = (q) => {
    const value = clean(q, 320);
    if (!value || used.has(value.toLowerCase()) || out.some((x) => x.toLowerCase() === value.toLowerCase())) return;
    out.push(value);
  };

  for (const q of coverage?.queries || []) add(q);
  const facets = Array.isArray(plan?.facets) ? plan.facets : [];
  const targets = missing.size ? facets.filter((f) => missing.has(clean(f?.id, 40))) : facets;
  for (const facet of targets) {
    for (const q of facet?.backupQueries || []) add(q);
    if (out.length >= limit) break;
  }
  if (!coverage?.sufficient && out.length < limit) {
    for (const facet of facets) {
      for (const q of facet?.backupQueries || []) add(q);
      if (out.length >= limit) break;
    }
  }
  return out.slice(0, limit);
}

export function researchFocus(plan) {
  const resolved = clean(plan?.resolvedQuestion, 1200);
  const facets = (plan?.facets || []).map((f) => `${clean(f?.question, 500)} / 必要根拠: ${clean(f?.evidenceNeeded, 400)}`).filter(Boolean);
  return clean([resolved, ...facets].join(' | '), 4000);
}

export function facetPlanQueries(plan, limit = 14) {
  const values = [];
  for (const facet of plan?.facets || []) values.push(facet?.primaryQuery, ...(facet?.backupQueries || []));
  return unique(values, limit);
}

export const __test = { clean, unique };

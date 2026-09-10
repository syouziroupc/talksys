from pathlib import Path
import re

path = Path('src/search-v44.js')
text = path.read_text()

text = text.replace(
"""  buildCandidateVerificationQueries,
  candidateEvidenceText,
  discoveryQueries,
  needsCandidateDiscovery,
  normalizeCandidates,
} from './research-sequence-v44.js';""",
"""  buildCandidateVerificationQueries,
  candidateEvidenceText,
  candidateTypeForPlan,
  discoveryQueries,
  needsCandidateDiscovery,
  normalizeCandidates,
  researchModeForPlan,
} from './research-sequence-v44.js';"""
)

old_prompt = '''content: `あなたはTalkSysの調査設計者です。検索語を大量生成する役ではありません。まず「この質問に正しく答えるには、何が分かれば結論が決まるか」を分解してください。\\n\\n手順:\\n1. 今回の発話を会話から自己完結した調査課題へ復元する。\\n2. 結論を左右する独立した論点を3〜6個に分ける。論点は「候補発見」「価格」「仕様」「適合性」「現在性」「例外・反証」など、必要なものだけにする。\\n3. 各論点について、必要な証拠、最適な情報源の種類、最初に打つ短い検索語を1本、必要なら予備検索語を最大2本だけ作る。\\n4. 検索語は会話文をそのまま貼らず、固有名詞・条件・知りたい事実を中心にする。「公式」「比較」「最新」を機械的に付け足さない。情報源の性質に合う場合だけ使う。\\n5. ユーザーが述べた地域、予算、型番、日時、用途、数量、除外条件を落とさない。assistantの過去発言は対象復元には使えるが外部事実の根拠にはしない。\\n6. 価格・在庫・法律・制度・時刻・ニュース・現行仕様など変動情報は${year}年の現在性が確認できる論点を作る。\\n7. 実在未確認の固有名詞を新しく作らない。検索本数に最低数はない。\\n\\nJSONだけを返す: {"resolved_question":"...","intent":"shopping|local|current|comparison|general|news|other","location":"...","must_include":["..."],"facets":[{"id":"短いID","question":"答えを決める小問","evidence_needed":"必要証拠","preferred_sources":["最適な情報源種別"],"primary_query":"最初の検索語","backup_queries":["予備1","予備2"],"priority":1-5}]}`,'''
new_prompt = '''content: `あなたはTalkSysの調査設計者です。検索語を大量生成する役ではありません。まず「この質問に正しく答えるには、何が分かれば結論が決まるか」と「どの順序で調べる必要があるか」を設計してください。\\n\\n手順:\\n1. 今回の発話を会話から自己完結した調査課題へ復元する。\\n2. 調査モードを決める。direct_fact=既知対象の事実確認、discover_then_verify=未知候補を見つけてから候補別検証、compare_known_entities=既知対象比較、local_discovery=店舗/場所発見後に営業等検証、current_status=最新状態確認。\\n3. 候補探索が必要なら candidate_type を product_model|store|place|company|service|person|document のどれかに固定する。不要なら none。商品選定では販売店ではなく product_model、近隣店舗探索では store を選ぶ。\\n4. 結論を左右する独立した論点を3〜6個に分ける。各論点に stage=discovery|verification と source_role を付ける。source_role は primary|official_spec|official_support|seller|marketplace|map|news|independent_review|reference|mixed。\\n5. discoveryは候補そのものを実在確認する検索、verificationは発見した候補の価格・仕様・適合性・弱点等を確認する検索にする。候補が未知なのにverificationを先に一般論で大量検索しない。\\n6. 各論点について必要証拠、最適情報源、最初の短い検索語を1本、必要なら予備検索語を最大2本だけ作る。検索語は固有名詞・条件・知りたい事実を中心にし、「公式」「比較」「最新」を機械的に付け足さない。\\n7. ユーザーが述べた地域、予算、型番、日時、用途、数量、除外条件を落とさない。assistantの過去発言は対象復元には使えるが外部事実の根拠にはしない。\\n8. 価格・在庫・法律・制度・時刻・ニュース・現行仕様など変動情報は${year}年の現在性を確認する。実在未確認の固有名詞を作らない。検索本数に最低数はない。\\n\\nJSONだけを返す: {"resolved_question":"...","intent":"shopping|local|current|comparison|general|news|other","research_mode":"direct_fact|discover_then_verify|compare_known_entities|local_discovery|current_status","candidate_type":"product_model|store|place|company|service|person|document|none","location":"...","must_include":["..."],"facets":[{"id":"短いID","stage":"discovery|verification","question":"答えを決める小問","evidence_needed":"必要証拠","source_role":"primary|official_spec|official_support|seller|marketplace|map|news|independent_review|reference|mixed","preferred_sources":["最適な情報源種別"],"primary_query":"最初の検索語","backup_queries":["予備1","予備2"],"priority":1-5}]}`,'''
assert old_prompt in text, 'planner prompt not found'
text = text.replace(old_prompt, new_prompt)

old_plan = '''      const facets = normalizeResearchFacets(data.facets, resolvedQuestion, intent);
      const queries = facetPlanQueries({ resolvedQuestion, intent, location, mustInclude, facets }, SEARCH_V44_MAX_QUERIES);
      if (facets.length && queries.length) {
        return {
          resolvedQuestion,
          intent,
          location,
          mustInclude,
          facets,
          queries,
          planned: true,
          plannerModel: PLANNER_MODEL,
          researchPlanRevision: RESEARCH_PLAN_V44_REVISION,
        };
      }'''
new_plan = '''      const facets = normalizeResearchFacets(data.facets, resolvedQuestion, intent);
      const strategySeed = {
        resolvedQuestion,
        intent,
        location,
        mustInclude,
        facets,
        researchMode: clean(data.research_mode || data.researchMode || '', 40),
        candidateType: clean(data.candidate_type || data.candidateType || '', 40),
      };
      const researchMode = researchModeForPlan(strategySeed);
      const candidateType = candidateTypeForPlan(strategySeed);
      const queries = facetPlanQueries({ ...strategySeed, researchMode, candidateType }, SEARCH_V44_MAX_QUERIES);
      if (facets.length && queries.length) {
        return {
          resolvedQuestion,
          intent,
          researchMode,
          candidateType,
          location,
          mustInclude,
          facets,
          queries,
          planned: true,
          plannerModel: PLANNER_MODEL,
          researchPlanRevision: RESEARCH_PLAN_V44_REVISION,
        };
      }'''
assert old_plan in text, 'planner parse block not found'
text = text.replace(old_plan, new_plan)

old_fallback = '''  const facets = heuristicResearchFacets(fallback, intent, '');
  return {
    resolvedQuestion: fallback,
    intent,
    location: '',
    mustInclude: [],
    facets,
    queries: facetPlanQueries({ resolvedQuestion: fallback, intent, facets }, SEARCH_V44_MAX_QUERIES),
    planned: false,
    plannerModel: null,
    researchPlanRevision: RESEARCH_PLAN_V44_REVISION,
  };'''
new_fallback = '''  const facets = heuristicResearchFacets(fallback, intent, '');
  const seed = { resolvedQuestion: fallback, intent, location: '', mustInclude: [], facets };
  const researchMode = researchModeForPlan(seed);
  const candidateType = candidateTypeForPlan(seed);
  return {
    ...seed,
    researchMode,
    candidateType,
    queries: facetPlanQueries({ ...seed, researchMode, candidateType }, SEARCH_V44_MAX_QUERIES),
    planned: false,
    plannerModel: null,
    researchPlanRevision: RESEARCH_PLAN_V44_REVISION,
  };'''
assert old_fallback in text, 'fallback plan block not found'
text = text.replace(old_fallback, new_fallback)

extract_pattern = r'''async function extractSupportedCandidates\(ai, plan, results, signal\) \{[\s\S]*?\n\}\n\nasync function assessCoverage'''
extract_replacement = r'''async function extractSupportedCandidates(ai, plan, results, signal) {
  const evidence = candidateEvidenceText(results, 24);
  if (!evidence) return [];
  const candidateType = candidateTypeForPlan(plan);
  const researchMode = researchModeForPlan(plan);
  const typeRule = candidateType === 'product_model'
    ? 'product_model=具体的な製品名・機種名・型番のみ。販売店、メーカー企業名だけ、記事媒体名は禁止。例: ThinkPad X280, CF-SV8, iPhone 13。'
    : candidateType === 'store'
      ? 'store=実在する販売店・店舗名のみ。商品型番や記事媒体名は禁止。'
      : candidateType === 'place'
        ? 'place=実在する施設・場所名のみ。'
        : `${candidateType}=その種類の固有名詞だけを返す。`;
  try {
    const result = await ai.run(PLANNER_MODEL, {
      messages: [
        {
          role: 'system',
          content: `検索結果から、次の検証検索に使う実在候補を抽出します。要求された候補タイプは ${candidateType} です。${typeRule} 候補名は提示された検索結果のタイトルまたは本文に文字列として実在し、今回のユーザー条件に関係するものだけ。一般カテゴリ名、記事タイトル、検索サイト名、ログインページ名、推測した名前は禁止。条件に合う候補が証拠中に無ければ空配列にしてください。JSONだけ: {"candidates":[{"name":"検索結果に実在する正確な候補名","type":"${candidateType}","evidence":"どの結果で確認したか短く"}]}`,
        },
        {
          role: 'user',
          content: `調査課題: ${plan.resolvedQuestion}\n調査モード: ${researchMode}\n候補タイプ: ${candidateType}\n意図: ${plan.intent}\n必須条件: ${(plan.mustInclude || []).join(' / ') || '(なし)'}\n\n検索結果:\n${evidence}`,
        },
      ],
      stream: false,
      max_completion_tokens: 460,
      temperature: 0.01,
      reasoning_effort: 'low',
    }, signal ? { signal } : undefined);
    const data = parseJsonObject(readModelText(result));
    return normalizeCandidates(data?.candidates, evidence, 4, candidateType);
  } catch {
    return [];
  }
}

async function assessCoverage'''
text, count = re.subn(extract_pattern, lambda _: extract_replacement, text, count=1)
assert count == 1, f'extract replacement count={count}'

text = text.replace(
"""  const facetLines = (plan?.facets || []).map((f) => `${f.id}: ${f.question} | 必要証拠=${f.evidenceNeeded} | 推奨=${(f.preferredSources || []).join(',')}`).join('\\n');""",
"""  const facetLines = (plan?.facets || []).map((f) => `${f.id}: stage=${f.stage || 'verification'} | ${f.question} | 必要証拠=${f.evidenceNeeded} | source_role=${f.sourceRole || 'reference'} | 推奨=${(f.preferredSources || []).join(',')}`).join('\\n');"""
)
text = text.replace(
"""content: 'Web調査の証拠ギャップを監査します。検索件数やドメイン数ではなく、各論点について「結論を出すのに必要な証拠が得られたか」を判定してください。論点ごとに covered / partial / missing / conflict を付け、missingまたはconflictの論点だけ追加検索してください。partialでも結論を左右する情報が欠けていればmissing_facetsへ入れてください。すでに結論を決められるなら追加検索しません。追加検索語は不足証拠を直接取りに行く短い語にし、既存検索の言い換えは禁止です。JSONだけ: {"sufficient":true|false,"reason":"...","facet_status":[{"id":"...","status":"covered|partial|missing|conflict","reason":"..."}],"missing_facets":["id"],"queries":["...最大5"]}',""",
"""content: 'Web調査の証拠ギャップを監査します。検索件数やドメイン数ではなく、各論点について「結論を出すのに必要な証拠が、要求されたsource_roleの種類の情報源から得られたか」を判定してください。仕様を一般ブログだけでcoveredにせず、official_specならメーカー公式仕様相当、価格ならseller、所在地ならmap/公式店舗情報を優先してください。論点ごとに covered / partial / missing / conflict を付け、missingまたはconflictの論点だけ追加検索してください。partialでも結論を左右する情報が欠けていればmissing_facetsへ入れてください。すでに結論を決められるなら追加検索しません。追加検索語は不足証拠とsource_roleを直接取りに行く短い語にし、既存検索の言い換えは禁止です。JSONだけ: {"sufficient":true|false,"reason":"...","facet_status":[{"id":"...","status":"covered|partial|missing|conflict","reason":"..."}],"missing_facets":["id"],"queries":["...最大5"]}',"""
)

old_return_flags = '''    sequentialDiscovery,
    candidateCount: candidates.length,
    candidateNames: candidates.map((x) => x.name),
    queryResultGate: true,'''
new_return_flags = '''    sequentialDiscovery,
    researchMode: researchModeForPlan(plan),
    candidateType: candidateTypeForPlan(plan),
    candidateCount: candidates.length,
    candidateNames: candidates.map((x) => x.name),
    queryResultGate: true,'''
assert old_return_flags in text, 'return flags block not found'
text = text.replace(old_return_flags, new_return_flags)

path.write_text(text)

# Keep discovery query hints non-redundant.
seq = Path('src/research-sequence-v44.js')
s = seq.read_text()
s = s.replace(
"""  const queries = selected.map((f) => clean(`${f?.primaryQuery || ''} ${hint}`, 320)).filter(Boolean);""",
"""  const queries = selected.map((f) => {
    const base = clean(f?.primaryQuery || '', 280);
    const alreadyTyped = type === 'product_model' ? /(型番|機種|モデル)/i.test(base)
      : type === 'store' ? /(店舗|店名|販売店|ショップ)/i.test(base)
        : false;
    return clean(`${base} ${alreadyTyped ? '' : hint}`, 320);
  }).filter(Boolean);"""
)
seq.write_text(s)

worker = Path('src/worker-v44.js')
w = worker.read_text()
w = w.replace(
"""      sequentialDiscovery: search.sequentialDiscovery === true,
      candidateCount: Number(search.candidateCount) || 0,""",
"""      sequentialDiscovery: search.sequentialDiscovery === true,
      researchMode: search.researchMode || '',
      candidateType: search.candidateType || '',
      candidateCount: Number(search.candidateCount) || 0,"""
)
w = w.replace(
"""        searchAuthorityAfterRelevance: true,""",
"""        searchAuthorityAfterRelevance: true,
        searchTypedResearchStrategy: true,
        searchSourceRoleAware: true,"""
)
worker.write_text(w)

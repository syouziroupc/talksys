from pathlib import Path

entry_path = Path('src/entry.js')
entry = entry_path.read_text()


def rep(text, old, new, label):
    if old not in text:
        raise SystemExit(f'missing patch anchor: {label}')
    return text.replace(old, new, 1)

entry = rep(
    entry,
    "const NAMED_ENTITY_RE = /(?:「([^」]{2,60})」|『([^』]{2,60})』|([一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{2,48}(?:店|店舗|商店|工房|電器|電機|病院|医院|クリニック|ホテル|旅館|カフェ|喫茶店|レストラン|株式会社|合同会社|有限会社)))/g;",
    "const NAMED_ENTITY_RE = /(?:「([^」]{2,60})」|『([^』]{2,60})』|([一-龠々ヶぁ-んァ-ヶA-Za-z0-9・ー]{2,40}(?:商店|工房|電器|電機|病院|医院|クリニック|ホテル|旅館|カフェ|喫茶店|レストラン|株式会社|合同会社|有限会社)))/g;",
    'narrow named entity matcher',
)

entry = rep(
    entry,
    "  const apiText = (Array.isArray(payload?.apiSources) ? payload.apiSources : []).map((source) => `${source?.tool || ''} ${source?.category || ''} ${source?.attribution || ''} ${source?.sourceUrl || ''}`).join(' ');\n  return normalize(`${question} ${sourceText} ${apiText}`);",
    "  const apiText = (Array.isArray(payload?.apiSources) ? payload.apiSources : []).map((source) => `${source?.tool || ''} ${source?.category || ''} ${source?.attribution || ''} ${source?.sourceUrl || ''}`).join(' ');\n  const candidateText = (Array.isArray(payload?.searchDiagnostics?.candidateNames) ? payload.searchDiagnostics.candidateNames : []).join(' ');\n  return normalize(`${question} ${sourceText} ${apiText} ${candidateText}`);",
    'candidate evidence corpus',
)

entry = rep(
    entry,
    "  if (EVIDENCE_REQUIRED_RE.test(question)) {\n    const guarded = removeUnsupportedNamedEntities(answer, payload, question);\n    if (guarded !== answer) reasons.push('named_entities_require_matching_evidence');\n    answer = guarded;\n    if (!hasEvidence && !answer) {\n      answer = '今回取得できた根拠では、実在や条件適合を確認できる具体候補を挙げられませんでした。';\n    }\n  }",
    "  if (EVIDENCE_REQUIRED_RE.test(question)) {\n    if (!hasEvidence) {\n      if (answer) reasons.push('evidence_required_but_missing');\n      answer = '今回取得できた根拠では、実在や条件適合を確認できる具体候補を挙げられませんでした。';\n    } else {\n      const guarded = removeUnsupportedNamedEntities(answer, payload, question);\n      if (guarded !== answer) reasons.push('named_entities_require_matching_evidence');\n      answer = guarded || '取得できた根拠の範囲では、具体名を安全に確認できませんでした。';\n    }\n  }",
    'fail closed evidence-required questions',
)
entry_path.write_text(entry)

worker_path = Path('src/worker-v44.js')
worker = worker_path.read_text()
worker = rep(
    worker,
    "  if (!value) return false;\n  if (NO_EXTERNAL_RE.test(value)) return false;\n  if (TRIVIAL_RE.test(value) || FEELING_ONLY_RE.test(value) || MEMORY_ONLY_RE.test(value) || SUBJECTIVE_RE.test(value) || CAPABILITY_RE.test(value)) return false;\n  if ((LOCAL_TRANSFORM_RE.test(value) || LOCAL_ADVICE_RE.test(value)) && !EXPLICIT_LOOKUP_RE.test(value) && !DYNAMIC_FACT_RE.test(value) && !REAL_WORLD_ENTITY_RE.test(value)) return false;\n  if (EXPLICIT_LOOKUP_RE.test(value) || DYNAMIC_FACT_RE.test(value) || REAL_WORLD_ENTITY_RE.test(value) || RECOMMENDATION_RE.test(value)) return true;\n  if (FACTUAL_QUESTION_RE.test(value)) return true;",
    "  if (!value) return false;\n  if (NO_EXTERNAL_RE.test(value)) return false;\n  if (TRIVIAL_RE.test(value) || FEELING_ONLY_RE.test(value) || MEMORY_ONLY_RE.test(value) || CAPABILITY_RE.test(value)) return false;\n  const evidenceRisk = EXPLICIT_LOOKUP_RE.test(value) || DYNAMIC_FACT_RE.test(value) || REAL_WORLD_ENTITY_RE.test(value) || RECOMMENDATION_RE.test(value);\n  if (evidenceRisk) return true;\n  if (SUBJECTIVE_RE.test(value)) return false;\n  if (LOCAL_TRANSFORM_RE.test(value) || LOCAL_ADVICE_RE.test(value)) return false;\n  if (FACTUAL_QUESTION_RE.test(value)) return true;",
    'evidence risk before subjective routing',
)
worker_path.write_text(worker)

# Update legacy tests whose old policy intentionally kept stable factual knowledge local.
# v54 makes factual questions evidence-first while retaining social/advice/transformation locally.
changes = {
    'tests/v44-deep-search-default.test.mjs': [
        ("test('v45 routes substantive turns by intent instead of blanket search', () => {", "test('v54 routes factual and recommendation turns to evidence while keeping social chat local', () => {"),
        ("assert.equal(worker.shouldSearchByDefault('RAMとSSDの違いを説明して'), false);", "assert.equal(worker.shouldSearchByDefault('RAMとSSDの違いを説明して'), true);"),
    ],
    'tests/v45-model-timeout.test.mjs': [
        ("test('unified router still keeps deterministic and stable knowledge local', () => {", "test('unified router keeps deterministic local but grounds factual knowledge', () => {"),
        ("assert.equal(worker.classifyTurn('RAMとSSDの違いを短く説明して', []).mode, 'casual');", "assert.equal(worker.classifyTurn('RAMとSSDの違いを短く説明して', []).mode, 'external');"),
    ],
    'tests/v45-unified-router.test.mjs': [
        ("test('stable knowledge and conversation remain local', () => {", "test('factual knowledge is grounded while conversation and memory remain local', () => {"),
        ("assert.equal(router.shouldSearchByDefault('RAMとSSDの違いを説明して'), false);", "assert.equal(router.shouldSearchByDefault('RAMとSSDの違いを説明して'), true);"),
        ("assert.equal(router.shouldSearchByDefault('HTTP 404って何？'), false);", "assert.equal(router.shouldSearchByDefault('HTTP 404って何？'), true);"),
    ],
}
for name, replacements in changes.items():
    p = Path(name)
    text = p.read_text()
    for old, new in replacements:
        text = rep(text, old, new, f'{name}: {old[:45]}')
    p.write_text(text)

print('fixed v54 evidence-first routing and regression expectations')

from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one match, found {count}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


# Grounding evidence: citation-span gaps are a retry signal, not a user-facing refusal.
path = 'src/grounding-evidence-gate.js'
replace_once(
    path,
    "export const GROUNDING_EVIDENCE_REVISION = 'talksys-grounding-evidence-v110-r1';",
    "export const GROUNDING_EVIDENCE_REVISION = 'talksys-grounding-evidence-v112-soft-coverage-r1';",
)
replace_once(
    path,
    "export const GROUNDING_FAIL_CLOSED_ANSWER =\n  '確認できる根拠を十分に取得できなかったため、推測では答えません。もう一度お尋ねいただければ再確認します。';",
    "export const GROUNDING_FAIL_CLOSED_ANSWER =\n  '検索結果から確認できる情報を取得できませんでした。条件を変えてもう一度確認してください。';",
)
replace_once(path, "  const reasons = [];\n", "  const reasons = [];\n  const warnings = [];\n")
replace_once(
    path,
    "      reasons,\n    };\n  }\n",
    "      reasons,\n      warnings,\n      needsRecovery: false,\n    };\n  }\n",
)
replace_once(
    path,
    "    if (spans.length === 0) reasons.push('no_citation_spans');\n    if (unsupportedClaimCount > 0) reasons.push('unsupported_claim_segment');\n    if (unsupportedHardClaimCount > 0) reasons.push('unsupported_hard_claim');\n",
    "    if (spans.length === 0) warnings.push('no_citation_spans');\n    if (unsupportedClaimCount > 0) warnings.push('unsupported_claim_segment');\n    if (unsupportedHardClaimCount > 0) warnings.push('unsupported_hard_claim');\n",
)
replace_once(
    path,
    "    unsupportedHardClaimCount,\n    reasons: [...new Set(reasons)],\n  };\n}\n",
    "    unsupportedHardClaimCount,\n    reasons: [...new Set(reasons)],\n    warnings: [...new Set(warnings)],\n    needsRecovery: reasons.length > 0 || warnings.length > 0,\n  };\n}\n",
)

# Runtime: soft citation-coverage warnings trigger one internal recovery search,
# but only core evidence failure (no search/source/citation) can suppress the answer.
path = 'src/integrated-entry.js'
replace_once(
    path,
    "  let groundingFailClosed = groundingRequired && !groundingEvidence.passed;\n  let groundingRecoveryUsed = false;",
    "  let groundingFailClosed = groundingRequired && !groundingEvidence.passed;\n  let groundingNeedsRecovery = groundingRequired && Boolean(groundingEvidence.needsRecovery);\n  let groundingRecoveryUsed = false;",
)
replace_once(
    path,
    "  if (groundingFailClosed) {\n    const retryStarted = Date.now();",
    "  if (groundingNeedsRecovery) {\n    const retryStarted = Date.now();",
)
replace_once(
    path,
    "        evidenceReasons: recoveryEvidence.reasons,\n        transport: 'generateContent',",
    "        evidenceReasons: recoveryEvidence.reasons,\n        evidenceWarnings: recoveryEvidence.warnings || [],\n        transport: 'generateContent',",
)
replace_once(
    path,
    "        groundingFailClosed = false;\n      } else {",
    "        groundingFailClosed = false;\n        groundingNeedsRecovery = Boolean(recoveryEvidence.needsRecovery);\n      } else {",
)
replace_once(
    path,
    "        groundingFailClosed = true;\n      }\n",
    "        groundingFailClosed = true;\n        groundingNeedsRecovery = true;\n      }\n",
)
replace_once(
    path,
    "    groundingEvidenceReasons: groundingEvidence.reasons,\n    searchRetried,",
    "    groundingEvidenceReasons: groundingEvidence.reasons,\n    groundingEvidenceWarnings: groundingEvidence.warnings || [],\n    searchRetried,",
)
replace_once(
    path,
    "  // Search execution alone is not sufficient: factual turns need usable sources\n  // and citations, while dynamic/high-risk turns also need citation span coverage.\n",
    "  // Search execution alone is not sufficient: factual turns need usable sources\n  // and citations. Dynamic/high-risk citation span gaps are diagnostic/retry signals,\n  // not a blanket reason to suppress an otherwise grounded answer.\n",
)
replace_once(
    path,
    "    groundingEvidenceReasons: groundingEvidence.reasons,\n    groundingCitationCount: citationCount,",
    "    groundingEvidenceReasons: groundingEvidence.reasons,\n    groundingEvidenceWarnings: groundingEvidence.warnings || [],\n    groundingCitationCount: citationCount,",
)

# Regression contract: span gaps remain visible and recovery-worthy, but do not fail closed.
path = 'tests/grounding-evidence-gate-v110.test.mjs'
replace_once(
    path,
    "  assert.equal(GROUNDING_EVIDENCE_REVISION, 'talksys-grounding-evidence-v110-r1');",
    "  assert.equal(GROUNDING_EVIDENCE_REVISION, 'talksys-grounding-evidence-v112-soft-coverage-r1');",
)
replace_once(
    path,
    "test('uncited high-risk sentence and time are rejected even when another sentence is cited', () => {",
    "test('uncited high-risk sentence and time request recovery without blanket refusal when core evidence exists', () => {",
)
replace_once(
    path,
    "  assert.equal(report.passed, false);\n  assert.ok(report.reasons.includes('unsupported_claim_segment'));\n  assert.ok(report.reasons.includes('unsupported_hard_claim'));\n});",
    "  assert.equal(report.passed, true);\n  assert.equal(report.needsRecovery, true);\n  assert.ok(report.warnings.includes('unsupported_claim_segment'));\n  assert.ok(report.warnings.includes('unsupported_hard_claim'));\n  assert.equal(report.reasons.length, 0);\n});",
)

Path('tests/grounding-soft-refusal-v112.test.mjs').write_text("""import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');
const gate = fs.readFileSync(new URL('../src/grounding-evidence-gate.js', import.meta.url), 'utf8');

test('v112 retries citation coverage gaps internally but only core evidence failure can fail closed', () => {
  assert.match(source, /groundingNeedsRecovery = groundingRequired && Boolean\(groundingEvidence\.needsRecovery\)/);
  assert.match(source, /if \(groundingNeedsRecovery\)/);
  assert.match(source, /groundingFailClosed = groundingRequired && !finalGroundingEvidence\.passed/);
  assert.match(gate, /warnings\.push\('unsupported_hard_claim'\)/);
  assert.doesNotMatch(gate, /reasons\.push\('unsupported_hard_claim'\)/);
});

test('v112 removes the repetitive 推測では答えません refusal wording', () => {
  assert.doesNotMatch(gate, /推測では答えません/);
});
""", encoding='utf-8')

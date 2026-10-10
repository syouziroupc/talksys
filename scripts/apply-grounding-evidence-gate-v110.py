from pathlib import Path

ENTRY = Path('src/integrated-entry.js')

def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly 1 match, found {count}')
    return text.replace(old, new, 1)

entry = ENTRY.read_text(encoding='utf-8')

entry = replace_once(
    entry,
    "import { mergeProviderUsage, normalizeGeminiUsage, USAGE_TELEMETRY_REVISION } from './usage-telemetry.js';\n",
    "import { mergeProviderUsage, normalizeGeminiUsage, USAGE_TELEMETRY_REVISION } from './usage-telemetry.js';\nimport { GROUNDING_FAIL_CLOSED_ANSWER, GROUNDING_EVIDENCE_REVISION, groundingEvidenceReport } from './grounding-evidence-gate.js';\n",
    'grounding import',
)

entry = replace_once(
    entry,
    "      ? 'この回答ではGoogle検索を一度実行し、取得できた根拠だけで答えてください。根拠不足の部分だけを未確認として短く限定し、推測で埋めないでください。'\n",
    "      ? 'この回答ではまずGoogle検索を実行し、取得できた根拠だけで答えてください。最初の検索結果が質問条件を十分に裏付けない場合だけ、検索語を一度変えて追加確認してください。根拠不足の部分は推測で埋めないでください。'\n",
    'force search prompt',
)

entry = replace_once(
    entry,
    "    '検索で一部しか確認できなくても、回答全体を「確認できません」で終わらせないでください。確認できた部分を先に答え、未確認部分だけ限定してください。正しく答えられる他の部分まで捨てないでください。',\n",
    "    '検索で確認できた事実だけを答えてください。質問の中心となる事実を検索で確認できない場合は、無理に推測せず確認できないと短く伝えてください。検索で裏付けられた補足だけがある場合も、中心事実を作ってはいけません。',\n    '外部事実を答えるときは、一つの文に主要な事実を一つだけ入れてください。時刻、日付、価格、在庫、住所、電話番号、列車名や便名などの具体値は、検索結果で確認できたものだけを述べてください。',\n",
    'partial answer prompt',
)

old_catch = """  let interaction;
  try {
    interaction = await createGeminiTurnWithRegionFallback(env, body, signal, {
      allowPrevious: true,
      forceSearch: externalFactSearch,
      now,
      immediateTransit,
    });
  } catch (error) {
    if (isGeminiRegionUnavailable(error)) {
      return runCloudflareRegionalRescue(body, env, signal);
    }
    throw error;
  }
"""
new_catch = """  let interaction;
  try {
    interaction = await createGeminiTurnWithRegionFallback(env, body, signal, {
      allowPrevious: true,
      forceSearch: externalFactSearch,
      now,
      immediateTransit,
    });
  } catch (error) {
    if (isGeminiRegionUnavailable(error)) {
      if (!externalFactSearch) return runCloudflareRegionalRescue(body, env, signal);
      emitLatencyLog('gemini-factual-region-grounding-recovery', body, {
        model: GEMINI_MODEL,
        error: compact(error?.message || error, 500),
        rescue: 'gemini-generate-content-google-search',
      }, 'warn');
      interaction = {
        payload: {},
        answer: '',
        transport: 'interactions',
        regionFallback: true,
        fallbackReason: 'interactions-region-unavailable-grounded-recovery-required',
      };
    } else {
      throw error;
    }
  }
"""
entry = replace_once(entry, old_catch, new_catch, 'region fallback catch')

old_ground = """  const groundingRequired = requiresGroundedEvidence(text);
  let citationCount = interactionCitationCount(interaction.payload);
  let groundingSourceCount = interactionSources(interaction.payload).length;
  let groundingSearchPerformed = searchedInInteraction(interaction.payload);
  let groundingFailClosed = groundingRequired && !groundingSearchPerformed;
  let groundingRecoveryUsed = false;
"""
new_ground = """  const groundingRequired = Boolean(externalFactSearch || requiresGroundedEvidence(text));
  const groundingHighRisk = Boolean(
    STRICT_DYNAMIC_GROUNDING_RE.test(text)
    || TRANSIT_QUERY_RE.test(text)
    || immediateTransit
  );
  let groundingEvidence = groundingEvidenceReport({
    payload: interaction.payload,
    answer: interaction.answer,
    required: groundingRequired,
    highRisk: groundingHighRisk,
  });
  let citationCount = groundingEvidence.citationCount;
  let groundingSourceCount = groundingEvidence.sourceCount;
  let groundingSearchPerformed = groundingEvidence.searched;
  let groundingFailClosed = groundingRequired && !groundingEvidence.passed;
  let groundingRecoveryUsed = false;
"""
entry = replace_once(entry, old_ground, new_ground, 'initial evidence gate')

old_recovery = """      const recoverySearched = searchedInInteraction(recovery.payload);
      emitLatencyLog('gemini-grounding-recovery', body, {
        durationMs: searchRetryMs,
        model: GEMINI_MODEL,
        searched: recoverySearched,
        sourceCount: interactionSources(recovery.payload).length,
        transport: 'generateContent',
      }, recoverySearched ? 'log' : 'warn');
      if (recoverySearched) {
        interaction = {
          ...recovery,
          fallbackReason: 'missing-google-search-recovered',
        };
        groundingRecoveryUsed = true;
        citationCount = interactionCitationCount(interaction.payload);
        groundingSourceCount = interactionSources(interaction.payload).length;
        groundingSearchPerformed = true;
        groundingFailClosed = false;
      }
"""
new_recovery = """      const recoveryEvidence = groundingEvidenceReport({
        payload: recovery.payload,
        answer: recovery.answer,
        required: groundingRequired,
        highRisk: groundingHighRisk,
      });
      emitLatencyLog('gemini-grounding-recovery', body, {
        durationMs: searchRetryMs,
        model: GEMINI_MODEL,
        searched: recoveryEvidence.searched,
        sourceCount: recoveryEvidence.sourceCount,
        citationCount: recoveryEvidence.citationCount,
        evidencePassed: recoveryEvidence.passed,
        evidenceReasons: recoveryEvidence.reasons,
        transport: 'generateContent',
      }, recoveryEvidence.passed ? 'log' : 'warn');
      if (recoveryEvidence.passed) {
        interaction = {
          ...recovery,
          fallbackReason: 'insufficient-grounding-evidence-recovered',
        };
        groundingRecoveryUsed = true;
        groundingEvidence = recoveryEvidence;
        citationCount = recoveryEvidence.citationCount;
        groundingSourceCount = recoveryEvidence.sourceCount;
        groundingSearchPerformed = recoveryEvidence.searched;
        groundingFailClosed = false;
      } else {
        groundingEvidence = recoveryEvidence;
        citationCount = recoveryEvidence.citationCount;
        groundingSourceCount = recoveryEvidence.sourceCount;
        groundingSearchPerformed = recoveryEvidence.searched;
        groundingFailClosed = true;
      }
"""
entry = replace_once(entry, old_recovery, new_recovery, 'grounding recovery evidence')

entry = replace_once(
    entry,
    "      answer: 'この質問は現在情報の確認が必要ですが、Google検索を再試行しても根拠を取得できませんでした。確認できない内容は推測で補いません。',\n",
    "      answer: GROUNDING_FAIL_CLOSED_ANSWER,\n",
    'initial fail closed answer',
)

old_log = """    citationCount,
    groundingRequired,
    groundingFailClosed,
    searchRetried,
"""
new_log = """    citationCount,
    groundingRequired,
    groundingHighRisk,
    groundingFailClosed,
    groundingEvidencePassed: groundingEvidence.passed,
    groundingEvidenceReasons: groundingEvidence.reasons,
    searchRetried,
"""
entry = replace_once(entry, old_log, new_log, 'primary evidence telemetry')

anchor_final = """  const remainingPastDepartures = immediateTransit ? pastImmediateTransitDepartures(interaction.answer, now) : [];
  const finalQueries = interactionQueries(interaction.payload);
"""
replacement_final = """  const remainingPastDepartures = immediateTransit ? pastImmediateTransitDepartures(interaction.answer, now) : [];

  // Every repair path is gated again immediately before the answer is exposed.
  // Search execution alone is not sufficient: factual turns need usable sources
  // and citations, while dynamic/high-risk turns also need citation span coverage.
  const finalGroundingEvidence = groundingEvidenceReport({
    payload: interaction.payload,
    answer: interaction.answer,
    required: groundingRequired,
    highRisk: groundingHighRisk,
  });
  groundingEvidence = finalGroundingEvidence;
  citationCount = finalGroundingEvidence.citationCount;
  groundingSourceCount = finalGroundingEvidence.sourceCount;
  groundingSearchPerformed = finalGroundingEvidence.searched;
  groundingFailClosed = groundingRequired && !finalGroundingEvidence.passed;

  const finalQueries = interactionQueries(interaction.payload);
"""
entry = replace_once(entry, anchor_final, replacement_final, 'final evidence re-gate')

old_answer = """  let answer = simplifyForSenior(normalizeSpokenJapanese(interaction.answer));
  if (remainingPastDepartures.length > 0) {
    answer = '検索結果に発車済みの時刻しか残ったため、その時刻は案内しません。現在時刻より後の便だけを案内します。';
  }
"""
new_answer = """  let answer = simplifyForSenior(normalizeSpokenJapanese(interaction.answer));
  if (groundingFailClosed) {
    answer = GROUNDING_FAIL_CLOSED_ANSWER;
  } else if (remainingPastDepartures.length > 0) {
    answer = '検索結果に発車済みの時刻しか残ったため、その時刻は案内しません。現在時刻より後の便だけを案内します。';
  }
"""
entry = replace_once(entry, old_answer, new_answer, 'final fail close answer')

old_route = """    route: groundingRecoveryUsed
      ? 'gemini-generate-content-grounding-recovery'
      : (interactionsRegionFallback ? 'gemini-generate-content-region-fallback' : 'gemini-native-interactions'),
    planner: groundingRecoveryUsed
      ? 'gemini-grounding-recovery-v84'
      : (interactionsRegionFallback ? 'gemini-generate-content-region-fallback-v96' : 'gemini-native-personalized-v55'),
"""
new_route = """    route: groundingFailClosed
      ? 'grounding-evidence-fail-closed'
      : (groundingRecoveryUsed
        ? 'gemini-generate-content-grounding-recovery'
        : (interactionsRegionFallback ? 'gemini-generate-content-region-fallback' : 'gemini-native-interactions')),
    planner: groundingFailClosed
      ? 'gemini-grounding-evidence-v110'
      : (groundingRecoveryUsed
        ? 'gemini-grounding-recovery-v84'
        : (interactionsRegionFallback ? 'gemini-generate-content-region-fallback-v96' : 'gemini-native-personalized-v55')),
"""
entry = replace_once(entry, old_route, new_route, 'result route')

old_fields = """    groundingRequired,
    groundingCitationCount: citationCount,
    groundingSourceCount,
    groundingSearchPerformed,
    groundingFailClosed,
    temporalTransitGuard: immediateTransit,
"""
new_fields = """    groundingRequired,
    groundingHighRisk,
    groundingEvidenceRevision: GROUNDING_EVIDENCE_REVISION,
    groundingEvidencePassed: groundingEvidence.passed,
    groundingEvidenceReasons: groundingEvidence.reasons,
    groundingCitationCount: citationCount,
    groundingCitationSpanCount: groundingEvidence.citationSpanCount,
    groundingSourceCount,
    groundingSearchPerformed,
    groundingUnsupportedClaimCount: groundingEvidence.unsupportedClaimCount,
    groundingUnsupportedHardClaimCount: groundingEvidence.unsupportedHardClaimCount,
    groundingFailClosed,
    temporalTransitGuard: immediateTransit,
"""
entry = replace_once(entry, old_fields, new_fields, 'result evidence fields')

old_result_meta = """    nativeGeminiAnswerPath: true,
    nativeGoogleSearch: true,
    customTruthGateApplied: false,
    blanketFailClosed: false,
    legacyGlmExecution: false,
"""
new_result_meta = """    nativeGeminiAnswerPath: true,
    nativeGoogleSearch: true,
    groundingEvidenceGate: true,
    groundingEvidenceRevision: GROUNDING_EVIDENCE_REVISION,
    customTruthGateApplied: false,
    blanketFailClosed: false,
    legacyGlmExecution: false,
"""
entry = replace_once(entry, old_result_meta, new_result_meta, 'result gate metadata')

# Add read-only health metadata without changing legacy V46 truth-gate flags.
entry = entry.replace(
    "      genericGeminiVerification: false,\n      genericVerificationRevision: GENERIC_VERIFICATION_REVISION,\n",
    "      genericGeminiVerification: false,\n      genericVerificationRevision: GENERIC_VERIFICATION_REVISION,\n      groundingEvidenceGate: true,\n      groundingEvidenceRevision: GROUNDING_EVIDENCE_REVISION,\n",
)
entry = entry.replace(
    "        genericGeminiVerification: false,\n        genericVerificationRevision: GENERIC_VERIFICATION_REVISION,\n",
    "        genericGeminiVerification: false,\n        genericVerificationRevision: GENERIC_VERIFICATION_REVISION,\n        groundingEvidenceGate: true,\n        groundingEvidenceRevision: GROUNDING_EVIDENCE_REVISION,\n",
)

old_test_export = """  interactionCitationCount,
  isGeminiInteractionsRegionUnavailable,
"""
new_test_export = """  interactionCitationCount,
  groundingEvidenceReport,
  isGeminiInteractionsRegionUnavailable,
"""
entry = replace_once(entry, old_test_export, new_test_export, 'test export')

ENTRY.write_text(entry, encoding='utf-8')

print('Applied grounding evidence gate v110')

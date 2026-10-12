from pathlib import Path


def replace_once(path, old, new, label):
    p = Path(path)
    s = p.read_text(encoding='utf-8')
    count = s.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match in {path}, found {count}')
    p.write_text(s.replace(old, new, 1), encoding='utf-8')


def replace_all(path, old, new, label):
    p = Path(path)
    s = p.read_text(encoding='utf-8')
    count = s.count(old)
    if count < 1:
        raise SystemExit(f'{label}: expected at least one match in {path}')
    p.write_text(s.replace(old, new), encoding='utf-8')

# Make the runtime fallback match the deployed v123 sensitivity, not only Wrangler config.
replace_once(
    'src/telephony/index.js',
    "const speechThreshold=Number(env?.TELEPHONY_VAD_RMS||0.008);",
    "const speechThreshold=Number(env?.TELEPHONY_VAD_RMS||0.0045);",
    'VAD runtime fallback',
)

# Keep search telemetry honest when the forced second search returns an answer but omits metadata.
replace_once(
    'src/integrated-entry.js',
    "searched: searchedInInteraction(interaction.payload),",
    "searched: groundingRecoveryUsed || searchedInInteraction(interaction.payload),",
    'primary latency search telemetry',
)
replace_once(
    'src/integrated-entry.js',
    "fallbackReason: groundingRecoveryUsed ? 'missing-google-search-recovered' : compact(interaction?.fallbackReason || '', 160),",
    "fallbackReason: groundingRecoveryUsed ? compact(interaction?.fallbackReason || 'missing-google-search-recovered', 160) : compact(interaction?.fallbackReason || '', 160),",
    'search recovery fallback reason',
)

# v57: restored 10/10 prompt wording and second-search answer contract.
replace_once(
    'tests/gemini-generic-verification-v57.test.mjs',
    "assert.match(req.system_instruction, /まずGoogle検索を実行/);",
    "assert.match(req.system_instruction, /Google検索を一度実行/);",
    'generic prompt wording',
)

# v118/v119/v120 tests must freeze the new permanent v123 audio baseline instead of the regressed settings.
for path in [
    'tests/phone-conversation-baseline-lock-v118.test.mjs',
    'tests/phone-quality-personalization-v120.test.mjs',
    'tests/phone-second-turn-ack-zip-v119.test.mjs',
]:
    replace_all(path, r'"TELEPHONY_VAD_RMS"\s*:\s*"0\.008"', r'"TELEPHONY_VAD_RMS"\s*:\s*"0\.0045"', f'{path} VAD contract')
    replace_all(path, r'"TELEPHONY_TTS_DELIVERY"\s*:\s*"plain"', r'"TELEPHONY_TTS_DELIVERY"\s*:\s*"loud-bright"', f'{path} delivery contract')
    replace_all(path, r'"TELEPHONY_TTS_OUTPUT_GAIN_DB"\s*:\s*"0\.0"', r'"TELEPHONY_TTS_OUTPUT_GAIN_DB"\s*:\s*"3\.0"', f'{path} gain contract')

# v118 explicitly asserted the old v104 STT had no weak-speech normalization; invert it to the permanent v123 baseline.
replace_once(
    'tests/phone-conversation-baseline-lock-v118.test.mjs',
    "assert.equal(STT_REVISION, 'talksys-v104-phonetic-first-ja');\n  assert.doesNotMatch(stt, /normalizeQuietPhoneWav/);\n  assert.doesNotMatch(stt, /PHONE_STT_CONTEXT_PROMPT/);",
    "assert.equal(STT_REVISION, 'talksys-v123-phone-accessibility-phonetic-r1');\n  assert.match(stt, /normalizeQuietPhoneWav/);\n  assert.match(stt, /PHONE_STT_CONTEXT_PROMPT/);",
    'v118 STT baseline',
)

# v121: retain diagnostics but remove the obsolete answer-blocking evidence helpers from the active path.
replace_once(
    'tests/phone-grounding-profile-v121.test.mjs',
    "assert.match(block, /evidenceFailureClarification/);\n  assert.match(block, /groundingEvidenceUsable/);",
    "assert.doesNotMatch(block, /evidenceFailureClarification/);\n  assert.doesNotMatch(block, /groundingEvidenceUsable\\(/);\n  assert.match(block, /recoverySearched \\|\\| recoveryAnswer/);",
    'v121 active search contract',
)
replace_once(
    'tests/phone-grounding-profile-v121.test.mjs',
    "assert.equal(PHONE_RELEASE_VERSION, 'v122');",
    "assert.equal(PHONE_RELEASE_VERSION, 'v123');",
    'v121 release version',
)
replace_once(
    'tests/phone-grounding-profile-v121.test.mjs',
    "assert.equal(PHONE_RUNTIME_LOG_REVISION, 'talksys-phone-runtime-log-v122-r1');",
    "assert.equal(PHONE_RUNTIME_LOG_REVISION, 'talksys-phone-runtime-log-v123-r1');",
    'v121 runtime revision',
)

# v120 release/runtime assertions follow the active release while preserving the original v120 feature tests.
replace_once(
    'tests/phone-quality-personalization-v120.test.mjs',
    "assert.equal(PHONE_RELEASE_VERSION, 'v122');",
    "assert.equal(PHONE_RELEASE_VERSION, 'v123');",
    'v120 release version',
)
replace_once(
    'tests/phone-quality-personalization-v120.test.mjs',
    "assert.equal(PHONE_RUNTIME_LOG_REVISION, 'talksys-phone-runtime-log-v122-r1');",
    "assert.equal(PHONE_RUNTIME_LOG_REVISION, 'talksys-phone-runtime-log-v123-r1');",
    'v120 runtime revision',
)

# New regression: use stable route/UI markers rather than a brittle escaped-regex rendering assertion.
replace_once(
    'tests/phone-stability-baseline-v123.test.mjs',
    "assert.match(telephony, /\\/profiles\\/\\[\\^\\/\\]\\+\\/calls/);",
    "assert.match(telephony, /profileCallsMatch=url\\.pathname\\.match/);\n  assert.match(telephony, /loadProfileCalls\\(selectedPhone\\)/);",
    'profile history route assertion',
)

print('v123 r3 regression contracts finalized')

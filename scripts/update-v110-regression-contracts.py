from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one match, found {count}: {old[:100]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


def replace_all_exact(path, old, new, expected):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count != expected:
        raise SystemExit(f'{path}: expected {expected} matches, found {count}: {old[:100]!r}')
    p.write_text(text.replace(old, new), encoding='utf-8')


# Generic grounding tests: prompt wording changed from a fixed one-search instruction
# to evidence-driven search with one conditional follow-up. Grounded fixtures now carry
# an explicit citation span, otherwise v110 correctly treats them as unsupported.
path = 'tests/gemini-generic-verification-v57.test.mjs'
replace_once(path, "assert.match(req.system_instruction, /Google検索を一度実行/);", "assert.match(req.system_instruction, /まずGoogle検索を実行/);")
replace_once(
    path,
    "{ type: 'model_output', content: [{ type: 'text', text: 'A店は19時に閉店しています。' }] },",
    "{ type: 'model_output', content: [{ type: 'text', text: 'A店は19時に閉店しています。', annotations: [{ type: 'url_citation', start_index: 0, end_index: 999, url: 'https://example.com/a', title: 'A店公式' }] }] },",
)
replace_once(path, "assert.match(result.answer, /再試行/);", "assert.match(result.answer, /推測では答えません/);")

# Personalization tests: v110 intentionally removed the old 'answer something anyway'
# instruction. It now requires the central fact to be supported and permits abstention.
path = 'tests/gemini-personalization-v55.test.mjs'
replace_once(path, "assert.match(prompt, /回答全体を「確認できません」で終わらせない/);", "assert.match(prompt, /質問の中心となる事実を検索で確認できない場合/);")
replace_once(path, "assert.match(prompt, /正しく答えられる他の部分まで捨てない/);", "assert.match(prompt, /取得根拠の範囲だけで答えて/);")
replace_all_exact(path, "/Google検索を一度実行し、取得できた根拠だけで答えて/", "/まずGoogle検索を実行し、取得できた根拠だけで答えて/", 2)
replace_once(
    path,
    "{ type: 'model_output', content: [{ type: 'text', text: '**実在ショップ**を確認できました。8GBの在庫は検索結果では分かりません。' }] },",
    "{ type: 'model_output', content: [{ type: 'text', text: '**実在ショップ**を確認できました。8GBの在庫は検索結果では分かりません。', annotations: [{ type: 'url_citation', start_index: 0, end_index: 999, url: 'https://example.com/shop', title: '実在ショップ' }] }] },",
)
replace_once(
    path,
    "{ type: 'model_output', content: [{ type: 'text', text: '検索して確認した情報を案内します。' }] },",
    "{ type: 'model_output', content: [{ type: 'text', text: '検索して確認した情報を案内します。', annotations: [{ type: 'url_citation', start_index: 0, end_index: 999, url: 'https://example.com/weather', title: '天気情報' }] }] },",
)

# Split-utterance test should remain one request when the first request already has
# adequate evidence.
path = 'tests/split-utterance-context-v62.test.mjs'
replace_once(
    path,
    "{ type: 'model_output', content: [{ type: 'text', text: '確認後の回答です。' }] },",
    "{ type: 'model_output', content: [{ type: 'text', text: '確認後の回答です。', annotations: [{ type: 'url_citation', start_index: 0, end_index: 999, url: 'https://example.com/qcm1250', title: '公式互換情報' }] }] },",
)

# Transit fixtures need real evidence so the existing temporal/directional guards are
# tested after, rather than being pre-empted by the new evidence gate.
path = 'tests/temporal-transit-v56.test.mjs'
replace_once(
    path,
    "{ type: 'google_search_call', arguments: { queries: ['別府駅 大分駅 2026年9月18日 8時48分 以降 電車'] } },\n          { type: 'model_output', content: [{ type: 'text', text: '次は8時30分発です。' }] },",
    "{ type: 'google_search_call', arguments: { queries: ['別府駅 大分駅 2026年9月18日 8時48分 以降 電車'] } },\n          { type: 'google_search_result', result: [{ title: '時刻表', url: 'https://example.com/transit-bad' }] },\n          { type: 'model_output', content: [{ type: 'text', text: '次は8時30分発です。', annotations: [{ type: 'url_citation', start_index: 0, end_index: 999, url: 'https://example.com/transit-bad', title: '時刻表' }] }] },",
)
replace_once(
    path,
    "{ type: 'google_search_call', arguments: { queries: ['別府駅 大分駅 2026年9月18日 8時48分 以降 次の電車'] } },\n        { type: 'model_output', content: [{ type: 'text', text: '次は8時55分発です。' }] },",
    "{ type: 'google_search_call', arguments: { queries: ['別府駅 大分駅 2026年9月18日 8時48分 以降 次の電車'] } },\n        { type: 'google_search_result', result: [{ title: '時刻表', url: 'https://example.com/transit-fixed' }] },\n        { type: 'model_output', content: [{ type: 'text', text: '次は8時55分発です。', annotations: [{ type: 'url_citation', start_index: 0, end_index: 999, url: 'https://example.com/transit-fixed', title: '時刻表' }] }] },",
)
replace_once(
    path,
    "{ type: 'model_output', content: [{ type: 'text', text: '下りは確認できました。上りは確認できませんでした。' }] },",
    "{ type: 'model_output', content: [{ type: 'text', text: '下りは確認できました。上りは確認できませんでした。', annotations: [{ type: 'url_citation', start_index: 0, end_index: 999, url: 'https://example.com/down', title: '時刻表' }] }] },",
)
replace_once(
    path,
    "{ type: 'model_output', content: [{ type: 'text', text: '上りと下りの両方を確認できました。' }] },",
    "{ type: 'model_output', content: [{ type: 'text', text: '上りと下りの両方を確認できました。', annotations: [{ type: 'url_citation', start_index: 0, end_index: 999, url: 'https://example.com/up', title: '上り時刻表' }] }] },",
)

# Static source invariant follows the new evidence report rather than the removed
# search-executed-only condition.
path = 'tests/voice-latency-invariants.test.mjs'
replace_once(
    path,
    "  assert.match(integrated, /let groundingFailClosed = groundingRequired && !groundingSearchPerformed/);\n  assert.match(integrated, /createGeminiGenerateContentFallback/);\n  assert.match(integrated, /missing-google-search-recovered/);\n  assert.match(integrated, /Google検索を再試行しても根拠を取得できませんでした/);",
    "  assert.match(integrated, /groundingEvidenceReport/);\n  assert.match(integrated, /groundingEvidencePassed/);\n  assert.match(integrated, /createGeminiGenerateContentFallback/);\n  assert.match(integrated, /gemini-grounding-recovery/);\n  assert.match(integrated, /GROUNDING_FAIL_CLOSED_ANSWER/);",
)

print('v110 regression contracts updated')

from pathlib import Path
import runpy

patch = Path('scripts/patch_v18_5_context_memory_audio.py')
text = patch.read_text()
old_block = """replace_once(\n    'tests/voice-llm-contract.test.mjs',\n    \"  assert.match(worker, /searchSecondProgressSpeechMs: 8000/);\",\n    \"  assert.match(worker, /searchSecondProgressSpeechMs: 5500/);\",\n)\n"""
if old_block not in text:
    raise SystemExit('stale searchSecondProgress replacement block not found')
text = text.replace(old_block, '', 1)

# The original patch assumed an older web-search test title. Remove that insertion
# block and add the regression after the runtime patch with the current anchor.
start = text.find('# web-search behavior regression.')
end = text.find("Path('tests/contextual-conversation-regression.test.mjs')", start)
if start < 0 or end < 0:
    raise SystemExit('web-search regression insertion block not found')
text = text[:start] + text[end:]
patch.write_text(text)

runpy.run_path(str(patch), run_name='__main__')

# Align source-contract assertions with v18.5 runtime semantics.
p = Path('tests/voice-llm-contract.test.mjs')
t = p.read_text()
t = t.replace('SEARCH_FILLER_MIN_DELAY_MS = 650', 'SEARCH_FILLER_MIN_DELAY_MS = 320')
t = t.replace('verified-two-pass-grounded-search', 'bounded-contextual-grounded-search')
t = t.replace("  assert.match(cloudflareLlm, /質問に直接答え直してください/);\n", "  assert.match(cloudflareLlm, /deterministicRescue/);\n  assert.match(cloudflareLlm, /perModelTimeoutMs: 3800/);\n")
p.write_text(t)

# v18.4 budget regression had the old second-progress threshold.
p = Path('tests/search-budget-regression.test.mjs')
t = p.read_text().replace('searchSecondProgressSpeechMs: 8000', 'searchSecondProgressSpeechMs: 5500')
p.write_text(t)

# Add route-search regression using the current test layout.
p = Path('tests/web-search.test.mjs')
t = p.read_text()
insert = """test('travel route questions search instead of guessing from model memory', () => {\n  assert.equal(needsWebSearch('東京から前橋まで行きたいんだけど、どうやって行こうか悩んでる'), true);\n  assert.equal(needsWebSearch('新宿から松本まで電車でどう行けばいい？'), true);\n});\n\n"""
anchor = "test('ordinary knowledge questions default to web search', () => {"
if insert not in t:
    if anchor not in t:
        raise SystemExit('current web-search test insertion anchor not found')
    t = t.replace(anchor, insert + anchor, 1)
p.write_text(t)

# The broader contract also encoded the old no-context policy; flip explicit markers.
p = Path('tests/gemini-live-contract.test.mjs')
t = p.read_text()
t = t.replace('crossTurnContext: false', 'crossTurnContext: true')
t = t.replace('warm-transport-only-no-prompt-history', 'connection-scoped-short-term-context')
p.write_text(t)

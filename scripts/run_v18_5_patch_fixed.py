from pathlib import Path
import runpy

patch = Path('scripts/patch_v18_5_context_memory_audio.py')
text = patch.read_text()
old_block = """replace_once(\n    'tests/voice-llm-contract.test.mjs',\n    \"  assert.match(worker, /searchSecondProgressSpeechMs: 8000/);\",\n    \"  assert.match(worker, /searchSecondProgressSpeechMs: 5500/);\",\n)\n"""
if old_block not in text:
    raise SystemExit('stale searchSecondProgress replacement block not found')
patch.write_text(text.replace(old_block, '', 1))

runpy.run_path(str(patch), run_name='__main__')

# Align the remaining source-contract assertions with v18.5 runtime semantics.
p = Path('tests/voice-llm-contract.test.mjs')
t = p.read_text()
t = t.replace('SEARCH_FILLER_MIN_DELAY_MS = 650', 'SEARCH_FILLER_MIN_DELAY_MS = 320')
t = t.replace('verified-two-pass-grounded-search', 'bounded-contextual-grounded-search')
p.write_text(t)

# The broader contract also encoded the old no-context policy; flip only explicit v18 revision/context markers.
p = Path('tests/gemini-live-contract.test.mjs')
t = p.read_text()
t = t.replace('crossTurnContext: false', 'crossTurnContext: true')
t = t.replace('warm-transport-only-no-prompt-history', 'connection-scoped-short-term-context')
p.write_text(t)

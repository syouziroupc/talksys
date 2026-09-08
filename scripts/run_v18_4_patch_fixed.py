from pathlib import Path
import runpy

path = Path('scripts/patch_v18_4_bounded_search.py')
text = path.read_text()
old = """replace_once(\n    'src/search-orchestrator.js',\n    '  const models = [...new Set([GROUNDING_VOICE_MODEL, GROUNDING_FALLBACK_MODEL].filter(Boolean))];\\n',\n    '  const models = [...new Set([GROUNDING_FALLBACK_MODEL, GROUNDING_VOICE_MODEL].filter(Boolean))];\\n',\n)\n# Replace the second occurrence (coverage) too.\nreplace_once(\n    'src/search-orchestrator.js',\n    '  const models = [...new Set([GROUNDING_VOICE_MODEL, GROUNDING_FALLBACK_MODEL].filter(Boolean))];\\n',\n    '  const models = [...new Set([GROUNDING_FALLBACK_MODEL, GROUNDING_VOICE_MODEL].filter(Boolean))];\\n',\n)\n"""
new = """p = Path('src/search-orchestrator.js')\nt = p.read_text()\nold_models = '  const models = [...new Set([GROUNDING_VOICE_MODEL, GROUNDING_FALLBACK_MODEL].filter(Boolean))];\\n'\nnew_models = '  const models = [...new Set([GROUNDING_FALLBACK_MODEL, GROUNDING_VOICE_MODEL].filter(Boolean))];\\n'\ncount = t.count(old_models)\nif count != 2:\n    raise SystemExit(f'src/search-orchestrator.js: expected two model-order matches, got {count}')\np.write_text(t.replace(old_models, new_models, 2))\n"""
if old not in text:
    raise SystemExit('duplicate replacement block not found')
path.write_text(text.replace(old, new, 1))
runpy.run_path(str(path), run_name='__main__')

from pathlib import Path
p = Path('scripts/apply-v123-stability-repair.py')
s = p.read_text(encoding='utf-8')
old = '''baseline_run = replace_once(\n    baseline_run,\n    "    groundingEvidenceGate: true,\\n",\n    "    groundingEvidenceGate: false,\\n",\n    'runtime fail-closed marker',\n)\n'''
new = '''baseline_run = replace_once(\n    baseline_run,\n    "    speechOptimized: true,\\n    nativeGeminiAnswerPath: true,\\n",\n    "    speechOptimized: true,\\n    nativeGeminiAnswerPath: true,\\n    groundingEvidenceGate: false,\\n    groundingEvidenceRevision: GROUNDING_EVIDENCE_REVISION,\\n",\n    'runtime evidence observability',\n)\n'''
if s.count(old) != 1:
    raise SystemExit(f'expected one r1 runtime marker block, got {s.count(old)}')
s = s.replace(old, new, 1)
p.write_text(s, encoding='utf-8')
print('v123 patcher r2 fixed')

from pathlib import Path
p = Path('tests/phone-input-adaptation-v126.test.mjs')
s = p.read_text(encoding='utf-8')
old = "Math.sin(2 * Math.PI * 220 * i / 8000) * 260"
new = "Math.sin(2 * Math.PI * 220 * i / 8000) * 420"
if s.count(old) != 1:
    raise SystemExit(f'expected exactly one fixture amplitude, found {s.count(old)}')
p.write_text(s.replace(old, new, 1), encoding='utf-8')
print('adaptive input test fixture raised into existing active-speech range')

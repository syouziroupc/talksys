from pathlib import Path

path = Path('src/free-api-tools-v45.js')
text = path.read_text()
old = """  return clean(value, 180)\n    .replace(/^(?:現在地|ここ)\\s*/i, '')\n    .replace(/(?:まで|へ|に)(?:車|徒歩|自転車)?(?:で)?(?:行|向).*/i, '')\n    .replace(/(?:車|徒歩|自転車)(?:で)?(?:の)?(?:経路|ルート|行き方|所要時間).*/i, '')"""
new = """  return clean(value, 180)\n    .replace(/^(?:現在地|ここ)\\s*/i, '')\n    .replace(/まで.*$/i, '')\n    .replace(/(?:へ|に)(?:車|徒歩|自転車)?(?:で)?(?:行|向).*/i, '')\n    .replace(/(?:車|徒歩|自転車)(?:で)?(?:の)?(?:経路|ルート|行き方|所要時間).*/i, '')"""
if old not in text:
    raise SystemExit('route-cleaning anchor not found')
path.write_text(text.replace(old, new, 1))
print('Fixed destination suffix parsing for API routing.')

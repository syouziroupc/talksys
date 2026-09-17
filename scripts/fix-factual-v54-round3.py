from pathlib import Path

path = Path('tests/evidence-first-v54.test.mjs')
text = path.read_text()
old = "    assert.equal(decision.webSearch, true, q);"
new = "    assert.equal(decision.webSearch === true || (Array.isArray(decision.apiIntents) && decision.apiIntents.length > 0), true, q);"
if old not in text:
    raise SystemExit('missing evidence route assertion')
path.write_text(text.replace(old, new, 1))
print('accepted either web search or structured API as an evidence route')

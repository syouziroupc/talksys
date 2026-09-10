from pathlib import Path

# Fix e-Stat nested prefecture/city parsing after the first migration runs.
p = Path('src/free-api-knowledge-extra-v45.js')
s = p.read_text()
old = "function japanRegionName(text) {\n  const matches = [...clean(text, 2200).matchAll(/([一-龠ぁ-んァ-ヶー]{1,16}?(?:都|道|府|県|市|区|町|村))/g)].map((m) => m[1]);\n  return matches.at(-1) || (/(?:日本|全国)/.test(text) ? '全国' : '');\n}"
new = "function japanRegionName(text) {\n  const value = clean(text, 2200);\n  const city = value.match(/([一-龠ぁ-んァ-ヶー]{1,12}市)/g)?.at(-1);\n  const ward = value.match(/([一-龠ぁ-んァ-ヶー]{1,12}区)/g)?.at(-1);\n  const town = value.match(/([一-龠ぁ-んァ-ヶー]{1,12}町)/g)?.at(-1);\n  const village = value.match(/([一-龠ぁ-んァ-ヶー]{1,12}村)/g)?.at(-1);\n  const prefecture = value.match(/([一-龠ぁ-んァ-ヶー]{1,12}(?:都|道|府|県))/g)?.at(-1);\n  const picked = city || ward || town || village || prefecture || '';\n  if (!picked) return /(?:日本|全国)/.test(value) ? '全国' : '';\n  // If a prefecture name is glued in front of a city (e.g. 大分県別府市), keep\n  // only the most specific administrative unit.\n  return picked.replace(/^.*?(?:都|道|府|県)(?=.+(?:市|区|町|村)$)/, '');\n}"
if old not in s:
    raise SystemExit('follow-up e-Stat parser target missing')
p.write_text(s.replace(old, new, 1))

# Update old v44 regression expectations to the new v45 smoke-derived behavior.
p = Path('tests/v44-deep-search-default.test.mjs')
s = p.read_text()
s = s.replace("  assert.equal(worker.shouldSearchByDefault('バナナはおやつに入る？'), true);", "  assert.equal(worker.shouldSearchByDefault('バナナはおやつに入る？'), false);")
s = s.replace("  const firstFive = Array.from({ length: 5 }, (_, i) => engineForIndex(i));\n  assert.deepEqual(firstFive, SEARCH_PROBE_ENGINES);", "  const firstCycle = Array.from({ length: SEARCH_PROBE_ENGINES.length }, (_, i) => engineForIndex(i));\n  assert.deepEqual(firstCycle, SEARCH_PROBE_ENGINES);\n  assert.equal(SEARCH_PROBE_ENGINES.includes('google'), false);")
p.write_text(s)

print('Applied follow-up v45 smoke fixes')

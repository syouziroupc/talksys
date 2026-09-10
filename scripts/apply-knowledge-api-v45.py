from pathlib import Path

path = Path('src/worker-v44.js')
text = path.read_text()

anchor = """} from './free-api-tools-v45.js';\n"""
addition = """} from './free-api-tools-v45.js';\nimport {\n  mergeApiBundles,\n  publicKnowledgeApiRegistry,\n  runKnowledgeApiTools,\n} from './free-api-knowledge-v45.js';\n"""
if "from './free-api-knowledge-v45.js'" not in text:
    if anchor not in text:
        raise SystemExit('knowledge import anchor missing')
    text = text.replace(anchor, addition, 1)

old = """  const apiStarted = Date.now();\n  const apiBundle = await runFreeApiTools(text, history, env, requestSignal);\n  const apiMs = Date.now() - apiStarted;"""
new = """  const apiStarted = Date.now();\n  const [coreApiBundle, knowledgeApiBundle] = await Promise.all([\n    runFreeApiTools(text, history, env, requestSignal),\n    runKnowledgeApiTools(text, history, requestSignal),\n  ]);\n  const apiBundle = mergeApiBundles(coreApiBundle, knowledgeApiBundle);\n  const apiMs = Date.now() - apiStarted;"""
if old not in text:
    raise SystemExit('API execution anchor missing')
text = text.replace(old, new, 1)

old_health = '        freeApiRegistry: publicApiRegistry(),'
new_health = '        freeApiRegistry: { ...publicApiRegistry(), ...publicKnowledgeApiRegistry() },'
if old_health not in text:
    raise SystemExit('health registry anchor missing')
text = text.replace(old_health, new_health, 1)

text = text.replace(
    "const REVISION = 'talksys-v45-api-first-parallel-free-tools';",
    "const REVISION = 'talksys-v45-api-first-parallel-free-tools-knowledge';",
    1,
)

path.write_text(text)
print('Wired Crossref and World Bank free APIs into the parallel API router.')

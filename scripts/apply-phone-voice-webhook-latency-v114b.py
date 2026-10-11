from pathlib import Path

p = Path('src/telephony/index.js')
s = p.read_text(encoding='utf-8')


def replace_once(old, new, label):
    global s
    count = s.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    s = s.replace(old, new, 1)


old = "async function texmlResponse(request, env) {"
new = "async function texmlResponse(request, env, ctx) {"
if old in s:
    replace_once(old, new, 'texml signature')
elif new not in s:
    raise SystemExit('texml signature not found')

old = "  await upsertCall(env, { callId, from, to, status: 'connecting' });\n"
new = """  const persistCall = upsertCall(env, { callId, from, to, status: 'connecting' }).catch((error) => {\n    console.error(JSON.stringify({ type: 'phone_call_upsert_error', stage: 'voice-webhook', error: clean(error?.message || error, 240) }));\n  });\n  if (ctx?.waitUntil) ctx.waitUntil(persistCall);\n  else persistCall.catch(() => {});\n"""
if "stage: 'voice-webhook'" not in s:
    replace_once(old, new, 'voice webhook D1 await')

old = "if((request.method==='GET'||request.method==='POST')&&url.pathname==='/telnyx/voice')return texmlResponse(request,env);"
new = "if((request.method==='GET'||request.method==='POST')&&url.pathname==='/telnyx/voice')return texmlResponse(request,env,ctx);"
if old in s:
    replace_once(old, new, 'voice route ctx')
elif new not in s:
    raise SystemExit('voice route marker not found')

p.write_text(s, encoding='utf-8')

t = Path('tests/phone-greeting-latency-v114.test.mjs')
test = t.read_text(encoding='utf-8')
needle = """test('phone start event does not await D1 before greeting playback', async () => {\n"""
addition = """test('Telnyx voice webhook returns TeXML without waiting for D1 persistence', async () => {\n  const source = await readFile(new URL('../src/telephony/index.js', import.meta.url), 'utf8');\n  assert.doesNotMatch(source, /await upsertCall\\(env, \\{ callId, from, to, status: 'connecting' \\}\\)/);\n  assert.match(source, /ctx\\?\\.waitUntil/);\n  assert.match(source, /texmlResponse\\(request,env,ctx\\)/);\n});\n\n"""
if 'voice webhook returns TeXML without waiting for D1 persistence' not in test:
    if needle not in test:
        raise SystemExit('test insertion marker not found')
    test = test.replace(needle, addition + needle, 1)
t.write_text(test, encoding='utf-8')

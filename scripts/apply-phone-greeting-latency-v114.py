from pathlib import Path


telephony = Path('src/telephony/index.js')
s = telephony.read_text(encoding='utf-8')


def replace_once(old, new, label):
    global s
    count = s.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    s = s.replace(old, new, 1)


# Revision marker for this isolated latency change.
old = "export const TELEPHONY_OBSERVABILITY_REVISION = 'talksys-phone-latency-v90-fast-ack-r1';\n"
new = old + "export const PHONE_GREETING_LATENCY_REVISION = 'talksys-phone-greeting-latency-v114-r1';\n"
if 'PHONE_GREETING_LATENCY_REVISION' not in s:
    replace_once(old, new, 'revision marker')

# Keep greeting audio separately from acknowledgement audio. A warm Worker can reuse it
# across calls, while a cold Worker starts synthesis as soon as the media bridge exists.
old = "const phoneAckAudioCache = new Map();\nconst phoneAckAudioPromises = new Map();\n"
new = old + "const phoneGreetingAudioCache = new Map();\nconst phoneGreetingAudioPromises = new Map();\n"
if 'phoneGreetingAudioCache' not in s:
    replace_once(old, new, 'greeting cache declarations')

# Greeting prewarm/cache helper. It only prepares PCMU bytes; actual RTP/WebSocket send
# still happens after Telnyx has delivered the start event.
marker = "async function warmPhoneAckAudio(env, text, deps = {}) {\n"
if 'async function warmPhoneGreetingAudio' not in s:
    addition = """async function warmPhoneGreetingAudio(env, text, deps = {}) {\n  const greetingText = clean(text, 240);\n  if (!greetingText) return null;\n  const cached = phoneGreetingAudioCache.get(greetingText);\n  if (cached?.bytes?.byteLength) return cached;\n  if (!phoneGreetingAudioPromises.has(greetingText)) {\n    const promise = synthesizePcmu(env, greetingText, deps)\n      .then((audio) => {\n        if (audio?.bytes?.byteLength) {\n          phoneGreetingAudioCache.set(greetingText, audio);\n          while (phoneGreetingAudioCache.size > 4) {\n            const oldest = phoneGreetingAudioCache.keys().next().value;\n            phoneGreetingAudioCache.delete(oldest);\n          }\n        }\n        return phoneGreetingAudioCache.get(greetingText) || null;\n      })\n      .finally(() => { phoneGreetingAudioPromises.delete(greetingText); });\n    phoneGreetingAudioPromises.set(greetingText, promise);\n  }\n  return phoneGreetingAudioPromises.get(greetingText);\n}\n\n"""
    if marker not in s:
        raise SystemExit('warmPhoneAckAudio marker not found')
    s = s.replace(marker, addition + marker, 1)

# Start preparing the fixed greeting immediately when the WebSocket media bridge is
# constructed. This is earlier than the Telnyx start event and is safe because no audio
# is transmitted here.
old = "  trackTask(warmFastAckAudio(env,deps).then(audio=>console.log(JSON.stringify({type:'phone_fast_ack_warm',ok:Boolean(audio?.bytes?.byteLength),bytes:audio?.bytes?.byteLength||0}))).catch(error=>console.warn(JSON.stringify({type:'phone_fast_ack_warm_error',error:clean(error?.message||error,240)}))));\n\n  const finishUtterance=()=>{\n"
new = """  const greetingText=clean(env?.TELEPHONY_GREETING||'お電話ありがとうございます。フォーンズです。ご用件をどうぞ。',240);\n  const greetingAudioPromise=warmPhoneGreetingAudio(env,greetingText,deps).catch((error)=>{console.warn(JSON.stringify({type:'phone_greeting_prewarm_error',error:clean(error?.message||error,240)}));return null;});\n  trackTask(greetingAudioPromise);\n  trackTask(warmFastAckAudio(env,deps).then(audio=>console.log(JSON.stringify({type:'phone_fast_ack_warm',ok:Boolean(audio?.bytes?.byteLength),bytes:audio?.bytes?.byteLength||0}))).catch(error=>console.warn(JSON.stringify({type:'phone_fast_ack_warm_error',error:clean(error?.message||error,240)}))));\n\n  const finishUtterance=()=>{\n"""
if 'const greetingAudioPromise=warmPhoneGreetingAudio' not in s:
    replace_once(old, new, 'media bridge greeting prewarm')

# Critical-path fix: do not wait for D1 before first audio. The call row is still written,
# but persistence runs in the tracked background task. The greeting uses prepared PCMU
# when available and records first-audio timing with the existing latency logger.
old = """      await upsertCall(env,{callId,from,to,status:'active'});const greeting=clean(env?.TELEPHONY_GREETING||'お電話ありがとうございます。フォーンズです。ご用件をどうぞ。',240);\n      if(greeting&&await speak(greeting,{purpose:'greeting'})){history.push({role:'assistant',content:greeting});await appendMessage(env,callId,'assistant',greeting);}\n"""
new = """      const greetingStartedAt=Date.now(),greetingTurnId=`${clean(callId||'call',120)}-greeting`;\n      trackTask(upsertCall(env,{callId,from,to,status:'active'}).catch((error)=>console.error(JSON.stringify({type:'phone_call_upsert_error',stage:'start',error:clean(error?.message||error,240)}))));\n      queueLatency(greetingTurnId,'greeting_start',0,{revision:PHONE_GREETING_LATENCY_REVISION,prewarm:true});\n      const preparedGreeting=await greetingAudioPromise;\n      queueLatency(greetingTurnId,'greeting_prepared',Date.now()-greetingStartedAt,{cached:Boolean(preparedGreeting?.bytes?.byteLength),bytes:preparedGreeting?.bytes?.byteLength||0});\n      if(greetingText&&await speak(greetingText,{purpose:'greeting',turnId:greetingTurnId,originAt:greetingStartedAt,preparedAudio:preparedGreeting||undefined})){history.push({role:'assistant',content:greetingText});queueMessageLog('assistant',greetingText);}\n"""
if "stage:'start'" not in s:
    replace_once(old, new, 'start event critical path')

telephony.write_text(s, encoding='utf-8')

# Focused regression test. This intentionally checks architecture/invariants rather than
# reaching external TTS/Telnyx services in CI.
test = Path('tests/phone-greeting-latency-v114.test.mjs')
test.write_text("""import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFile } from 'node:fs/promises';\nimport { PHONE_GREETING_LATENCY_REVISION } from '../src/telephony/index.js';\n\ntest('v114 marks the greeting latency change', () => {\n  assert.match(PHONE_GREETING_LATENCY_REVISION, /v114/);\n});\n\ntest('phone start event does not await D1 before greeting playback', async () => {\n  const source = await readFile(new URL('../src/telephony/index.js', import.meta.url), 'utf8');\n  assert.doesNotMatch(source, /await upsertCall\\(env,\\{callId,from,to,status:'active'\\}\\)/);\n  assert.match(source, /trackTask\\(upsertCall\\(env,\\{callId,from,to,status:'active'\\}\\)/);\n});\n\ntest('greeting PCMU is prepared before the Telnyx start handler uses it', async () => {\n  const source = await readFile(new URL('../src/telephony/index.js', import.meta.url), 'utf8');\n  assert.match(source, /warmPhoneGreetingAudio/);\n  assert.match(source, /const greetingAudioPromise=warmPhoneGreetingAudio/);\n  assert.match(source, /preparedAudio:preparedGreeting\\|\\|undefined/);\n  assert.match(source, /greeting_first_pcmu/);\n});\n""", encoding='utf-8')

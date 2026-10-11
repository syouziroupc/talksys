from pathlib import Path

telephony = Path('src/telephony/index.js')
s = telephony.read_text(encoding='utf-8')


def once(old, new, label):
    global s
    count = s.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one match, got {count}')
    s = s.replace(old, new, 1)


old = "export const PHONE_PROFILE_REVISION = 'talksys-phone-profile-v115-r1';\n"
new = old + "export const PHONE_PROFILE_PRELOAD_REVISION = 'talksys-phone-profile-preload-v116a-r1';\n"
if 'PHONE_PROFILE_PRELOAD_REVISION' not in s:
    once(old, new, 'preload revision')

marker = "function profileInput(body = {}) {\n"
if 'async function loadCallerProfileForSession' not in s:
    addition = """async function loadCallerProfileForSession(env, phoneNumber) {\n  const phone = profilePhone(phoneNumber);\n  if (!phone || !(await ensureSchema(env))) return null;\n  const row = await env.TALKSYS_LOG_DB.prepare(`SELECT display_name, personalization_text, memory_text, enabled, version FROM phone_profiles WHERE phone_number=?`).bind(phone).first();\n  if (!row) return null;\n  const enabledValue = row?.enabled;\n  const versionRaw = Number(row?.version || 0);\n  return Object.freeze({\n    displayName: clean(row?.display_name || '', 80).trim(),\n    personalizationText: clean(row?.personalization_text || '', 4000).trim(),\n    memoryText: clean(row?.memory_text || '', 8000).trim(),\n    enabled: !(enabledValue === false || enabledValue === 0 || enabledValue === '0'),\n    version: Number.isFinite(versionRaw) ? Math.max(0, Math.round(versionRaw)) : 0,\n  });\n}\n\n"""
    if marker not in s:
        raise SystemExit('profileInput marker missing')
    s = s.replace(marker, addition + marker, 1)

old = "  const pendingTasks=new Set(), hpState={prevX:0,prevY:0};\n"
new = old + "  const callerProfileSession={status:'idle',phoneNumber:'',profile:null};\n"
if "const callerProfileSession={status:'idle'" not in s:
    once(old, new, 'session preload state')

old = """      const start=message.start||{},params=customParameters(start);callId=clean(params.call_id||start.call_sid||start.callSid||start.call_control_id||crypto.randomUUID(),200);from=clean(params.from||start.from||'',80);to=clean(params.to||start.to||'',80);\n      const greetingStartedAt=Date.now(),greetingTurnId=`${clean(callId||'call',120)}-greeting`;\n"""
new = """      const start=message.start||{},params=customParameters(start);callId=clean(params.call_id||start.call_sid||start.callSid||start.call_control_id||crypto.randomUUID(),200);from=clean(params.from||start.from||'',80);to=clean(params.to||start.to||'',80);\n      const profilePhoneAtStart=from,profileLoadStartedAt=Date.now(),profileTurnId=`${clean(callId||'call',120)}-profile`;\n      callerProfileSession.status='loading';callerProfileSession.phoneNumber=profilePhoneAtStart;callerProfileSession.profile=null;\n      queueLatency(profileTurnId,'profile_load_start',0,{revision:PHONE_PROFILE_PRELOAD_REVISION});\n      trackTask(loadCallerProfileForSession(env,profilePhoneAtStart).then((profile)=>{\n        if(from!==profilePhoneAtStart)return;\n        callerProfileSession.status='ready';callerProfileSession.profile=profile;\n        const elapsedMs=Date.now()-profileLoadStartedAt;\n        queueLatency(profileTurnId,'profile_load_end',elapsedMs,{revision:PHONE_PROFILE_PRELOAD_REVISION,found:Boolean(profile),enabled:Boolean(profile?.enabled),profileVersion:Number(profile?.version||0)});\n        console.log(JSON.stringify({type:'phone_profile_preload',revision:PHONE_PROFILE_PRELOAD_REVISION,status:'ready',elapsedMs:boundedMs(elapsedMs),found:Boolean(profile),enabled:Boolean(profile?.enabled),profileVersion:Number(profile?.version||0)}));\n      }).catch((error)=>{\n        if(from===profilePhoneAtStart){callerProfileSession.status='error';callerProfileSession.profile=null;}\n        const elapsedMs=Date.now()-profileLoadStartedAt;\n        queueLatency(profileTurnId,'profile_load_error',elapsedMs,{revision:PHONE_PROFILE_PRELOAD_REVISION});\n        console.warn(JSON.stringify({type:'phone_profile_preload',revision:PHONE_PROFILE_PRELOAD_REVISION,status:'error',elapsedMs:boundedMs(elapsedMs),error:clean(error?.message||error,240)}));\n      }));\n      const greetingStartedAt=Date.now(),greetingTurnId=`${clean(callId||'call',120)}-greeting`;\n"""
if "stage:'profile_load_start'" not in s and "'profile_load_start'" not in s:
    once(old, new, 'start profile preload')

telephony.write_text(s, encoding='utf-8')

test = Path('tests/phone-profile-preload-v116a.test.mjs')
test.write_text("""import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFile } from 'node:fs/promises';\nimport { PHONE_PROFILE_PRELOAD_REVISION } from '../src/telephony/index.js';\n\nconst telephony = await readFile(new URL('../src/telephony/index.js', import.meta.url), 'utf8');\nconst integrated = await readFile(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');\n\ntest('v116a revision is explicit', () => {\n  assert.match(PHONE_PROFILE_PRELOAD_REVISION, /v116a/);\n});\n\ntest('profile preload reads once from the caller number and is background tracked', () => {\n  assert.match(telephony, /async function loadCallerProfileForSession\\(env, phoneNumber\\)/);\n  assert.match(telephony, /SELECT display_name, personalization_text, memory_text, enabled, version FROM phone_profiles WHERE phone_number=\\?/);\n  assert.match(telephony, /trackTask\\(loadCallerProfileForSession\\(env,profilePhoneAtStart\\)\\.then/);\n  assert.doesNotMatch(telephony, /await\\s+loadCallerProfileForSession\\(/);\n});\n\ntest('profile preload is session-local and observable without logging profile contents', () => {\n  assert.match(telephony, /callerProfileSession=\\{status:'idle',phoneNumber:'',profile:null\\}/);\n  assert.match(telephony, /'profile_load_start'/);\n  assert.match(telephony, /'profile_load_end'/);\n  assert.match(telephony, /'profile_load_error'/);\n  const preloadLog = telephony.match(/console\\.log\\(JSON\\.stringify\\(\\{type:'phone_profile_preload'[\\s\\S]*?\\}\\)\\);/u)?.[0] || '';\n  assert.ok(preloadLog);\n  assert.doesNotMatch(preloadLog, /displayName|personalizationText|memoryText/);\n});\n\ntest('v116a does not send caller profile to TalkSys/Gemini', () => {\n  const answerStart = telephony.indexOf('async function answerWithTalkSys');\n  const answerEnd = telephony.indexOf('async function warmFastAckAudio', answerStart);\n  const answerBlock = telephony.slice(answerStart, answerEnd);\n  assert.ok(answerStart >= 0 && answerEnd > answerStart);\n  assert.doesNotMatch(answerBlock, /callerProfile|caller_profile|personalizationText|memoryText|displayName/);\n  assert.doesNotMatch(integrated, /callerProfileInstruction|CALLER_PROFILE_CONTEXT_REVISION/);\n});\n\ntest('v116a leaves the existing answer function signature intact', () => {\n  assert.match(telephony, /async function answerWithTalkSys\\(deps, text, history, signal, spokenBackchannel = '', sessionId = '', utteranceId = ''\\)/);\n});\n""", encoding='utf-8')

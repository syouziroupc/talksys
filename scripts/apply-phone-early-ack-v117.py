from pathlib import Path

telephony_path = Path('src/telephony/index.js')
test_path = Path('tests/phone-latency-fast-ack-v90.test.mjs')
new_test_path = Path('tests/phone-early-ack-v117.test.mjs')

s = telephony_path.read_text(encoding='utf-8')

revision_marker = "export const PHONE_PROFILE_PRELOAD_REVISION = 'talksys-phone-profile-preload-v116a-r1';\n"
revision_addition = revision_marker + "export const PHONE_EARLY_ACK_REVISION = 'talksys-phone-early-ack-v117-r1';\n"
if "PHONE_EARLY_ACK_REVISION" not in s:
    if revision_marker not in s:
        raise SystemExit('v116a revision marker not found')
    s = s.replace(revision_marker, revision_addition, 1)

old_fast_ack = "const FAST_ACK_TEXT = 'はい、少々お待ちください。';"
new_fast_ack = "const FAST_ACK_TEXT = 'はい。';"
if old_fast_ack in s:
    s = s.replace(old_fast_ack, new_fast_ack, 1)
elif new_fast_ack not in s:
    raise SystemExit('FAST_ACK_TEXT marker not found')

old_finalize = """    const speechEndAt=finalizedAt-Math.min(trailingSilenceMs,durationMs),turnId=`${clean(callId||'call',120)}-${myCapture}-${crypto.randomUUID().slice(0,8)}`;\n    queueLatency(turnId,'speech_end_estimate',0,{captureDurationMs:Math.round(durationMs),trailingSilenceMs});\n    queueLatency(turnId,'vad_finalize',finalizedAt-speechEndAt,{silenceTargetMs:silenceMs,trailingSilenceMs});\n    pendingSttCount+=1;\n    const task=(async()=>{\n"""
new_finalize = """    const speechEndAt=finalizedAt-Math.min(trailingSilenceMs,durationMs),turnId=`${clean(callId||'call',120)}-${myCapture}-${crypto.randomUUID().slice(0,8)}`;\n    queueLatency(turnId,'speech_end_estimate',0,{captureDurationMs:Math.round(durationMs),trailingSilenceMs});\n    queueLatency(turnId,'vad_finalize',finalizedAt-speechEndAt,{silenceTargetMs:silenceMs,trailingSilenceMs});\n    const earlyAckAudio=fastAckAudioCache;\n    const earlyAckPrepared=Boolean(earlyAckAudio?.bytes?.byteLength);\n    if(earlyAckPrepared){\n      queueLatency(turnId,'ack_cache_hit',Date.now()-speechEndAt,{text:FAST_ACK_TEXT,bytes:earlyAckAudio.bytes.byteLength,reactionKind:'pre-stt',fallback:false,early:true,revision:PHONE_EARLY_ACK_REVISION});\n      trackTask(speak(FAST_ACK_TEXT,{purpose:'ack',turnId,originAt:speechEndAt,preparedAudio:earlyAckAudio}).then((reacted)=>{\n        if(reacted){recentAckTexts=[...recentAckTexts,FAST_ACK_TEXT].slice(-2);console.log(JSON.stringify({type:'phone_fast_reaction',kind:'receipt',sourceKind:'pre-stt',text:FAST_ACK_TEXT,cached:true,fallback:false,early:true,revision:PHONE_EARLY_ACK_REVISION}));}\n        return reacted;\n      }).catch((error)=>{console.warn(JSON.stringify({type:'phone_early_ack_error',turnId,error:clean(error?.message||error,240),revision:PHONE_EARLY_ACK_REVISION}));return false;}));\n    }else{\n      queueLatency(turnId,'ack_cache_miss',Date.now()-speechEndAt,{text:FAST_ACK_TEXT,reactionKind:'pre-stt',early:true,revision:PHONE_EARLY_ACK_REVISION});\n    }\n    pendingSttCount+=1;\n    const task=(async()=>{\n"""
if "const earlyAckPrepared=Boolean(earlyAckAudio?.bytes?.byteLength);" not in s:
    if old_finalize not in s:
        raise SystemExit('finishUtterance finalize marker not found')
    s = s.replace(old_finalize, new_finalize, 1)

old_accept = "latestAcceptedCapture=myCapture;lastAcceptedUserText=stt.text;lastAcceptedUserAt=now;const myVersion=++turnVersion;abortActiveTurn();interruptPlayback();"
new_accept = "latestAcceptedCapture=myCapture;lastAcceptedUserText=stt.text;lastAcceptedUserAt=now;const myVersion=++turnVersion;abortActiveTurn();if(!earlyAckPrepared)interruptPlayback();"
if old_accept in s:
    s = s.replace(old_accept, new_accept, 1)
elif new_accept not in s:
    raise SystemExit('accepted STT interrupt marker not found')

old_ack_setup = """        const reaction=fastReaction(stt.text);\n        const ackSelection=selectPhoneAckText(reaction,phoneAckAudioCache.keys(),recentAckTexts);\n        const ackText=ackSelection.text||'';\n        const ackAudio=ackText?(ackText===FAST_ACK_TEXT?fastAckAudioCache:phoneAckAudioCache.get(ackText)):null;\n        const ackPrepared=Boolean(ackAudio?.bytes?.byteLength);\n        const spokenBackchannel=ackPrepared?ackText:'';\n"""
new_ack_setup = """        const reaction=fastReaction(stt.text);\n        const ackSelection=selectPhoneAckText(reaction,phoneAckAudioCache.keys(),recentAckTexts);\n        const ackText=earlyAckPrepared?FAST_ACK_TEXT:(ackSelection.text||'');\n        const ackAudio=earlyAckPrepared?earlyAckAudio:(ackText?(ackText===FAST_ACK_TEXT?fastAckAudioCache:phoneAckAudioCache.get(ackText)):null);\n        const ackPrepared=earlyAckPrepared||Boolean(ackAudio?.bytes?.byteLength);\n        const spokenBackchannel=ackPrepared?ackText:'';\n"""
if "const ackText=earlyAckPrepared?FAST_ACK_TEXT" not in s:
    if old_ack_setup not in s:
        raise SystemExit('post-STT ack setup marker not found')
    s = s.replace(old_ack_setup, new_ack_setup, 1)

old_warm = "if(ackSelection.warmText){const warmText=ackSelection.warmText;"
new_warm = "if(!earlyAckPrepared&&ackSelection.warmText){const warmText=ackSelection.warmText;"
if old_warm in s:
    s = s.replace(old_warm, new_warm, 1)
elif new_warm not in s:
    raise SystemExit('ack lazy warm marker not found')

old_post_ack = """        if(ackPrepared&&myVersion===turnVersion){queueLatency(turnId,'ack_cache_hit',Date.now()-speechEndAt,{text:ackText,bytes:ackAudio.bytes.byteLength,reactionKind:reaction.kind||'none',fallback:ackSelection.fallbackUsed});const reacted=await speak(ackText,{purpose:'ack',turnId,originAt:speechEndAt,preparedAudio:ackAudio});if(reacted){recentAckTexts=[...recentAckTexts,ackText].slice(-2);console.log(JSON.stringify({type:'phone_fast_reaction',kind:'receipt',sourceKind:reaction.kind,text:ackText,cached:true,fallback:ackSelection.fallbackUsed}));}}\n        else queueLatency(turnId,'ack_cache_miss',Date.now()-speechEndAt,{text:ackText||FAST_ACK_TEXT,reactionKind:reaction.kind||'none'});\n"""
new_post_ack = """        if(!earlyAckPrepared&&ackPrepared&&myVersion===turnVersion){queueLatency(turnId,'ack_cache_hit',Date.now()-speechEndAt,{text:ackText,bytes:ackAudio.bytes.byteLength,reactionKind:reaction.kind||'none',fallback:ackSelection.fallbackUsed});const reacted=await speak(ackText,{purpose:'ack',turnId,originAt:speechEndAt,preparedAudio:ackAudio});if(reacted){recentAckTexts=[...recentAckTexts,ackText].slice(-2);console.log(JSON.stringify({type:'phone_fast_reaction',kind:'receipt',sourceKind:reaction.kind,text:ackText,cached:true,fallback:ackSelection.fallbackUsed}));}}\n        else if(!earlyAckPrepared)queueLatency(turnId,'ack_cache_miss',Date.now()-speechEndAt,{text:ackText||FAST_ACK_TEXT,reactionKind:reaction.kind||'none'});\n"""
if "if(!earlyAckPrepared&&ackPrepared&&myVersion===turnVersion)" not in s:
    if old_post_ack not in s:
        raise SystemExit('post-STT ack playback marker not found')
    s = s.replace(old_post_ack, new_post_ack, 1)

telephony_path.write_text(s, encoding='utf-8')

t = test_path.read_text(encoding='utf-8')
old_test = """test('phone latency v90 uses a prewarmed PCMU receipt acknowledgement only after confirmed STT', () => {\n  assert.match(source, /const\\s+FAST_ACK_TEXT\\s*=\\s*'はい、少々お待ちください。'/);\n  assert.match(source, /warmFastAckAudio/);\n  assert.match(source, /fastAckAudioCache/);\n  assert.match(source, /ack_cache_hit/);\n  assert.match(source, /ack_cache_miss/);\n  const sttEnd = source.search(/queueLatency\\(turnId,\\s*'stt_end'/);\n  const ackHit = source.search(/queueLatency\\(turnId,\\s*'ack_cache_hit'/);\n  assert.ok(sttEnd >= 0 && ackHit > sttEnd, 'receipt ack must only occur after successful STT');\n});\n"""
new_test = """test('phone latency v90/v117 uses a prewarmed PCMU receipt acknowledgement before confirmed STT when cache is ready', () => {\n  assert.match(source, /const\\s+FAST_ACK_TEXT\\s*=\\s*'はい。'/);\n  assert.match(source, /warmFastAckAudio/);\n  assert.match(source, /fastAckAudioCache/);\n  assert.match(source, /earlyAckPrepared/);\n  assert.match(source, /ack_cache_hit/);\n  assert.match(source, /ack_cache_miss/);\n  const sttStart = source.search(/queueLatency\\(turnId,\\s*'stt_start'/);\n  const ackHit = source.search(/queueLatency\\(turnId,\\s*'ack_cache_hit'/);\n  assert.ok(sttStart >= 0 && ackHit >= 0 && ackHit < sttStart, 'cached receipt ack must be dispatched before STT wait');\n});\n"""
if new_test not in t:
    if old_test not in t:
        raise SystemExit('v90 ack contract test marker not found')
    t = t.replace(old_test, new_test, 1)
test_path.write_text(t, encoding='utf-8')

new_test_path.write_text(r"""import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PHONE_EARLY_ACK_REVISION } from '../src/telephony/index.js';

const source = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');

test('v117 early acknowledgement revision is explicit and uses the fixed short receipt cue', () => {
  assert.match(PHONE_EARLY_ACK_REVISION, /v117/);
  assert.match(source, /const\s+FAST_ACK_TEXT\s*=\s*'はい。'/);
});

test('v117 dispatches cached acknowledgement at VAD finalize without awaiting Whisper', () => {
  const vad = source.search(/queueLatency\(turnId,\s*'vad_finalize'/);
  const ack = source.search(/queueLatency\(turnId,\s*'ack_cache_hit'/);
  const stt = source.search(/queueLatency\(turnId,\s*'stt_start'/);
  assert.ok(vad >= 0 && ack > vad && stt > ack, 'VAD -> cached ack -> STT order must be preserved');
  assert.match(source, /trackTask\(speak\(FAST_ACK_TEXT,\{purpose:'ack',turnId,originAt:speechEndAt,preparedAudio:earlyAckAudio\}\)\.then/);
});

test('v117 does not replay a transcript-dependent acknowledgement after early acknowledgement', () => {
  assert.match(source, /if\(!earlyAckPrepared&&ackPrepared&&myVersion===turnVersion\)/);
  assert.match(source, /else if\(!earlyAckPrepared\)queueLatency\(turnId,'ack_cache_miss'/);
  assert.match(source, /const spokenBackchannel=ackPrepared\?ackText:''/);
});

test('v117 preserves interruption and answer paths while avoiding self-interrupt of the early acknowledgement', () => {
  assert.match(source, /abortActiveTurn\(\);if\(!earlyAckPrepared\)interruptPlayback\(\);/);
  assert.match(source, /streamPcmu20ms\(audio\.bytes/);
  assert.match(source, /answerWithTalkSys\(deps,stt\.text,history,controller\.signal,spokenBackchannel,callId,turnId\)/);
});
""", encoding='utf-8')

print('phone early ack v117 patch applied')

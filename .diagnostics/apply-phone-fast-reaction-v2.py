from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)


path = Path('src/telephony/index.js')
source = path.read_text()

source = replace_once(
    source,
    "const FRAME_MS = 20;\nconst FAST_ACK_TEXT = 'はい。';\nlet schemaPromise;\nlet fastAckAudioCache = null;\nlet fastAckAudioPromise = null;\n",
    """const FRAME_MS = 20;
const FAST_ACK_TEXT = 'はい。';
export const PHONE_FAST_ACK_REVISION = 'talksys-phone-fast-ack-v2-r1';
const PHONE_ACK_VARIANTS = Object.freeze({
  lookup: Object.freeze([
    'はい、少し調べますね。',
    '関連情報を確認しますね。',
    '最新の情報を確認してみますね。',
    '少し検索して確かめますね。',
  ]),
  request: Object.freeze([
    'はい、内容を確認しますね。',
    'わかりました。少し確認しますね。',
    '承知しました。内容を見てみますね。',
  ]),
  question: Object.freeze([
    'はい、確認してお答えしますね。',
    'そうですね。少し確認しますね。',
    'わかりました。確認してみますね。',
  ]),
  listening: Object.freeze([
    'はい、お話はわかりました。少し確認しますね。',
    'はい、内容を確認しています。',
    'わかりました。少し整理してみますね。',
  ]),
});
const PHONE_ACK_PRIMARY_TEXTS = Object.freeze(Object.values(PHONE_ACK_VARIANTS).map((variants) => variants[0]));
let schemaPromise;
let fastAckAudioCache = null;
let fastAckAudioPromise = null;
const phoneAckAudioCache = new Map();
const phoneAckAudioPromises = new Map();

function phoneAckVariantsFor(reaction = {}) {
  if (!reaction?.shouldSpeak || reaction?.terminal) return [FAST_ACK_TEXT];
  const variants = PHONE_ACK_VARIANTS[reaction?.kind];
  return Array.isArray(variants) && variants.length ? [...variants] : [FAST_ACK_TEXT];
}

export function selectPhoneAckText(reaction = {}, cachedTexts = [], recentTexts = []) {
  const cached = new Set(Array.from(cachedTexts || []).map((value) => String(value || '')).filter(Boolean));
  const recent = new Set(Array.from(recentTexts || []).slice(-2).map((value) => String(value || '')).filter(Boolean));
  const variants = phoneAckVariantsFor(reaction);
  const selected = variants.find((text) => cached.has(text) && !recent.has(text))
    || variants.find((text) => cached.has(text))
    || (cached.has(FAST_ACK_TEXT) ? FAST_ACK_TEXT : '');
  const warmText = variants.find((text) => text !== selected && !cached.has(text)) || '';
  return {
    kind: String(reaction?.kind || 'none'),
    text: selected,
    warmText,
    fallbackUsed: Boolean(selected === FAST_ACK_TEXT && variants[0] !== FAST_ACK_TEXT),
  };
}
""",
    'ack constants and selector',
)

old_warm = """async function warmFastAckAudio(env, deps = {}) {
  if (fastAckAudioCache?.bytes?.byteLength) return fastAckAudioCache;
  if (!fastAckAudioPromise) {
    fastAckAudioPromise = synthesizePcmu(env, FAST_ACK_TEXT, deps)
      .then((audio) => { if (audio?.bytes?.byteLength) fastAckAudioCache = audio; return fastAckAudioCache; })
      .finally(() => { fastAckAudioPromise = null; });
  }
  return fastAckAudioPromise;
}
"""
new_warm = """async function warmFastAckAudio(env, deps = {}) {
  if (fastAckAudioCache?.bytes?.byteLength) return fastAckAudioCache;
  if (!fastAckAudioPromise) {
    fastAckAudioPromise = synthesizePcmu(env, FAST_ACK_TEXT, deps)
      .then((audio) => {
        if (audio?.bytes?.byteLength) {
          fastAckAudioCache = audio;
          phoneAckAudioCache.set(FAST_ACK_TEXT, audio);
        }
        return fastAckAudioCache;
      })
      .finally(() => { fastAckAudioPromise = null; });
  }
  return fastAckAudioPromise;
}

async function warmPhoneAckAudio(env, text, deps = {}) {
  const ackText = clean(text, 240);
  if (!ackText) return null;
  if (ackText === FAST_ACK_TEXT) return warmFastAckAudio(env, deps);
  const cached = phoneAckAudioCache.get(ackText);
  if (cached?.bytes?.byteLength) return cached;
  if (!phoneAckAudioPromises.has(ackText)) {
    const promise = synthesizePcmu(env, ackText, deps)
      .then((audio) => {
        if (audio?.bytes?.byteLength) phoneAckAudioCache.set(ackText, audio);
        return phoneAckAudioCache.get(ackText) || null;
      })
      .finally(() => { phoneAckAudioPromises.delete(ackText); });
    phoneAckAudioPromises.set(ackText, promise);
  }
  return phoneAckAudioPromises.get(ackText);
}

async function warmPhoneAckPrimaries(env, deps = {}) {
  await warmFastAckAudio(env, deps);
  const settled = await Promise.allSettled(PHONE_ACK_PRIMARY_TEXTS.map((text) => warmPhoneAckAudio(env, text, deps)));
  return settled.filter((result) => result.status === 'fulfilled' && result.value?.bytes?.byteLength).length;
}
"""
source = replace_once(source, old_warm, new_warm, 'ack warm functions')

source = replace_once(
    source,
    "  let noiseFloor=Math.max(0.0015,Math.min(0.02,speechThreshold*0.45)), speechHits=0, bargeHits=0, captureSeq=0, latestAcceptedCapture=0, turnVersion=0, activeTurnAbort=null, pendingSttCount=0, lastAcceptedUserText='', lastAcceptedUserAt=0;\n",
    "  let noiseFloor=Math.max(0.0015,Math.min(0.02,speechThreshold*0.45)), speechHits=0, bargeHits=0, captureSeq=0, latestAcceptedCapture=0, turnVersion=0, activeTurnAbort=null, pendingSttCount=0, lastAcceptedUserText='', lastAcceptedUserAt=0, recentAckTexts=[];\n",
    'recent ack state',
)

old_turn = """        const reaction=fastReaction(stt.text);
        const ackPrepared=Boolean(fastAckAudioCache?.bytes?.byteLength);
        const spokenBackchannel=ackPrepared?FAST_ACK_TEXT:'';
        const turnStartedAt=Date.now();queueLatency(turnId,'turn_start',turnStartedAt-speechEndAt,{reactionKind:reaction.kind||'none',ackPrepared});
        const turnPromise=answerWithTalkSys(deps,stt.text,history,controller.signal,spokenBackchannel,callId,turnId);
        if(ackPrepared&&myVersion===turnVersion){queueLatency(turnId,'ack_cache_hit',Date.now()-speechEndAt,{text:FAST_ACK_TEXT,bytes:fastAckAudioCache.bytes.byteLength});const reacted=await speak(FAST_ACK_TEXT,{purpose:'ack',turnId,originAt:speechEndAt,preparedAudio:fastAckAudioCache});if(reacted)console.log(JSON.stringify({type:'phone_fast_reaction',kind:'receipt',sourceKind:reaction.kind,text:FAST_ACK_TEXT,cached:true}));}
        else queueLatency(turnId,'ack_cache_miss',Date.now()-speechEndAt,{text:FAST_ACK_TEXT});
"""
new_turn = """        const reaction=fastReaction(stt.text);
        const ackSelection=selectPhoneAckText(reaction,phoneAckAudioCache.keys(),recentAckTexts);
        const ackText=ackSelection.text||'';
        const ackAudio=ackText?(ackText===FAST_ACK_TEXT?fastAckAudioCache:phoneAckAudioCache.get(ackText)):null;
        const ackPrepared=Boolean(ackAudio?.bytes?.byteLength);
        const spokenBackchannel=ackPrepared?ackText:'';
        const turnStartedAt=Date.now();queueLatency(turnId,'turn_start',turnStartedAt-speechEndAt,{reactionKind:reaction.kind||'none',ackPrepared,ackText,ackFallback:ackSelection.fallbackUsed});
        const turnPromise=answerWithTalkSys(deps,stt.text,history,controller.signal,spokenBackchannel,callId,turnId);
        if(ackSelection.warmText){const warmText=ackSelection.warmText;trackTask(warmPhoneAckAudio(env,warmText,deps).then((audio)=>console.log(JSON.stringify({type:'phone_fast_ack_lazy_warm',kind:reaction.kind||'none',text:warmText,ok:Boolean(audio?.bytes?.byteLength)}))).catch((error)=>console.warn(JSON.stringify({type:'phone_fast_ack_lazy_warm_error',kind:reaction.kind||'none',error:clean(error?.message||error,240)}))));}
        if(ackPrepared&&myVersion===turnVersion){queueLatency(turnId,'ack_cache_hit',Date.now()-speechEndAt,{text:ackText,bytes:ackAudio.bytes.byteLength,reactionKind:reaction.kind||'none',fallback:ackSelection.fallbackUsed});const reacted=await speak(ackText,{purpose:'ack',turnId,originAt:speechEndAt,preparedAudio:ackAudio});if(reacted){recentAckTexts=[...recentAckTexts,ackText].slice(-2);console.log(JSON.stringify({type:'phone_fast_reaction',kind:'receipt',sourceKind:reaction.kind,text:ackText,cached:true,fallback:ackSelection.fallbackUsed}));}}
        else queueLatency(turnId,'ack_cache_miss',Date.now()-speechEndAt,{text:ackText||FAST_ACK_TEXT,reactionKind:reaction.kind||'none'});
"""
source = replace_once(source, old_turn, new_turn, 'ack turn selection')

old_start = """      await upsertCall(env,{callId,from,to,status:'active'});const greeting=clean(env?.TELEPHONY_GREETING||'お電話ありがとうございます。フォーンズです。ご用件をどうぞ。',240);
      if(greeting&&await speak(greeting,{purpose:'greeting'})){history.push({role:'assistant',content:greeting});await appendMessage(env,callId,'assistant',greeting);}return;
"""
new_start = """      await upsertCall(env,{callId,from,to,status:'active'});const greeting=clean(env?.TELEPHONY_GREETING||'お電話ありがとうございます。フォーンズです。ご用件をどうぞ。',240);
      if(greeting&&await speak(greeting,{purpose:'greeting'})){history.push({role:'assistant',content:greeting});await appendMessage(env,callId,'assistant',greeting);}
      trackTask(warmPhoneAckPrimaries(env,deps).then((count)=>console.log(JSON.stringify({type:'phone_fast_ack_primary_warm',revision:PHONE_FAST_ACK_REVISION,count}))).catch((error)=>console.warn(JSON.stringify({type:'phone_fast_ack_primary_warm_error',error:clean(error?.message||error,240)}))));return;
"""
source = replace_once(source, old_start, new_start, 'post-greeting primary warm')

source = replace_once(
    source,
    "    fastReaction: `Whisper確定直後の事前生成PCMU受理相槌「${FAST_ACK_TEXT}」 + Gemini本回答 / ${FAST_REACTION_REVISION}`,\n",
    "    fastReaction: `Whisper確定直後の分類別PCMU受理相槌 + Gemini本回答 / ${PHONE_FAST_ACK_REVISION} / ${FAST_REACTION_REVISION}`,\n",
    'health fast reaction description',
)

path.write_text(source)

Path('tests/phone-fast-reaction-v2.test.mjs').write_text("""import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { selectPhoneAckText, PHONE_FAST_ACK_REVISION } from '../src/telephony/index.js';

const source = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');

test('phone fast reaction v2 selects a cached category acknowledgement and avoids the recent phrase', () => {
  const reaction = { kind: 'lookup', shouldSpeak: true, terminal: false };
  const cached = ['はい。', 'はい、少し調べますね。', '関連情報を確認しますね。'];
  const selected = selectPhoneAckText(reaction, cached, ['はい、少し調べますね。']);
  assert.equal(selected.text, '関連情報を確認しますね。');
  assert.equal(selected.fallbackUsed, false);
});

test('phone fast reaction v2 falls back to the known-good receipt ack while a category phrase warms', () => {
  const reaction = { kind: 'question', shouldSpeak: true, terminal: false };
  const selected = selectPhoneAckText(reaction, ['はい。'], []);
  assert.equal(selected.text, 'はい。');
  assert.equal(selected.fallbackUsed, true);
  assert.equal(selected.warmText, 'はい、確認してお答えしますね。');
});

test('phone fast reaction v2 keeps terminal or unknown reactions on the conservative fallback', () => {
  assert.equal(selectPhoneAckText({ kind: 'thanks', shouldSpeak: true, terminal: true }, ['はい。'], []).text, 'はい。');
  assert.equal(selectPhoneAckText({ kind: 'none', shouldSpeak: false, terminal: false }, ['はい。'], []).text, 'はい。');
});

test('phone fast reaction v2 keeps answer generation concurrent with the acknowledgement and preserves transport', () => {
  assert.equal(PHONE_FAST_ACK_REVISION, 'talksys-phone-fast-ack-v2-r1');
  const turnStart = source.indexOf('const turnPromise=answerWithTalkSys');
  const ackSpeak = source.indexOf('await speak(ackText');
  assert.ok(turnStart >= 0 && ackSpeak > turnStart, 'TalkSys answer generation must start before the acknowledgement is played');
  assert.match(source, /spokenBackchannel=ackPrepared\?ackText:''/);
  assert.match(source, /streamPcmu20ms\(audio\.bytes/);
  assert.match(source, /talksys-telephony-v87-grok-pcmu-paced/);
  assert.match(source, /const FAST_ACK_TEXT = 'はい。'/);
});

test('phone fast reaction v2 uses single-flight TTS warming rather than regenerating the same phrase', () => {
  assert.match(source, /phoneAckAudioPromises\.has\(ackText\)/);
  assert.match(source, /phoneAckAudioPromises\.set\(ackText, promise\)/);
  assert.match(source, /phoneAckAudioPromises\.delete\(ackText\)/);
  assert.match(source, /warmPhoneAckPrimaries/);
  assert.match(source, /phone_fast_ack_lazy_warm/);
});
""")

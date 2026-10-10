from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)


path = Path('src/telephony/index.js')
source = path.read_text()

selector_tail = """export function selectPhoneAckText(reaction = {}, cachedTexts = [], recentTexts = []) {
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
"""
selector_new = selector_tail + """

export const PHONE_SEARCH_PROGRESS_REVISION = 'talksys-phone-search-progress-v1-r1';
const PHONE_PROGRESS_WAIT_MS = 2400;
const PHONE_PROGRESS_CACHE_MAX = 12;
const phoneProgressAudioCache = new Map();
const phoneProgressAudioPromises = new Map();

export function phoneSearchTopic(text = '') {
  let value = clean(text, 180)
    .replace(/[「」『』\"']/g, '')
    .replace(/^(?:えーと|えっと|あの|その|じゃあ|では|ちょっと|お願い(?:ですが)?)[、,\s]*/i, '')
    .replace(/[。！!？?…\s]+$/g, '');
  value = value
    .replace(/(?:を)?(?:検索|調べ|探して|探す|確認して|確認|見つけて|見つける|教えて|知りたい)(?:ください|下さい|ほしい|欲しい|みて|みる|くれる|くれますか|もらえますか|お願い(?:します)?)?$/i, '')
    .replace(/(?:は)?(?:どう|どこ|誰|いつ|何時|いくら|ありますか|あるの|ある|ですか|なの|なのか)$/i, '')
    .replace(/(?:について)$/i, '')
    .replace(/[、,。！!？?…\s]+$/g, '')
    .trim();
  if (!value || value.length < 2) return 'ご指定の内容';
  return value.length > 36 ? `${value.slice(0, 36)}…` : value;
}

export function phoneSearchProgressText(text = '') {
  const topic = phoneSearchTopic(text);
  return `いま、${topic}について調べています。少々お待ちください。`;
}
"""
source = replace_once(source, selector_tail, selector_new, 'progress helpers')

warm_anchor = """async function warmPhoneAckPrimaries(env, deps = {}) {
  await warmFastAckAudio(env, deps);
  const settled = await Promise.allSettled(PHONE_ACK_PRIMARY_TEXTS.map((text) => warmPhoneAckAudio(env, text, deps)));
  return settled.filter((result) => result.status === 'fulfilled' && result.value?.bytes?.byteLength).length;
}
"""
warm_new = warm_anchor + """

async function warmPhoneProgressAudio(env, text, deps = {}) {
  const progressText = clean(text, 240);
  if (!progressText) return null;
  const cached = phoneProgressAudioCache.get(progressText);
  if (cached?.bytes?.byteLength) return cached;
  if (!phoneProgressAudioPromises.has(progressText)) {
    const promise = synthesizePcmu(env, progressText, deps)
      .then((audio) => {
        if (audio?.bytes?.byteLength) {
          phoneProgressAudioCache.set(progressText, audio);
          while (phoneProgressAudioCache.size > PHONE_PROGRESS_CACHE_MAX) {
            const oldest = phoneProgressAudioCache.keys().next().value;
            phoneProgressAudioCache.delete(oldest);
          }
        }
        return phoneProgressAudioCache.get(progressText) || null;
      })
      .finally(() => { phoneProgressAudioPromises.delete(progressText); });
    phoneProgressAudioPromises.set(progressText, promise);
  }
  return phoneProgressAudioPromises.get(progressText);
}

async function waitForPhoneProgressAudio(promise) {
  if (!promise) return null;
  return Promise.race([
    promise.catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), PHONE_PROGRESS_WAIT_MS)),
  ]);
}
"""
source = replace_once(source, warm_anchor, warm_new, 'progress audio helpers')

old_turn = """        const reaction=fastReaction(stt.text);
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
        const turn=await turnPromise,answerReadyAt=Date.now();if(myVersion!==turnVersion||turn?.aborted)return;
"""
new_turn = """        const reaction=fastReaction(stt.text);
        const ackSelection=selectPhoneAckText(reaction,phoneAckAudioCache.keys(),recentAckTexts);
        const ackText=ackSelection.text||'';
        const ackAudio=ackText?(ackText===FAST_ACK_TEXT?fastAckAudioCache:phoneAckAudioCache.get(ackText)):null;
        const ackPrepared=Boolean(ackAudio?.bytes?.byteLength);
        const spokenBackchannel=ackPrepared?ackText:'';
        const progressEnabled=flag(env?.TELEPHONY_SEARCH_PROGRESS_ENABLED,true);
        const progressText=progressEnabled&&reaction.kind==='lookup'?phoneSearchProgressText(stt.text):'';
        const progressAudioPromise=progressText?warmPhoneProgressAudio(env,progressText,deps):null;
        if(progressAudioPromise)trackTask(progressAudioPromise.catch((error)=>{console.warn(JSON.stringify({type:'phone_search_progress_tts_error',turnId,error:clean(error?.message||error,240)}));return null;}));
        const turnStartedAt=Date.now();queueLatency(turnId,'turn_start',turnStartedAt-speechEndAt,{reactionKind:reaction.kind||'none',ackPrepared,ackText,ackFallback:ackSelection.fallbackUsed,progressPlanned:Boolean(progressText)});
        const turnPromise=answerWithTalkSys(deps,stt.text,history,controller.signal,spokenBackchannel,callId,turnId);
        if(ackSelection.warmText){const warmText=ackSelection.warmText;trackTask(warmPhoneAckAudio(env,warmText,deps).then((audio)=>console.log(JSON.stringify({type:'phone_fast_ack_lazy_warm',kind:reaction.kind||'none',text:warmText,ok:Boolean(audio?.bytes?.byteLength)}))).catch((error)=>console.warn(JSON.stringify({type:'phone_fast_ack_lazy_warm_error',kind:reaction.kind||'none',error:clean(error?.message||error,240)}))));}
        if(ackPrepared&&myVersion===turnVersion){queueLatency(turnId,'ack_cache_hit',Date.now()-speechEndAt,{text:ackText,bytes:ackAudio.bytes.byteLength,reactionKind:reaction.kind||'none',fallback:ackSelection.fallbackUsed});const reacted=await speak(ackText,{purpose:'ack',turnId,originAt:speechEndAt,preparedAudio:ackAudio});if(reacted){recentAckTexts=[...recentAckTexts,ackText].slice(-2);console.log(JSON.stringify({type:'phone_fast_reaction',kind:'receipt',sourceKind:reaction.kind,text:ackText,cached:true,fallback:ackSelection.fallbackUsed}));}}
        else queueLatency(turnId,'ack_cache_miss',Date.now()-speechEndAt,{text:ackText||FAST_ACK_TEXT,reactionKind:reaction.kind||'none'});
        if(progressText&&myVersion===turnVersion){
          queueLatency(turnId,'progress_wait_start',Date.now()-speechEndAt,{text:progressText,revision:PHONE_SEARCH_PROGRESS_REVISION});
          const progressAudio=await waitForPhoneProgressAudio(progressAudioPromise);
          if(progressAudio?.bytes?.byteLength&&myVersion===turnVersion){
            const progressed=await speak(progressText,{purpose:'progress',turnId,originAt:speechEndAt,preparedAudio:progressAudio});
            queueLatency(turnId,progressed?'progress_spoken':'progress_skipped',Date.now()-speechEndAt,{text:progressText,reason:progressed?'played':'playback_cancelled'});
          }else{
            queueLatency(turnId,'progress_skipped',Date.now()-speechEndAt,{text:progressText,reason:'not_ready_within_budget'});
          }
        }
        const turn=await turnPromise,answerReadyAt=Date.now();if(myVersion!==turnVersion||turn?.aborted)return;
"""
source = replace_once(source, old_turn, new_turn, 'lookup progress turn')

source = replace_once(
    source,
    "duplicate_suppressed:'重複発話抑制',api_usage:'API使用量',tts_usage:'TTS使用量',turn_error:'AIエラー',tts_error:'TTSエラー'",
    "duplicate_suppressed:'重複発話抑制',progress_wait_start:'検索進捗準備',progress_first_pcmu:'検索進捗 first audio',progress_complete:'検索進捗送信完了',progress_spoken:'検索進捗発話',progress_skipped:'検索進捗省略',api_usage:'API使用量',tts_usage:'TTS使用量',turn_error:'AIエラー',tts_error:'TTSエラー'",
    'progress dashboard labels',
)

source = replace_once(
    source,
    "    fastReaction: `Whisper確定直後の分類別PCMU受理相槌 + Gemini本回答 / ${PHONE_FAST_ACK_REVISION} / ${FAST_REACTION_REVISION}`,\n",
    "    fastReaction: `Whisper確定直後の分類別PCMU受理相槌 + lookup検索進捗 + Gemini本回答 / ${PHONE_FAST_ACK_REVISION} / ${PHONE_SEARCH_PROGRESS_REVISION} / ${FAST_REACTION_REVISION}`,\n",
    'health progress description',
)
path.write_text(source)

wrangler_path = Path('wrangler.jsonc')
wrangler = wrangler_path.read_text()
wrangler = replace_once(
    wrangler,
    '    "TELEPHONY_MAX_SPOKEN_CHARS": "1200"\n',
    '    "TELEPHONY_MAX_SPOKEN_CHARS": "1200",\n    "TELEPHONY_TTS_VOICE": "eve",\n    "TELEPHONY_SEARCH_PROGRESS_ENABLED": "true"\n',
    'energetic voice vars',
)
wrangler_path.write_text(wrangler)

Path('tests/phone-energetic-progress-v1.test.mjs').write_text("""import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { phoneSearchTopic, phoneSearchProgressText, PHONE_SEARCH_PROGRESS_REVISION } from '../src/telephony/index.js';
import { phoneTtsVoice } from '../src/telephony/phone-tts.js';

const telephony = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('production phone voice is explicitly switched to energetic eve', () => {
  assert.match(wrangler, /\"TELEPHONY_TTS_VOICE\"\s*:\s*\"eve\"/);
  assert.equal(phoneTtsVoice({ TELEPHONY_TTS_VOICE: 'eve' }), 'eve');
});

test('lookup progress extracts a concise topic locally without another model call', () => {
  assert.equal(phoneSearchTopic('近くの牛丼屋を探して'), '近くの牛丼屋');
  assert.equal(phoneSearchTopic('東京の天気はどう'), '東京の天気');
  assert.equal(phoneSearchTopic('iPhone 17の価格を調べてください'), 'iPhone 17の価格');
  assert.equal(phoneSearchProgressText('東京の天気はどう'), 'いま、東京の天気について調べています。少々お待ちください。');
  assert.equal(PHONE_SEARCH_PROGRESS_REVISION, 'talksys-phone-search-progress-v1-r1');
});

test('lookup progress runs after TalkSys answer generation has already started', () => {
  const turnStart = telephony.indexOf('const turnPromise=answerWithTalkSys');
  const progressSpeak = telephony.indexOf("await speak(progressText,{purpose:'progress'");
  assert.ok(turnStart >= 0 && progressSpeak > turnStart);
  assert.match(telephony, /reaction\.kind==='lookup'/);
  assert.match(telephony, /PHONE_PROGRESS_WAIT_MS = 2400/);
  assert.match(telephony, /progress_skipped/);
});

test('dynamic progress has bounded in-memory cache and single-flight generation', () => {
  assert.match(telephony, /PHONE_PROGRESS_CACHE_MAX = 12/);
  assert.match(telephony, /phoneProgressAudioPromises\.has\(progressText\)/);
  assert.match(telephony, /phoneProgressAudioPromises\.set\(progressText, promise\)/);
  assert.match(telephony, /phoneProgressAudioCache\.size > PHONE_PROGRESS_CACHE_MAX/);
});

test('phone transport and answer quality paths remain frozen', () => {
  assert.match(telephony, /talksys-telephony-v87-grok-pcmu-paced/);
  assert.match(telephony, /streamPcmu20ms\(audio\.bytes/);
  assert.match(telephony, /channel:\s*'phone'/);
  assert.match(telephony, /api_usage/);
  assert.doesNotMatch(telephony, /bidirectionalMode=\"mp3\"/);
});
""")

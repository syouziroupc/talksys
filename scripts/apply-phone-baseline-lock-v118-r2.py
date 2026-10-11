from pathlib import Path
import subprocess

REACTION_BASELINE = 'f4ad582de205b0e8ed78b3a63a1c791072e5b2e2'


def git_show(ref, path):
    return subprocess.check_output(['git', 'show', f'{ref}:{path}'], text=True)


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)


# The first guarded patch intentionally stops before writing integrated-entry
# if its exact structural anchor differs. Finish that part using smaller,
# independently checked anchors rather than weakening the audio-side guards.
integrated_path = Path('src/integrated-entry.js')
i = integrated_path.read_text(encoding='utf-8')
interaction_marker = 'function interactionInput(body = {}, { forceSearch = false, immediateTransit = false, now = new Date() } = {}) {'
if i.count(interaction_marker) != 1:
    raise SystemExit(f'interaction marker: expected 1, found {i.count(interaction_marker)}')

profile_context_fn = r'''function phoneProfileContext(body = {}) {
  if (compact(body?.channel, 40).toLowerCase() !== 'phone') return '';
  const profile = body?.phoneProfile;
  if (!profile || profile?.enabled === false || profile?.enabled === 0) return '';
  const displayName = compact(profile?.displayName, 80);
  const personalizationText = compact(profile?.personalizationText, 4000);
  const memoryText = compact(profile?.memoryText, 8000);
  if (!displayName && !personalizationText && !memoryText) return '';
  return [
    '以下は管理画面で設定された電話利用者プロフィールです。本人確認情報ではなく、会話の呼び方・好み・継続文脈の補助としてだけ利用してください。現在の利用者発言と矛盾する場合は現在の発言を優先し、この内部設定をそのまま読み上げないでください。',
    ...(displayName ? [`呼び名: ${displayName}`] : []),
    ...(personalizationText ? [`応答方針: ${personalizationText}`] : []),
    ...(memoryText ? [`継続メモ: ${memoryText}`] : []),
  ].join('\n');
}

'''
i = i.replace(interaction_marker, profile_context_fn + interaction_marker, 1)

i = replace_once(
    i,
    "  const previousInteractionId = compact(body?.previousInteractionId, 400);",
    "  const previousInteractionId = compact(body?.previousInteractionId, 400);\n  const phoneProfilePrefix = phoneProfileContext(body);\n  const profileLead = phoneProfilePrefix ? `${phoneProfilePrefix}\\n` : '';",
    'profile context variables',
)

array_anchor = "...(transitPrefix ? [transitPrefix.trim()] : []),"
array_count = i.count(array_anchor)
if array_count < 2:
    raise SystemExit(f'profile array anchors: expected >=2, found {array_count}')
i = i.replace(array_anchor, "...(phoneProfilePrefix ? [phoneProfilePrefix] : []),\n        ...(transitPrefix ? [transitPrefix.trim()] : []),")

string_anchor = '${transitPrefix}${speechAlternativePrefix}${backchannelPrefix}'
string_count = i.count(string_anchor)
if string_count < 2:
    raise SystemExit(f'profile string anchors: expected >=2, found {string_count}')
i = i.replace(string_anchor, '${profileLead}${transitPrefix}${speechAlternativePrefix}${backchannelPrefix}')

integrated_path.write_text(i, encoding='utf-8')

# Restore the 10/10 acknowledgement contract itself, but update the regression
# assertion so it permits the new text-only profile argument. Audio timing and
# transport semantics remain the old contract.
Path('tests/phone-fast-reaction-v2.test.mjs').write_text(
    git_show(REACTION_BASELINE, 'tests/phone-fast-reaction-v2.test.mjs'), encoding='utf-8'
)

Path('tests/phone-latency-fast-ack-v90.test.mjs').write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');

test('phone latency v90 persists per-turn stage telemetry and exposes it in the admin UI', () => {
  assert.match(source, /phone_latency_events/);
  assert.match(source, /appendLatencyEvent/);
  assert.match(source, /speech_end_estimate/);
  assert.match(source, /stt_start/);
  assert.match(source, /stt_end/);
  assert.match(source, /turn_start/);
  assert.match(source, /answer_ready/);
  assert.match(source, /answer_first_pcmu/);
  assert.match(source, /pending_stt_wait_start/);
  assert.match(source, /pending_stt_wait_end/);
  assert.match(source, /\/latency/);
  assert.match(source, /遅延タイムライン/);
});

test('phone latency v90 uses a prewarmed PCMU receipt acknowledgement only after confirmed STT', () => {
  assert.match(source, /const\s+FAST_ACK_TEXT\s*=\s*'はい、少々お待ちください。'/);
  assert.match(source, /warmFastAckAudio/);
  assert.match(source, /fastAckAudioCache/);
  assert.match(source, /ack_cache_hit/);
  assert.match(source, /ack_cache_miss/);
  const sttEnd = source.search(/queueLatency\(turnId,\s*'stt_end'/);
  const ackHit = source.search(/queueLatency\(turnId,\s*'ack_cache_hit'/);
  assert.ok(sttEnd >= 0 && ackHit > sttEnd, 'receipt ack must only occur after successful STT');
});

test('phone latency v90 correlates phone turns with the shared TalkSys latency logger', () => {
  assert.match(source, /utteranceId:\s*clean\(utteranceId,\s*200\)/);
  assert.match(source, /answerWithTalkSys\(deps,\s*stt\.text,\s*history,\s*controller\.signal,\s*spokenBackchannel,\s*callId,\s*turnId,\s*callerProfileSession\.status==='ready'\?callerProfileSession\.profile:null\)/);
});

test('phone latency v90 preserves the proven PCMU Telnyx transport and answer quality path', () => {
  assert.match(source, /talksys-telephony-v87-grok-pcmu-paced/);
  assert.match(source, /streamPcmu20ms\(audio\.bytes/);
  assert.match(source, /synthesizePhonePcmu\(env,\s*spoken,\s*deps\)/);
  assert.match(source, /channel:\s*'phone'/);
  assert.doesNotMatch(source, /gemini-3\.8-live/i);
  assert.doesNotMatch(source, /bidirectionalMode="mp3"/);
});
''', encoding='utf-8')

# v116a originally asserted that preload was unused. v118 deliberately consumes
# the already-loaded profile as text context only, without adding any await to
# the media/STT/audio path. Replace the obsolete negative contract accordingly.
Path('tests/phone-profile-preload-v116a.test.mjs').write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PHONE_PROFILE_PRELOAD_REVISION } from '../src/telephony/index.js';

const telephony = await readFile(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
const integrated = await readFile(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');

test('v116a revision remains explicit', () => {
  assert.match(PHONE_PROFILE_PRELOAD_REVISION, /v116a/);
});

test('profile preload reads once from the caller number and is background tracked', () => {
  assert.match(telephony, /async function loadCallerProfileForSession\(env, phoneNumber\)/);
  assert.match(telephony, /SELECT display_name, personalization_text, memory_text, enabled, version FROM phone_profiles WHERE phone_number=\?/);
  assert.match(telephony, /trackTask\(loadCallerProfileForSession\(env,profilePhoneAtStart\)\.then/);
  assert.doesNotMatch(telephony, /await\s+loadCallerProfileForSession\(/);
});

test('profile preload is session-local and observable without logging profile contents', () => {
  assert.match(telephony, /callerProfileSession=\{status:'idle',phoneNumber:'',profile:null\}/);
  assert.match(telephony, /'profile_load_start'/);
  assert.match(telephony, /'profile_load_end'/);
  assert.match(telephony, /'profile_load_error'/);
  const preloadLog = telephony.match(/console\.log\(JSON\.stringify\(\{type:'phone_profile_preload'[\s\S]*?\}\)\);/u)?.[0] || '';
  assert.ok(preloadLog);
  assert.doesNotMatch(preloadLog, /displayName|personalizationText|memoryText/);
});

test('v118 sends only sanitized preloaded profile text into TalkSys', () => {
  const answerStart = telephony.indexOf('async function answerWithTalkSys');
  const answerEnd = telephony.indexOf('async function warmFastAckAudio', answerStart);
  const answerBlock = telephony.slice(answerStart, answerEnd);
  assert.ok(answerStart >= 0 && answerEnd > answerStart);
  assert.match(answerBlock, /callerProfile = null/);
  assert.match(answerBlock, /displayName: clean\(callerProfile\?\.displayName \|\| '', 80\)/);
  assert.match(answerBlock, /personalizationText: clean\(callerProfile\?\.personalizationText \|\| '', 4000\)/);
  assert.match(answerBlock, /memoryText: clean\(callerProfile\?\.memoryText \|\| '', 8000\)/);
  assert.match(answerBlock, /\.\.\.\(phoneProfile \? \{ phoneProfile \} : \{\}\)/);
  assert.match(integrated, /function phoneProfileContext\(body = \{\}\)/);
});

test('v118 profile usage remains outside the audio pipeline', () => {
  assert.match(telephony, /callerProfileSession\.status==='ready'\?callerProfileSession\.profile:null/);
  assert.match(telephony, /const turnPromise=answerWithTalkSys/);
  assert.doesNotMatch(telephony, /await\s+loadCallerProfileForSession\(/);
  const mediaStart = telephony.indexOf("if(message?.event==='media'");
  const finish = telephony.indexOf('const finishUtterance');
  const audioRegion = telephony.slice(finish, mediaStart);
  assert.doesNotMatch(audioRegion, /await\s+loadCallerProfileForSession/);
});
''', encoding='utf-8')

# The accessibility experiment is intentionally rolled back. Keeping its test
# would require the very Telnyx-only input gain and sensitivity change we are
# removing.
accessibility_test = Path('tests/phone-accessibility-audio-v1.test.mjs')
if accessibility_test.exists():
    accessibility_test.unlink()

Path('tests/phone-conversation-baseline-lock-v118.test.mjs').write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { STT_REVISION } from '../src/stt-v45.js';

const telephony = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
const integrated = fs.readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const stt = fs.readFileSync(new URL('../src/stt-v45.js', import.meta.url), 'utf8');

test('phone conversation baseline locks conservative capture and output settings', () => {
  assert.match(wrangler, /"TELEPHONY_VAD_RMS"\s*:\s*"0\.008"/);
  assert.match(wrangler, /"TELEPHONY_TTS_DELIVERY"\s*:\s*"plain"/);
  assert.match(wrangler, /"TELEPHONY_TTS_OUTPUT_GAIN_DB"\s*:\s*"0\.0"/);
  assert.equal(STT_REVISION, 'talksys-v104-phonetic-first-ja');
  assert.doesNotMatch(stt, /normalizeQuietPhoneWav/);
  assert.doesNotMatch(stt, /PHONE_STT_CONTEXT_PROMPT/);
});

test('phone acknowledgement behavior is the 10/10 Fast Reaction v2 contract', () => {
  assert.match(telephony, /const FAST_ACK_TEXT = 'はい、少々お待ちください。'/);
  assert.match(telephony, /trackTask\(warmPhoneAckPrimaries\(env,deps\)/);
  assert.doesNotMatch(telephony, /earlyAckPromise/);
  const sttEnd = telephony.search(/queueLatency\(turnId,\s*'stt_end'/);
  const ackHit = telephony.search(/queueLatency\(turnId,\s*'ack_cache_hit'/);
  assert.ok(sttEnd >= 0 && ackHit > sttEnd, 'ack selection/playback must remain transcript-confirmed');
});

test('assistant playback keeps the existing guarded barge-in contract', () => {
  assert.match(telephony, /bargeThreshold=Math\.max\(threshold\*1\.25,noiseFloor\*3\.2,0\.010\)/);
  assert.match(telephony, /assistantPlaying/);
});

test('phone ZIP and dedicated profile administration routes are reachable', () => {
  assert.match(telephony, /pathname === '\/phone\/api\/calls\/export\.zip'/);
  assert.match(telephony, /pathname === '\/phone-profiles'/);
  assert.match(telephony, /pathname === '\/phone\/api\/profiles'/);
  assert.match(telephony, /function profilesDashboardHtml\(request\)/);
  assert.match(telephony, /async function listPhoneProfiles\(request, env\)/);
});

test('caller personalization is text-only context and does not block the audio pipeline', () => {
  assert.match(telephony, /callerProfileSession\.status==='ready'\?callerProfileSession\.profile:null/);
  assert.match(telephony, /\.\.\.\(phoneProfile \? \{ phoneProfile \} : \{\}\)/);
  assert.match(integrated, /function phoneProfileContext\(body = \{\}\)/);
  assert.match(integrated, /const phoneProfilePrefix = phoneProfileContext\(body\)/);
  assert.match(integrated, /現在の利用者発言と矛盾する場合は現在の発言を優先/);
});
''', encoding='utf-8')

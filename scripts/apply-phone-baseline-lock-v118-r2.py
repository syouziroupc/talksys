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

# Restore the 10/10 acknowledgement contracts. These explicitly prevent the
# pre-STT "always はい" rewrite from being reintroduced unnoticed.
Path('tests/phone-fast-reaction-v2.test.mjs').write_text(
    git_show(REACTION_BASELINE, 'tests/phone-fast-reaction-v2.test.mjs'), encoding='utf-8'
)
Path('tests/phone-latency-fast-ack-v90.test.mjs').write_text(
    git_show(REACTION_BASELINE, 'tests/phone-latency-fast-ack-v90.test.mjs'), encoding='utf-8'
)

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

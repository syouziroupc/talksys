from pathlib import Path
import subprocess

BASE = 'ba1c7a15220d53555c4b1a405194c3fefc831f9c'

def git_show(path: str) -> str:
    return subprocess.check_output(['git', 'show', f'{BASE}:{path}'], text=True)

def read(path: str) -> str:
    return Path(path).read_text(encoding='utf-8')

def write(path: str, text: str) -> None:
    Path(path).write_text(text, encoding='utf-8')

def block(text: str, start: str, end: str) -> str:
    a = text.index(start)
    b = text.index(end, a)
    return text[a:b]

def replace_block(text: str, start: str, end: str, new: str) -> str:
    a = text.index(start)
    b = text.index(end, a)
    return text[:a] + new + text[b:]

def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)

path = 'src/integrated-entry.js'
current = read(path)
baseline = git_show(path)

baseline_system = block(baseline, 'export function buildTalkSysSystemInstruction', 'function historyForInput')
current = replace_block(current, 'export function buildTalkSysSystemInstruction', 'function historyForInput', baseline_system)

baseline_run = block(baseline, 'export async function runGeminiTurn', 'export async function commonTalkSysTurn')
baseline_run = replace_once(
    baseline_run,
    """      if (recoverySearched) {\n        interaction = {\n          ...recovery,\n          fallbackReason: 'missing-google-search-recovered',\n        };\n        groundingRecoveryUsed = true;\n        citationCount = interactionCitationCount(interaction.payload);\n        groundingSourceCount = interactionSources(interaction.payload).length;\n        groundingSearchPerformed = true;\n        groundingFailClosed = false;\n      }""",
    """      const recoveryAnswer = compact(recovery?.answer, 12000);\n      if (recoverySearched || recoveryAnswer) {\n        interaction = {\n          ...recovery,\n          fallbackReason: recoverySearched ? 'missing-google-search-recovered' : 'forced-search-answer-without-grounding-metadata',\n        };\n        groundingRecoveryUsed = true;\n        citationCount = interactionCitationCount(interaction.payload);\n        groundingSourceCount = interactionSources(interaction.payload).length;\n        groundingSearchPerformed = recoverySearched;\n        groundingFailClosed = false;\n      }""",
    'second-search acceptance',
)
baseline_run = replace_once(
    baseline_run,
    """  if (groundingFailClosed) {\n    interaction = {\n      ...interaction,\n      answer: 'この質問は現在情報の確認が必要ですが、Google検索を再試行しても根拠を取得できませんでした。確認できない内容は推測で補いません。',\n    };\n  }""",
    """  if (groundingFailClosed) {\n    interaction = {\n      ...interaction,\n      answer: '検索サービスから結果を取得できませんでした。もう一度同じ内容を聞いてください。',\n    };\n  }""",
    'true search outage response',
)
baseline_run = replace_once(
    baseline_run,
    'const searched = searchedInInteraction(interaction.payload) || searchedInInteraction(primaryInteraction.payload);',
    'const searched = groundingRecoveryUsed || searchedInInteraction(interaction.payload) || searchedInInteraction(primaryInteraction.payload);',
    'search attempted flag',
)
baseline_run = replace_once(
    baseline_run,
    """    groundingRequired,\n    groundingCitationCount: citationCount,""",
    """    groundingRequired,\n    groundingEvidencePassed: !groundingFailClosed,\n    groundingEvidenceReasons: groundingFailClosed ? ['search-unavailable-after-retry'] : [],\n    groundingCitationCount: citationCount,\n    groundingCitationSpanCount: 0,""",
    'grounding observability fields',
)
baseline_run = replace_once(
    baseline_run,
    """    groundingSourceCount,\n    groundingSearchPerformed,\n    groundingFailClosed,""",
    """    groundingSourceCount,\n    groundingSearchPerformed,\n    groundingMetadataComplete: groundingSearchPerformed && groundingSourceCount > 0,\n    groundingFailClosed,""",
    'grounding metadata observability',
)
baseline_run = replace_once(
    baseline_run,
    "    groundingEvidenceGate: true,\n",
    "    groundingEvidenceGate: false,\n",
    'runtime fail-closed marker',
)
current = replace_block(current, 'export async function runGeminiTurn', 'export async function commonTalkSysTurn', baseline_run)

start = current.index("const JMA_AREA_ENDPOINT = ")
end_marker = "let jmaAreaCacheAt = 0;\n"
end = current.index(end_marker, start) + len(end_marker)
current = current[:start] + current[end:]
current = replace_block(current, 'export function isJmaWeatherQuestion', 'function deterministicLocationClarificationResult', '')

current = current.replace(
    "import { GROUNDING_FAIL_CLOSED_ANSWER, GROUNDING_EVIDENCE_REVISION, groundingEvidenceReport } from './grounding-evidence-gate.js';",
    "import { GROUNDING_EVIDENCE_REVISION, groundingEvidenceReport } from './grounding-evidence-gate.js';",
)
current = current.replace(
    "export const INTEGRATED_ENTRY_REVISION = 'talksys-integrated-entry-v106-grounding-recovery-r1';",
    "export const INTEGRATED_ENTRY_REVISION = 'talksys-integrated-entry-v123-search-baseline-r1';",
)
current = current.replace(
    "export const GROUNDING_ANSWER_REVISION = 'talksys-grounding-answer-v121-r1';",
    "export const GROUNDING_ANSWER_REVISION = 'talksys-search-answer-v123-r1';",
)
current = current.replace(
    "groundingEvidenceGate: true,\n      groundingEvidenceRevision: GROUNDING_EVIDENCE_REVISION,\n      verificationFailureMode: 'single-pass-grounded-fail-closed',",
    "groundingEvidenceGate: false,\n      groundingEvidenceRevision: GROUNDING_EVIDENCE_REVISION,\n      verificationFailureMode: 'search-retry-answer-v123',",
)
for line in [
    '  isJmaWeatherQuestion,\n',
    '  resolveJmaWeatherArea,\n',
    '  jmaWeatherAnswer,\n',
    '  deterministicJmaWeatherResult,\n',
]:
    current = current.replace(line, '')
if any(token in current for token in ('structured-jma-weather', 'deterministicJmaWeatherResult', 'JMA_WEATHER_REVISION')):
    raise SystemExit('JMA special-case route still present')
write(path, current)

path = 'src/stt-v45.js'
stt = git_show(path)
stt = stt.replace(
    "export const STT_REVISION = 'talksys-v105-phone-accessibility-gain-beppu-r1';",
    "export const STT_REVISION = 'talksys-v123-phone-accessibility-phonetic-r1';",
)
stt = replace_once(
    stt,
    'export const PHONE_STT_CONTEXT_PROMPT = `${JAPANESE_PHONETIC_FIRST_PROMPT} 電話では日本の地名、駅名、施設名が含まれることがあります。音声が明確に「べっぷえき」と一致する場合は「別府駅」と転写してください。似ていない音声を別府駅に置き換えないでください。`;',
    'export const PHONE_STT_CONTEXT_PROMPT = `${JAPANESE_PHONETIC_FIRST_PROMPT} 電話では日本の地名、駅名、施設名、人名、商品名などの固有名詞が含まれることがあります。聞こえた発音を優先し、音が似ているだけの日常語や別の単語へ勝手に置き換えないでください。漢字表記に確信がない固有名詞は、ひらがなまたはカタカナのまま転写してください。`;',
    'generic phone STT context',
)
if 'べっぷえき' in stt or '別府駅' in stt:
    raise SystemExit('fixed Beppu-only STT hint still present')
write(path, stt)

path = 'src/telephony/index.js'
tele = read(path)
tele = replace_once(
    tele,
    "import { PHONE_TTS_MODEL, PHONE_TTS_SAMPLE_RATE, phoneTtsVoice, streamPcmu20ms, synthesizePhonePcmu } from './phone-tts.js';",
    "import { PHONE_TTS_MODEL, PHONE_TTS_SAMPLE_RATE, phoneTtsDeliveryMode, phoneTtsOutputGainDb, phoneTtsVoice, streamPcmu20ms, synthesizePhonePcmu } from './phone-tts.js';",
    'phone TTS observability imports',
)
tele = replace_once(
    tele,
    "export const PHONE_RUNTIME_LOG_REVISION = 'talksys-phone-runtime-log-v122-r1';\nexport const PHONE_RELEASE_VERSION = 'v122';",
    "export const PHONE_RUNTIME_LOG_REVISION = 'talksys-phone-runtime-log-v123-r1';\nexport const PHONE_RELEASE_VERSION = 'v123';\nexport const PHONE_ADAPTIVE_VAD_REVISION = 'talksys-phone-adaptive-vad-v123-r1';\nexport const PHONE_VAD_START_NOISE_RATIO = 2.7;\nexport const PHONE_VAD_START_HITS = 3;\nexport const PHONE_VAD_PREROLL_FRAMES = 12;",
    'v123 release and VAD constants',
)
tele = replace_once(
    tele,
    'const PHONE_ACK_STT_GRACE_MS = 250;\n',
    """const PHONE_ACK_STT_GRACE_MS = 250;\n\nexport function phoneVadStartThreshold(baseThreshold = 0.0045, noiseFloor = 0.0015) {\n  const base = Math.max(0.001, Math.min(0.05, Number(baseThreshold) || 0.0045));\n  const noise = Math.max(0.0005, Math.min(0.03, Number(noiseFloor) || 0.0015));\n  return Math.max(base, Math.min(0.055, noise * PHONE_VAD_START_NOISE_RATIO));\n}\n\nexport function phoneVadFrameIsSpeech(rms = 0, noiseFloor = 0.0015, baseThreshold = 0.0045) {\n  const level = Math.max(0, Number(rms) || 0);\n  const noise = Math.max(0.001, Number(noiseFloor) || 0.0015);\n  return level >= phoneVadStartThreshold(baseThreshold, noiseFloor) && level / noise >= 1.6;\n}\n""",
    'adaptive VAD helpers',
)
tele = replace_once(
    tele,
    'const startThreshold=()=>Math.max(speechThreshold,Math.min(0.055,noiseFloor*2.7));',
    'const startThreshold=()=>phoneVadStartThreshold(speechThreshold,noiseFloor);',
    'adaptive VAD threshold use',
)
tele = replace_once(
    tele,
    'preRoll.push(samples);if(preRoll.length>12)preRoll.shift();',
    'preRoll.push(samples);if(preRoll.length>PHONE_VAD_PREROLL_FRAMES)preRoll.shift();',
    'VAD pre-roll constant',
)
tele = replace_once(
    tele,
    'if(rms>=threshold&&snr>=1.6)speechHits+=1;else{speechHits=0;adaptNoise(rms,false);}if(speechHits>=3){',
    'if(phoneVadFrameIsSpeech(rms,noiseFloor,speechThreshold))speechHits+=1;else{speechHits=0;adaptNoise(rms,false);}if(speechHits>=PHONE_VAD_START_HITS){',
    'adaptive VAD speech decision',
)
tele = replace_once(
    tele,
    "outputAudio: 'Cloudflare Grok TTS G.711 μ-law 8kHz → Telnyx PCMU RTP', phoneTtsModel: PHONE_TTS_MODEL,\n    phoneTtsVoice: phoneTtsVoice(env), phoneTtsSampleRate: PHONE_TTS_SAMPLE_RATE,",
    "outputAudio: 'Cloudflare Grok TTS G.711 μ-law 8kHz → Telnyx PCMU RTP', phoneTtsModel: PHONE_TTS_MODEL,\n    phoneTtsVoice: phoneTtsVoice(env), phoneTtsDelivery: phoneTtsDeliveryMode(env), phoneTtsOutputGainDb: phoneTtsOutputGainDb(env), phoneTtsSampleRate: PHONE_TTS_SAMPLE_RATE,\n    adaptiveVadRevision: PHONE_ADAPTIVE_VAD_REVISION, phoneVadBaseRms: Number(env?.TELEPHONY_VAD_RMS || 0.0045), phoneVadStartNoiseRatio: PHONE_VAD_START_NOISE_RATIO, phoneVadStartHits: PHONE_VAD_START_HITS, phoneVadPreRollMs: PHONE_VAD_PREROLL_FRAMES * FRAME_MS,",
    'phone health stability fields',
)
write(path, tele)

path = 'wrangler.jsonc'
wrangler = read(path)
wrangler = replace_once(wrangler, '"TELEPHONY_VAD_RMS": "0.008"', '"TELEPHONY_VAD_RMS": "0.0045"', 'VAD sensitivity')
wrangler = replace_once(wrangler, '"TELEPHONY_TTS_DELIVERY": "plain"', '"TELEPHONY_TTS_DELIVERY": "loud-bright"', 'TTS delivery')
wrangler = replace_once(wrangler, '"TELEPHONY_TTS_OUTPUT_GAIN_DB": "0.0"', '"TELEPHONY_TTS_OUTPUT_GAIN_DB": "3.0"', 'TTS output gain')
write(path, wrangler)

path = 'tests/gemini-generic-verification-v57.test.mjs'
generic = read(path)
generic = generic.replace(
    "test('dynamic fact asks for specific clarification only after both grounding attempts return no search evidence', async () => {",
    "test('dynamic fact keeps the second forced-search answer when grounding metadata is omitted', async () => {",
)
generic = replace_once(
    generic,
    """    assert.equal(result.groundingFailClosed, true);\n    assert.equal(result.groundingRecoveryUsed, false);\n    assert.equal(result.searchRetried, true);\n    assert.doesNotMatch(result.answer, /5点2|5点4|推測では答えません/);\n    assert.match(result.answer, /正確に確認するため/);""",
    """    assert.equal(result.groundingFailClosed, false);\n    assert.equal(result.groundingRecoveryUsed, true);\n    assert.equal(result.searchRetried, true);\n    assert.equal(result.search, true);\n    assert.equal(result.groundingMetadataComplete, false);\n    assert.match(result.answer, /5点4/);\n    assert.doesNotMatch(result.answer, /推測では答えません|正確に確認するため/);""",
    'metadata omission regression assertions',
)
write(path, generic)

jma_test = Path('tests/phone-jma-weather-v122.test.mjs')
if jma_test.exists():
    jma_test.unlink()

stability_test = r'''import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  PHONE_STT_CONTEXT_PROMPT,
  STT_REVISION,
  analyzeWav,
  normalizeQuietPhoneWav,
} from '../src/stt-v45.js';
import {
  PHONE_ADAPTIVE_VAD_REVISION,
  PHONE_RELEASE_VERSION,
  PHONE_VAD_PREROLL_FRAMES,
  PHONE_VAD_START_HITS,
  PHONE_VAD_START_NOISE_RATIO,
  phoneVadFrameIsSpeech,
  phoneVadStartThreshold,
} from '../src/telephony/index.js';
import {
  PHONE_TTS_OUTPUT_PEAK_CEILING,
  phoneTtsDeliveryMode,
  phoneTtsOutputGainDb,
  phoneTtsVoice,
} from '../src/telephony/phone-tts.js';

function pcm16Wav(samples, sampleRate = 8000) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (offset, text) => [...text].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  ascii(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, sample, true));
  return buffer;
}

test('v123 locks the high-sensitivity adaptive-noise phone VAD', () => {
  assert.equal(PHONE_RELEASE_VERSION, 'v123');
  assert.equal(PHONE_ADAPTIVE_VAD_REVISION, 'talksys-phone-adaptive-vad-v123-r1');
  assert.equal(PHONE_VAD_START_NOISE_RATIO, 2.7);
  assert.equal(PHONE_VAD_START_HITS, 3);
  assert.equal(PHONE_VAD_PREROLL_FRAMES, 12);
  assert.equal(phoneVadFrameIsSpeech(0.0065, 0.0015, 0.0045), true);
  assert.equal(phoneVadFrameIsSpeech(0.0060, 0.0045, 0.0045), false);
  assert.ok(phoneVadStartThreshold(0.0045, 0.006) > 0.015);
});

test('v123 restores weak phone speech normalization without clipping', () => {
  const samples = Array.from({ length: 1600 }, (_, i) => Math.round(Math.sin(i * 2 * Math.PI * 440 / 8000) * 190));
  const wav = pcm16Wav(samples);
  const before = analyzeWav(wav);
  const normalized = normalizeQuietPhoneWav(wav, before);
  const after = analyzeWav(normalized.buffer);
  assert.equal(before.valid, true);
  assert.ok(normalized.gain > 1 && normalized.gain <= 2.5);
  assert.ok(after.rms > before.rms);
  assert.ok(after.peak <= 0.90 + 1e-6);
  assert.ok(PHONE_TTS_OUTPUT_PEAK_CEILING <= 0.94);
});

test('v123 phone STT uses generic phonetic proper-noun guidance', () => {
  assert.equal(STT_REVISION, 'talksys-v123-phone-accessibility-phonetic-r1');
  assert.match(PHONE_STT_CONTEXT_PROMPT, /地名/);
  assert.match(PHONE_STT_CONTEXT_PROMPT, /駅名/);
  assert.match(PHONE_STT_CONTEXT_PROMPT, /施設名/);
  assert.match(PHONE_STT_CONTEXT_PROMPT, /発音/);
  assert.match(PHONE_STT_CONTEXT_PROMPT, /ひらがなまたはカタカナ/);
  assert.doesNotMatch(PHONE_STT_CONTEXT_PROMPT, /べっぷえき|別府駅/);
});

test('v123 locks bright Eve output and bounded gain in deployment config', () => {
  const config = fs.readFileSync('wrangler.jsonc', 'utf8');
  assert.match(config, /"TELEPHONY_VAD_RMS"\s*:\s*"0\.0045"/);
  assert.match(config, /"TELEPHONY_TTS_VOICE"\s*:\s*"eve"/);
  assert.match(config, /"TELEPHONY_TTS_DELIVERY"\s*:\s*"loud-bright"/);
  assert.match(config, /"TELEPHONY_TTS_OUTPUT_GAIN_DB"\s*:\s*"3\.0"/);
  const env = { TELEPHONY_TTS_VOICE: 'eve', TELEPHONY_TTS_DELIVERY: 'loud-bright', TELEPHONY_TTS_OUTPUT_GAIN_DB: '3.0' };
  assert.equal(phoneTtsVoice(env), 'eve');
  assert.equal(phoneTtsDeliveryMode(env), 'loud-bright');
  assert.equal(phoneTtsOutputGainDb(env), 3);
});

test('v123 generic search path has no JMA special-case and no citation-metadata blanket refusal', () => {
  const source = fs.readFileSync('src/integrated-entry.js', 'utf8');
  const start = source.indexOf('export async function runGeminiTurn');
  const end = source.indexOf('export async function commonTalkSysTurn', start);
  const run = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(source, /structured-jma-weather|deterministicJmaWeatherResult|JMA_WEATHER_REVISION/);
  assert.match(source, /検索で一部しか確認できなくても/);
  assert.doesNotMatch(source, /質問の中心となる事実を検索で確認できない場合/);
  assert.match(run, /recoverySearched \|\| recoveryAnswer/);
  assert.doesNotMatch(run, /groundingEvidenceUsable\(|evidenceFailureClarification\(text\)/);
  assert.doesNotMatch(run, /確認できない内容は推測で補いません/);
});

test('v123 keeps profile dirty protection and caller-scoped history UI', () => {
  const telephony = fs.readFileSync('src/telephony/index.js', 'utf8');
  assert.match(telephony, /profileDirty=true/);
  assert.match(telephony, /refreshProfile:false/);
  assert.match(telephony, /\/phone-profiles/);
  assert.match(telephony, /\/profiles\/\[\^\/\]\+\/calls/);
});
'''
write('tests/phone-stability-baseline-v123.test.mjs', stability_test)

print('v123 stability repair applied')

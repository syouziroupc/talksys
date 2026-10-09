from pathlib import Path

INDEX = Path('src/telephony/index.js')
TEST = Path('tests/telephony-integration.test.mjs')
PROTO = Path('src/telephony/protocol.js')

s = INDEX.read_text()


def one(old, new, label):
    global s
    n = s.count(old)
    if n != 1:
        raise SystemExit(f'{label}: expected exactly one match, got {n}')
    s = s.replace(old, new)


one("import { CloudflareJapaneseTTS } from '../cloudflare-japanese-tts.js';\n", "", 'remove legacy phone Melo import')
one(
    "import { bytesToBase64, pcmuBase64ToSamples, rmsOfSamples, samplesToWav } from './codec.js';",
    "import { pcmuBase64ToSamples, rmsOfSamples, samplesToWav } from './codec.js';",
    'remove phone MP3 base64 dependency',
)
one(
    "import { buildTexml, clampInt, clean, flag, xmlEscape } from './protocol.js';",
    "import { buildTexml, clampInt, clean, flag, xmlEscape } from './protocol.js';\nimport { PHONE_TTS_MODEL, PHONE_TTS_SAMPLE_RATE, phoneTtsVoice, streamPcmu20ms, synthesizePhonePcmu } from './phone-tts.js';",
    'add phone PCMU module',
)
one(
    "export const TELEPHONY_REVISION = 'talksys-telephony-v84-shared-turn-dedupe';",
    "export const TELEPHONY_REVISION = 'talksys-telephony-v87-grok-pcmu-paced';",
    'revision',
)

anchor = "async function synthesizeMp3(env, text, deps = {}) {"
if anchor not in s:
    raise SystemExit('legacy synthesizeMp3 anchor missing')
start = s.index(anchor)
end = s.index("\nfunction dashboardHtml(request)", start)
replacement = '''async function synthesizePcmu(env, text, deps = {}) {
  const spoken = clean(text, clampInt(env?.TELEPHONY_MAX_SPOKEN_CHARS, 1200, 200, 3000));
  if (!spoken) return null;
  return synthesizePhonePcmu(env, spoken, deps);
}
'''
s = s[:start] + replacement + s[end:]

one(
    "    outputAudio: 'TalkSys TTS MP3 → Telnyx',",
    "    outputAudio: 'Cloudflare Grok TTS G.711 μ-law 8kHz → Telnyx PCMU RTP',\n    phoneTtsModel: PHONE_TTS_MODEL,\n    phoneTtsVoice: phoneTtsVoice(env),\n    phoneTtsSampleRate: PHONE_TTS_SAMPLE_RATE,",
    'health output audio',
)
one(
    "  let currentMark = '';",
    "  let currentMark = '';\n  let playbackGeneration = 0;",
    'playback generation state',
)

legacy_speak = '''  const speak = async (text) => {
    const payload = await synthesizeMp3(env, text, deps);
    if (!payload || closed) return false;
    currentMark = `talksys-${crypto.randomUUID()}`;
    safeSend(telnyx, { event: 'media', media: { payload } });
    safeSend(telnyx, { event: 'mark', mark: { name: currentMark } });
    assistantPlaying = true;
    return true;
  };

  const interruptPlayback = () => {
    if (!assistantPlaying) return;
    safeSend(telnyx, { event: 'clear' });
    assistantPlaying = false;
    currentMark = '';
  };'''
new_speak = '''  const interruptPlayback = () => {
    playbackGeneration += 1;
    if (assistantPlaying || currentMark) safeSend(telnyx, { event: 'clear' });
    assistantPlaying = false;
    currentMark = '';
  };

  const speak = async (text) => {
    if (assistantPlaying || currentMark) interruptPlayback();
    const myGeneration = ++playbackGeneration;
    const startedAt = Date.now();
    let audio;
    try {
      audio = await synthesizePcmu(env, text, deps);
    } catch (error) {
      console.error(JSON.stringify({ type: 'phone_tts_error', error: clean(error?.message || error, 240) }));
      return false;
    }
    if (!audio?.bytes?.byteLength || closed || myGeneration !== playbackGeneration) return false;

    currentMark = `talksys-${crypto.randomUUID()}`;
    assistantPlaying = true;
    const streamed = await streamPcmu20ms(audio.bytes, {
      sendPayload: (payload) => safeSend(telnyx, { event: 'media', media: { payload } }),
      isCancelled: () => closed || myGeneration !== playbackGeneration,
    });
    if (!streamed.completed || closed || myGeneration !== playbackGeneration) return false;
    safeSend(telnyx, { event: 'mark', mark: { name: currentMark } });
    console.log(JSON.stringify({
      type: 'phone_tts_sent',
      ms: Date.now() - startedAt,
      frames: streamed.frames,
      bytes: streamed.sentBytes,
      provider: audio.metadata?.provider || '',
      model: audio.metadata?.model || '',
      voice: audio.metadata?.voice || '',
      codec: audio.metadata?.codec || 'PCMU',
      sampleRate: audio.metadata?.sampleRate || PHONE_TTS_SAMPLE_RATE,
      durationMs: audio.metadata?.durationMs || 0,
      rms: audio.metadata?.rms ?? null,
      peak: audio.metadata?.peak ?? null,
      silenceRatio: audio.metadata?.silenceRatio ?? null,
      gatewayKeySource: audio.metadata?.gatewayKeySource || '',
    }));
    return true;
  };'''
one(legacy_speak, new_speak, 'replace legacy MP3 speak path')

one(
    "    if (message?.event === 'mark') {\n      if (!currentMark || message?.mark?.name === currentMark) {\n        assistantPlaying = false;\n        currentMark = '';\n      }\n      return;\n    }",
    "    if (message?.event === 'mark') {\n      if (currentMark && message?.mark?.name === currentMark) {\n        assistantPlaying = false;\n        currentMark = '';\n      }\n      return;\n    }",
    'ignore stale marks',
)
one(
    "    if (message?.event === 'stop') {\n      finishUtterance();\n      abortActiveTurn();",
    "    if (message?.event === 'stop') {\n      finishUtterance();\n      interruptPlayback();\n      abortActiveTurn();",
    'cancel playback on stop',
)
one(
    "  telnyx.addEventListener('error', async () => {\n    await setCallStatus(env, callId, 'error');",
    "  telnyx.addEventListener('error', async () => {\n    interruptPlayback();\n    await setCallStatus(env, callId, 'error');",
    'cancel playback on websocket error',
)
one(
    "  telnyx.addEventListener('close', async () => {\n    closed = true;\n    clearTimeout(deadline);\n    finishUtterance();\n    abortActiveTurn();",
    "  telnyx.addEventListener('close', async () => {\n    closed = true;\n    clearTimeout(deadline);\n    finishUtterance();\n    interruptPlayback();\n    abortActiveTurn();",
    'cancel playback on close',
)

INDEX.write_text(s)

p = PROTO
proto = p.read_text()
old = 'codec="PCMU" bidirectionalMode="mp3" statusCallback='
new = 'codec="PCMU" bidirectionalMode="rtp" bidirectionalCodec="PCMU" statusCallback='
if proto.count(old) != 1:
    raise SystemExit(f'protocol: expected legacy stream contract once, got {proto.count(old)}')
p.write_text(proto.replace(old, new))

p = TEST
t = p.read_text()
t = t.replace(
    "test('TeXML receives PCMU and returns MP3 on the same Telnyx stream'",
    "test('TeXML receives and returns PCMU on the same Telnyx stream'",
)
t = t.replace(
    'assert.match(xml, /bidirectionalMode="mp3"/);\n  assert.doesNotMatch(xml, /bidirectionalCodec=/);',
    'assert.match(xml, /bidirectionalMode="rtp"/);\n  assert.match(xml, /bidirectionalCodec="PCMU"/);\n  assert.doesNotMatch(xml, /bidirectionalSamplingRate=/);',
)
t = t.replace(
    'assert.match(source, /talksys-telephony-v84-shared-turn-dedupe/);',
    'assert.match(source, /talksys-telephony-v87-grok-pcmu-paced/);',
)
legacy_test = """test('telephone outbound TTS is pluggable without replacing Telnyx media transport', () => {
  const source = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
  assert.match(source, /typeof deps\\?\\.synthesize === 'function'/);
  assert.match(source, /synthesizeMp3\\(env, text, deps\\)/);
  assert.match(source, /pluggableTts: true/);
});"""
new_test = """test('telephone outbound TTS is pluggable while using paced PCMU transport', () => {
  const source = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
  assert.match(source, /synthesizePhonePcmu\\(env, spoken, deps\\)/);
  assert.match(source, /streamPcmu20ms\\(audio\\.bytes/);
  assert.match(source, /playbackGeneration/);
  assert.doesNotMatch(source, /synthesizeMp3/);
  assert.match(source, /pluggableTts: true/);
});"""
if legacy_test not in t:
    raise SystemExit('legacy outbound TTS test block not found')
t = t.replace(legacy_test, new_test)
p.write_text(t)

idx = INDEX.read_text()
proto = PROTO.read_text()
assert "talksys-telephony-v87-grok-pcmu-paced" in idx
assert 'synthesizeMp3' not in idx
assert 'synthesizePhonePcmu(env, spoken, deps)' in idx
assert 'streamPcmu20ms(audio.bytes' in idx
assert 'playbackGeneration' in idx
assert 'phone_tts_sent' in idx
assert 'bidirectionalMode="rtp"' in proto
assert 'bidirectionalCodec="PCMU"' in proto
assert 'bidirectionalSamplingRate' not in proto
print('phone grok pcmu v87 patch applied and structural assertions passed')

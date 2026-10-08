from pathlib import Path

p = Path('src/telephony/index.js')
s = p.read_text()

def one(old, new):
    global s
    n = s.count(old)
    if n != 1:
        raise SystemExit(f'index exact replacement expected once, got {n}: {old[:90]!r}')
    s = s.replace(old, new)

one("import { CloudflareJapaneseTTS } from '../cloudflare-japanese-tts.js';",
    "import { normalizeJapaneseTtsText } from '../cloudflare-japanese-tts.js';")
one("export const TELEPHONY_REVISION = 'talksys-telephony-v84-shared-turn-dedupe';",
    "export const TELEPHONY_REVISION = 'talksys-telephony-v86-grok-pcmu';\nexport const PHONE_TTS_MODEL = 'xai/grok-tts';\nexport const PHONE_TTS_DEFAULT_VOICE = 'ara';\nexport const PHONE_TTS_SAMPLE_RATE = 8000;\nconst PHONE_TTS_VOICES = new Set(['eve', 'ara', 'rex', 'sal', 'leo']);")

anchor = "async function synthesizeMp3(env, text, deps = {}) {"
start = s.index(anchor)
end = s.index("\nfunction dashboardHtml(request)", start)
replacement = '''export function phoneTtsVoice(env) {
  const configured = clean(env?.TELEPHONY_TTS_VOICE || '', 24).toLowerCase();
  return PHONE_TTS_VOICES.has(configured) ? configured : PHONE_TTS_DEFAULT_VOICE;
}

function phoneTtsAudioUrl(result) {
  const candidates = [result?.result?.audio, result?.audio, result?.response?.result?.audio, result?.response?.audio];
  for (const candidate of candidates) {
    const value = clean(candidate, 4000);
    if (/^https:\/\//i.test(value)) return value;
  }
  return '';
}

export function extractMulawPayload(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || new ArrayBuffer(0));
  if (!bytes.byteLength) throw new Error('grok_tts_empty_audio');
  const ascii = (off, len) => String.fromCharCode(...bytes.subarray(off, off + len));
  if (bytes.byteLength >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') {
    let off = 12;
    while (off + 8 <= bytes.byteLength) {
      const id = ascii(off, 4);
      const size = bytes[off + 4] | (bytes[off + 5] << 8) | (bytes[off + 6] << 16) | (bytes[off + 7] << 24);
      const dataStart = off + 8;
      const dataEnd = dataStart + Math.max(0, size);
      if (dataEnd > bytes.byteLength) throw new Error('grok_tts_bad_wav');
      if (id === 'data') return bytes.slice(dataStart, dataEnd);
      off = dataEnd + (size & 1);
    }
    throw new Error('grok_tts_wav_data_missing');
  }
  if (bytes.byteLength >= 3 && ascii(0, 3) === 'ID3') throw new Error('grok_tts_unexpected_mp3');
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) throw new Error('grok_tts_unexpected_mp3');
  return bytes;
}

export async function synthesizeGrokPhonePcmu(env, text, fetchImpl = fetch) {
  if (!env?.AI || typeof env.AI.run !== 'function') throw new Error('workers_ai_unavailable');
  const spoken = normalizeJapaneseTtsText(text);
  if (!spoken) return null;
  const result = await env.AI.run(PHONE_TTS_MODEL, {
    text: spoken,
    voice_id: phoneTtsVoice(env),
    language: 'ja',
    output_format: { codec: 'mulaw', sample_rate: PHONE_TTS_SAMPLE_RATE },
    text_normalization: false,
  });
  const audioUrl = phoneTtsAudioUrl(result);
  if (!audioUrl) throw new Error('grok_tts_audio_url_missing');
  const response = await fetchImpl(audioUrl);
  if (!response?.ok) throw new Error(`grok_tts_audio_fetch_${Number(response?.status || 0) || 'error'}`);
  const audio = await response.arrayBuffer();
  return extractMulawPayload(audio);
}

async function synthesizePcmu(env, text) {
  const spoken = clean(text, clampInt(env?.TELEPHONY_MAX_SPOKEN_CHARS, 1200, 200, 3000));
  if (!spoken) return null;
  return synthesizeGrokPhonePcmu(env, spoken);
}
'''
s = s[:start] + replacement + s[end:]

one("    outputAudio: 'TalkSys TTS MP3 → Telnyx',",
    "    outputAudio: 'Cloudflare Grok G.711 μ-law 8kHz → Telnyx PCMU RTP',")
one("    pluggableTts: true,\n    externalTtsConnected: typeof deps?.synthesize === 'function',",
    "    pluggableTts: false,\n    externalTtsConnected: false,\n    phoneTtsModel: PHONE_TTS_MODEL,\n    phoneTtsVoice: phoneTtsVoice(env),\n    phoneTtsSampleRate: PHONE_TTS_SAMPLE_RATE,")
one("  const speak = async (text) => {\n    const payload = await synthesizeMp3(env, text, deps);\n    if (!payload || closed) return false;\n    currentMark = `talksys-${crypto.randomUUID()}`;\n    safeSend(telnyx, { event: 'media', media: { payload } });\n    safeSend(telnyx, { event: 'mark', mark: { name: currentMark } });\n    assistantPlaying = true;\n    return true;\n  };",
    "  const speak = async (text) => {\n    const pcmu = await synthesizePcmu(env, text);\n    if (!pcmu?.byteLength || closed) return false;\n    currentMark = `talksys-${crypto.randomUUID()}`;\n    const maxChunk = 8000; // 1 second of G.711 μ-law at 8 kHz\n    for (let offset = 0; offset < pcmu.byteLength && !closed; offset += maxChunk) {\n      const chunk = pcmu.subarray(offset, Math.min(offset + maxChunk, pcmu.byteLength));\n      safeSend(telnyx, { event: 'media', media: { payload: bytesToBase64(chunk) } });\n    }\n    safeSend(telnyx, { event: 'mark', mark: { name: currentMark } });\n    assistantPlaying = true;\n    return true;\n  };")
p.write_text(s)

p = Path('src/telephony/protocol.js')
s = p.read_text()
old = 'codec="PCMU" bidirectionalMode="mp3" statusCallback='
new = 'codec="PCMU" bidirectionalMode="rtp" bidirectionalCodec="PCMU" bidirectionalSamplingRate="8000" statusCallback='
if s.count(old) != 1:
    raise SystemExit('protocol legacy stream contract not found exactly once')
p.write_text(s.replace(old, new))

p = Path('tests/telephony-integration.test.mjs')
s = p.read_text()
s = s.replace("import { buildTexml } from '../src/telephony/protocol.js';",
              "import { buildTexml } from '../src/telephony/protocol.js';\nimport { PHONE_TTS_MODEL, PHONE_TTS_SAMPLE_RATE, extractMulawPayload, synthesizeGrokPhonePcmu } from '../src/telephony/index.js';")
s = s.replace("test('TeXML receives PCMU and returns MP3 on the same Telnyx stream'", "test('TeXML receives and returns PCMU on the same Telnyx stream'")
s = s.replace('assert.match(xml, /bidirectionalMode="mp3"/);\n  assert.doesNotMatch(xml, /bidirectionalCodec=/);',
              'assert.match(xml, /bidirectionalMode="rtp"/);\n  assert.match(xml, /bidirectionalCodec="PCMU"/);\n  assert.match(xml, /bidirectionalSamplingRate="8000"/);')
s = s.replace('assert.match(source, /talksys-telephony-v84-shared-turn-dedupe/);', 'assert.match(source, /talksys-telephony-v86-grok-pcmu/);')
oldtest = "test('telephone outbound TTS is pluggable without replacing Telnyx media transport', () => {\n  const source = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');\n  assert.match(source, /typeof deps\\?\\.synthesize === 'function'/);\n  assert.match(source, /synthesizeMp3\\(env, text, deps\\)/);\n  assert.match(source, /pluggableTts: true/);\n});"
newtest = '''test('phone TTS requests raw telephony mulaw at 8 kHz and rejects MP3', async () => {
  assert.equal(PHONE_TTS_MODEL, 'xai/grok-tts');
  assert.equal(PHONE_TTS_SAMPLE_RATE, 8000);
  const calls = [];
  const env = { AI: { async run(model, input) { calls.push({ model, input }); return { result: { audio: 'https://audio.example.test/phone.ulaw' } }; } } };
  const raw = Uint8Array.from([0xff, 0x7f, 0x00, 0x80]);
  const audio = await synthesizeGrokPhonePcmu(env, 'テストです。', async () => ({ ok: true, arrayBuffer: async () => raw.buffer }));
  assert.deepEqual(Array.from(audio), Array.from(raw));
  assert.equal(calls[0].input.output_format.codec, 'mulaw');
  assert.equal(calls[0].input.output_format.sample_rate, 8000);
  assert.throws(() => extractMulawPayload(Uint8Array.from([0x49,0x44,0x33,0x04])), /unexpected_mp3/);
});

test('telephone outbound path uses PCMU chunks instead of MP3', () => {
  const source = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
  assert.match(source, /synthesizePcmu\\(env, text\\)/);
  assert.match(source, /const maxChunk = 8000/);
  assert.match(source, /bytesToBase64\\(chunk\\)/);
  assert.doesNotMatch(source, /synthesizeMp3/);
  assert.match(source, /pluggableTts: false/);
});'''
if oldtest not in s:
    raise SystemExit('legacy outbound TTS test block not found')
s = s.replace(oldtest, newtest)
p.write_text(s)

idx = Path('src/telephony/index.js').read_text()
proto = Path('src/telephony/protocol.js').read_text()
assert "codec: 'mulaw'" in idx
assert 'PHONE_TTS_SAMPLE_RATE = 8000' in idx
assert 'synthesizeMp3' not in idx
assert 'bidirectionalMode="rtp"' in proto
assert 'bidirectionalCodec="PCMU"' in proto
assert 'bidirectionalSamplingRate="8000"' in proto

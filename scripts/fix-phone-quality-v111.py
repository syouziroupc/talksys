from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one match, found {count}: {old!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')

replace_once(
    'src/telephony/phone-tts.js',
    '  const ceilingSample = Math.floor(32767 * PHONE_TTS_OUTPUT_PEAK_CEILING);',
    '  // Leave mu-law quantization headroom so the decoded signal stays below the advertised ceiling.\n  const ceilingSample = Math.floor(32767 * Math.max(0, PHONE_TTS_OUTPUT_PEAK_CEILING - 0.02));',
)

replace_once(
    'tests/phone-latency-fast-ack-v90.test.mjs',
    "  assert.match(source, /const\\s+FAST_ACK_TEXT\\s*=\\s*'はい。'/);",
    "  assert.match(source, /const\\s+FAST_ACK_TEXT\\s*=\\s*'はい、少々お待ちください。'/);",
)

print('phone quality v111 follow-up fixes applied')

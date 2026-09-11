from pathlib import Path

path = Path(__file__).resolve().parent / 'repair-v45-ui-voice.py'
text = path.read_text(encoding='utf-8')

for name, next_name in [('CLIENT', 'STT'), ('STT', 'TEST'), ('TEST', 'DEPLOY')]:
    start_marker = f"{name} = r'''"
    end_marker = f"\n'''\n\n{next_name} = r'''"
    start = text.find(start_marker)
    end = text.find(end_marker, start)
    if start < 0 or end < 0:
        raise SystemExit(f'raw block not found: {name}')
    block = text[start:end]
    # These blocks are raw Python strings whose JavaScript regex/string escapes were
    # accidentally doubled. JavaScript needs one source-level backslash here.
    fixed = block.replace('\\\\', '\\')
    text = text[:start] + fixed + text[end:]

# Avoid a regex entirely for the diagnostic boolean; string tests are clearer and
# cannot be broken by slash escaping in this Python -> JavaScript generator.
text = text.replace(
    "  legacyWebSocket: /new\\s+WebSocket|\\/agents\\//.test(client),",
    "  legacyWebSocket: client.includes('new WebSocket') || client.includes('/agents/'),",
)

path.write_text(text, encoding='utf-8')
print('normalized v45 repair generator escaping')

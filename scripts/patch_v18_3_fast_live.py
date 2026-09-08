from pathlib import Path

path = Path('src/cloudflare-llm.js')
text = path.read_text()
needle = '        const lines = pending.split(/'
start = text.index(needle)
end = text.index('/);', start) + 3
replacement = '        const lines = pending.split(/\\r?\\n/);'
text = text[:start] + replacement + text[end:]
path.write_text(text)
print('fixed v18.3 SSE line splitting')

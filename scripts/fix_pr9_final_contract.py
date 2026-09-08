from pathlib import Path


def replace_exact(path, old, new, expected=1):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != expected:
        raise SystemExit(f'{path}: expected {expected} matches, got {count}: {old!r}')
    p.write_text(text.replace(old, new, expected))

# Search is the one place where accuracy has priority. The planner/coverage phases
# are already bounded by SEARCH_PLANNER_BUDGET_MS / SEARCH_COVERAGE_BUDGET_MS, so
# prefer the strongest grounded model first and only then fall back.
replace_exact(
    'src/search-orchestrator.js',
    'const models = [...new Set([GROUNDING_FALLBACK_MODEL, GROUNDING_VOICE_MODEL].filter(Boolean))];',
    'const models = [...new Set([GROUNDING_VOICE_MODEL, GROUNDING_FALLBACK_MODEL].filter(Boolean))];',
    expected=2,
)

p = Path('tests/gemini-live-contract.test.mjs')
t = p.read_text()
old = "  assert.match(workerSource, /shouldDeepSearch\\(transcript, \\[\\]\\)/);"
new = "  assert.match(workerSource, /shouldDeepSearch\\(transcript, history\\)/);"
if t.count(old) != 1:
    raise SystemExit('stale no-history search assertion not found exactly once')
t = t.replace(old, new, 1)

old = "  assert.match(searchSource, /今、\\$\\{topic\\}について検索しています。少しお待ちください。/);"
new = "  assert.match(searchSource, /今、\\$\\{chosen\\}について検索しています。少しお待ちください。/);\n  assert.match(searchSource, /前の話を踏まえて確認しています。少し待ってください。/);\n  assert.match(searchSource, /BAD_PROGRESS_TOPIC_RE/);"
if t.count(old) != 1:
    raise SystemExit('stale filler template assertion not found exactly once')
t = t.replace(old, new, 1)

old_block = """test('browser sessions are isolated and no prior conversation is reused', () => {\n  assert.match(CLOUDFLARE_LIVE_CLIENT, /talk-sys-voice-agent\\/default/);\n  assert.doesNotMatch(CLOUDFLARE_LIVE_CLIENT, /crypto\\.randomUUID/);\n  assert.match(CLOUDFLARE_LIVE_CLIENT, /text_message/);\n  assert.match(workerSource, /sharedTypedAndVoiceHistory: false/);\n  assert.match(workerSource, /contextProvider: \\(\\) => \\[\\]/);\n  assert.doesNotMatch(workerSource, /context\\.messages\\.slice/);\n});"""
new_block = """test('same connection keeps short-term context while cross-session context remains isolated', () => {\n  assert.match(CLOUDFLARE_LIVE_CLIENT, /talk-sys-voice-agent\\/default/);\n  assert.doesNotMatch(CLOUDFLARE_LIVE_CLIENT, /crypto\\.randomUUID/);\n  assert.match(CLOUDFLARE_LIVE_CLIENT, /text_message/);\n  assert.match(workerSource, /sharedTypedAndVoiceHistory: true/);\n  assert.match(workerSource, /crossTurnContext: true/);\n  assert.match(workerSource, /crossSessionContext: false/);\n  assert.match(workerSource, /conversationMemory = new Map/);\n  assert.match(workerSource, /CONTEXT_MAX_MESSAGES = 8/);\n  assert.match(workerSource, /CONTEXT_TTL_MS = 30 \\* 60 \\* 1000/);\n  assert.match(workerSource, /function conversationKey\\(context\\)/);\n  assert.match(workerSource, /if \\(!key\\) return/);\n  assert.match(workerSource, /contextProvider: \\(\\) => \\[\\]/);\n});"""
if t.count(old_block) != 1:
    raise SystemExit('stale browser-isolation test block not found exactly once')
t = t.replace(old_block, new_block, 1)
p.write_text(t)

print('PR #9 final search/context contract alignment applied')

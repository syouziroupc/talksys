from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one match, got {count}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1))

replace_once(
    'src/worker-v14.js',
    "function conversationKey(context) {\n  return String(context?.connection?.id || 'default').slice(0, 160);\n}\n",
    "function conversationKey(context) {\n  const id = String(context?.connection?.id || '').trim();\n  return id ? id.slice(0, 160) : '';\n}\n",
)
replace_once(
    'src/worker-v14.js',
    "  getConversationHistory(context) {\n    const key = conversationKey(context);\n    const entry = this.conversationMemory.get(key);",
    "  getConversationHistory(context) {\n    const key = conversationKey(context);\n    if (!key) return [];\n    const entry = this.conversationMemory.get(key);",
)
replace_once(
    'src/worker-v14.js',
    "    const key = conversationKey(context);\n    const prior = this.getConversationHistory(context);",
    "    const key = conversationKey(context);\n    if (!key) return;\n    const prior = this.getConversationHistory(context);",
)

replace_once(
    'src/search-orchestrator.js',
    "  const source = looksContextDependentFollowup(current) ? contextual : current;",
    "  const source = (looksContextDependentFollowup(current) || GENERIC_RESEARCH_COMMAND_RE.test(current)) ? contextual : current;",
)
replace_once(
    'src/search-orchestrator.js',
    "  const topic = sanitizeProgressTopic(extractText(result));\n  if (!topic && contextualCommand) return '前の話を踏まえて確認しています。少し待ってください。';",
    "  const topic = sanitizeProgressTopic(extractText(result));\n  if (contextualCommand && (!topic || /調べ|検索内容|質問内容|内容不明|不明/.test(topic))) {\n    return '前の話を踏まえて確認しています。少し待ってください。';\n  }",
)

p = Path('tests/contextual-conversation-regression.test.mjs')
t = p.read_text()
t = t.replace("  assert.match(worker, /rememberConversationTurn/);", "  assert.match(worker, /rememberConversationTurn/);\n  assert.match(worker, /if \(!key\) return/);\n  assert.doesNotMatch(worker, /connection\\?\\.id \\|\\| 'default'/);")
t = t.replace("  assert.match(orchestrator, /BAD_PROGRESS_TOPIC_RE/);", "  assert.match(orchestrator, /BAD_PROGRESS_TOPIC_RE/);\n  assert.match(orchestrator, /contextualCommand && \\(!topic \\|\\| \/調べ/);")
p.write_text(t)

print('v18.5 final safety patch applied')

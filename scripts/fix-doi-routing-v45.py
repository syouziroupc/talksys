from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f'{label} anchor not found')
    return text.replace(old, new, 1)

p = Path('src/worker-v44.js')
s = p.read_text()
s = replace_once(
    s,
    """export function localDeterministicAnswer(text) {\n  const value = canonicalizeInput(text, 1800);\n\n  let m = value.match(/2進数\\s*([01]+).*?(?:10進数|十進数)/i);""",
    """export function localDeterministicAnswer(text) {\n  const value = canonicalizeInput(text, 1800);\n\n  // DOI identifiers contain hyphenated digit groups that resemble subtraction.\n  // They are external scholarly identifiers, never local arithmetic expressions.\n  if (/\\bDOI\\b/i.test(value) || /\\b10\\.\\d{4,9}\\/[-._;()/:A-Z0-9]+/i.test(value)) return null;\n\n  let m = value.match(/2進数\\s*([01]+).*?(?:10進数|十進数)/i);""",
    'DOI arithmetic guard',
)
p.write_text(s)

Path('tests/v45-doi-routing.test.mjs').write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTurn, localDeterministicAnswer } from '../src/worker-v44.js';

test('DOI identifiers never enter local arithmetic routing', () => {
  const text = 'DOI 10.1038/s41586-020-2649-2 の文献情報を確認して';
  assert.equal(localDeterministicAnswer(text), null);
  const decision = classifyTurn(text, []);
  assert.equal(decision.mode, 'external');
  assert.ok((decision.apiIntents || []).includes('scholarly_metadata'));
});

test('bare DOI form also bypasses arithmetic interpretation', () => {
  const text = '10.1038/s41586-020-2649-2 を確認して';
  assert.equal(localDeterministicAnswer(text), null);
  assert.equal(classifyTurn(text, []).mode, 'external');
});

test('ordinary arithmetic remains deterministic after DOI guard', () => {
  const result = localDeterministicAnswer('12345÷15');
  assert.equal(result?.kind, 'arithmetic');
  assert.match(result?.answer || '', /823/);
});
''')

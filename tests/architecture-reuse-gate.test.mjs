import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const gate = fs.readFileSync(new URL('../scripts/check-reuse-gate.mjs', import.meta.url), 'utf8');
const workflow = fs.readFileSync(new URL('../.github/workflows/validate.yml', import.meta.url), 'utf8');

test('reuse gate evaluates the full pull-request or push change range', () => {
  assert.match(gate, /TALKSYS_REUSE_BASE_SHA/);
  assert.match(gate, /merge-base/);
  assert.match(gate, /\['diff', '--name-status', '-M', '-C', base, 'HEAD'\]/);
  assert.match(gate, /same change range/);
});

test('reuse gate treats add rename and copy as introduced source paths', () => {
  assert.match(gate, /\^\(\?:A\|R\|C\)/);
  assert.match(gate, /new or renamed version-suffixed source files are forbidden/);
  assert.match(gate, /reactivating an existing inactive source path requires an ADR/);
  assert.match(gate, /renaming\/copying inactive legacy source into the active capability graph requires an ADR/);
  assert.match(gate, /inactive legacy\/versioned source cannot become newly active/);
});

test('validation workflow fetches history and supplies the event base SHA', () => {
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /TALKSYS_REUSE_BASE_SHA:/);
  assert.match(workflow, /github\.event\.pull_request\.base\.sha/);
  assert.match(workflow, /github\.event\.before/);
});

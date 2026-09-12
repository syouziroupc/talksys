import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const registry = JSON.parse(readFileSync(new URL('../architecture/capabilities.json', import.meta.url), 'utf8'));
const registered = new Set();
for (const entry of Object.values(registry.capabilities || {})) {
  if (entry?.canonical) registered.add(String(entry.canonical));
  for (const file of entry?.companions || []) registered.add(String(file));
}

function git(args) {
  try { return execFileSync('git', args, { encoding: 'utf8' }).trim(); }
  catch { return ''; }
}

const parent = git(['rev-parse', 'HEAD^']);
if (!parent) {
  console.log('[reuse-gate] no parent commit available; static registry checks only');
  process.exit(0);
}

const changed = git(['diff', '--name-status', parent, 'HEAD'])
  .split('\n').map((line) => line.trim()).filter(Boolean)
  .map((line) => {
    const [status, ...rest] = line.split(/\s+/);
    return { status, path: rest.at(-1) || '' };
  });

const added = changed.filter((x) => x.status.startsWith('A')).map((x) => x.path);
const addedSource = added.filter((p) => /^src\/.*\.js$/i.test(p));
const versioned = addedSource.filter((p) => /-v\d+(?:[-_.][a-z0-9]+)*\.js$/i.test(p));
const unregistered = addedSource.filter((p) => !registered.has(p));
const addedAdrs = added.filter((p) => /^architecture\/decisions\/\d{4}-.+\.md$/i.test(p));

let previous = null;
try {
  const text = execFileSync('git', ['show', `${parent}:architecture/capabilities.json`], { encoding: 'utf8' });
  previous = JSON.parse(text);
} catch {}

const newCapabilities = [];
const replacedCanonical = [];
if (previous?.capabilities) {
  for (const [id, entry] of Object.entries(registry.capabilities || {})) {
    if (!previous.capabilities[id]) newCapabilities.push(id);
    else if (String(previous.capabilities[id]?.canonical || '') !== String(entry?.canonical || '')) replacedCanonical.push(id);
  }
}

const errors = [];
if (versioned.length) {
  errors.push(`new version-suffixed canonical/source files are forbidden: ${versioned.join(', ')}`);
}
if (unregistered.length) {
  errors.push(`new src/*.js files must be registered as a canonical capability or companion before merge: ${unregistered.join(', ')}`);
}
if ((newCapabilities.length || replacedCanonical.length) && !addedAdrs.length) {
  errors.push(`NEW/REPLACE architecture change requires a new ADR in the same commit (new=${newCapabilities.join(',') || '-'} replace=${replacedCanonical.join(',') || '-'})`);
}

if (errors.length) {
  for (const error of errors) console.error(`[reuse-gate] ${error}`);
  process.exit(1);
}

console.log(`[reuse-gate] OK: ${addedSource.length} added source file(s), ${newCapabilities.length} new capability id(s), ${replacedCanonical.length} canonical replacement(s)`);

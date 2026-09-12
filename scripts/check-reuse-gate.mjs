import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const VERSIONED_SOURCE_RE = /-v\d+(?:[-_.][a-z0-9]+)*\.js$/i;
const registry = JSON.parse(readFileSync(new URL('../architecture/capabilities.json', import.meta.url), 'utf8'));

function activePaths(value) {
  const out = new Set();
  for (const entry of Object.values(value?.capabilities || {})) {
    if (entry?.canonical) out.add(String(entry.canonical));
    for (const file of entry?.companions || []) out.add(String(file));
  }
  return out;
}

const registered = activePaths(registry);

function git(args) {
  try { return execFileSync('git', args, { encoding: 'utf8' }).trim(); }
  catch { return ''; }
}

function isUsableCommit(value) {
  const sha = String(value || '').trim();
  if (!sha || /^0+$/.test(sha)) return false;
  return Boolean(git(['rev-parse', '--verify', `${sha}^{commit}`]));
}

function resolveBase() {
  const requested = String(process.env.TALKSYS_REUSE_BASE_SHA || '').trim();
  if (isUsableCommit(requested)) return git(['merge-base', requested, 'HEAD']) || requested;

  const baseRef = String(process.env.GITHUB_BASE_REF || '').trim();
  if (baseRef) {
    const remote = `origin/${baseRef}`;
    if (isUsableCommit(remote)) return git(['merge-base', remote, 'HEAD']) || remote;
  }

  const parent = git(['rev-parse', 'HEAD^']);
  return isUsableCommit(parent) ? parent : '';
}

const base = resolveBase();
if (!base) {
  console.log('[reuse-gate] no comparison base available; static registry checks only');
  process.exit(0);
}

const changed = git(['diff', '--name-status', '-M', '-C', base, 'HEAD'])
  .split('\n').map((line) => line.trim()).filter(Boolean)
  .map((line) => {
    const [status, ...paths] = line.split(/\s+/);
    const renamedOrCopied = /^R|^C/.test(status);
    return {
      status,
      fromPath: renamedOrCopied ? (paths[0] || '') : '',
      path: paths.at(-1) || '',
    };
  });

// A, R and C can all introduce a new path into active source. Treat them equally.
const introduced = changed.filter((x) => /^(?:A|R|C)/.test(x.status));
const introducedPaths = new Set(introduced.map((x) => x.path));
const introducedSource = introduced.map((x) => x.path).filter((p) => /^src\/.*\.js$/i.test(p));
const versionedIntroduced = introducedSource.filter((p) => VERSIONED_SOURCE_RE.test(p));
const unregistered = introducedSource.filter((p) => !registered.has(p));
const addedAdrs = changed
  .filter((x) => /^(?:A|R|C)/.test(x.status))
  .map((x) => x.path)
  .filter((p) => /^architecture\/decisions\/\d{4}-.+\.md$/i.test(p));

let previous = null;
try {
  const text = execFileSync('git', ['show', `${base}:architecture/capabilities.json`], { encoding: 'utf8' });
  previous = JSON.parse(text);
} catch {}

const newCapabilities = [];
const replacedCanonical = [];
const baseActive = activePaths(previous);
if (previous?.capabilities) {
  for (const [id, entry] of Object.entries(registry.capabilities || {})) {
    if (!previous.capabilities[id]) newCapabilities.push(id);
    else if (String(previous.capabilities[id]?.canonical || '') !== String(entry?.canonical || '')) replacedCanonical.push(id);
  }
}

const newlyActivated = [...registered].filter((path) => !baseActive.has(path));
const versionedNewlyActivated = newlyActivated.filter((path) => VERSIONED_SOURCE_RE.test(path));
const reactivatedExisting = newlyActivated.filter((path) => !introducedPaths.has(path));
const legacyActivationViaMove = introduced
  .filter((x) => /^(?:R|C)/.test(x.status))
  .filter((x) => registered.has(x.path) && x.fromPath && !baseActive.has(x.fromPath))
  .map((x) => `${x.fromPath} -> ${x.path}`);

const errors = [];
if (versionedIntroduced.length) {
  errors.push(`new or renamed version-suffixed source files are forbidden: ${versionedIntroduced.join(', ')}`);
}
if (unregistered.length) {
  errors.push(`new/renamed/copied src/*.js files must be registered as a canonical capability or companion before merge: ${unregistered.join(', ')}`);
}
if (versionedNewlyActivated.length) {
  errors.push(`inactive legacy/versioned source cannot become newly active: ${versionedNewlyActivated.join(', ')}`);
}
if (reactivatedExisting.length && !addedAdrs.length) {
  errors.push(`reactivating an existing inactive source path requires an ADR: ${reactivatedExisting.join(', ')}`);
}
if (legacyActivationViaMove.length && !addedAdrs.length) {
  errors.push(`renaming/copying inactive legacy source into the active capability graph requires an ADR: ${legacyActivationViaMove.join(', ')}`);
}
if ((newCapabilities.length || replacedCanonical.length) && !addedAdrs.length) {
  errors.push(`NEW/REPLACE architecture change requires a new ADR in the same change range (new=${newCapabilities.join(',') || '-'} replace=${replacedCanonical.join(',') || '-'})`);
}

if (errors.length) {
  for (const error of errors) console.error(`[reuse-gate] ${error}`);
  process.exit(1);
}

console.log(`[reuse-gate] base=${base.slice(0, 12)} head=${git(['rev-parse', 'HEAD']).slice(0, 12)}`);
console.log(`[reuse-gate] OK across full change range: ${introducedSource.length} introduced source path(s), ${newCapabilities.length} new capability id(s), ${replacedCanonical.length} canonical replacement(s), ${newlyActivated.length} newly active path(s)`);

import { readFileSync, existsSync } from 'node:fs';

const registryPath = new URL('../architecture/capabilities.json', import.meta.url);
const repoRoot = new URL('../', import.meta.url);

function fail(message) {
  console.error(`[architecture-registry] ${message}`);
  process.exitCode = 1;
}

function validateRepoPath(label, value) {
  const path = String(value || '').trim();
  if (!path) {
    fail(`${label}: path is required`);
    return '';
  }
  if (!path.startsWith('src/')) fail(`${label}: path must currently live under src/: ${path}`);
  if (!existsSync(new URL(path, repoRoot))) fail(`${label}: file does not exist: ${path}`);
  return path;
}

let registry;
try {
  registry = JSON.parse(readFileSync(registryPath, 'utf8'));
} catch (error) {
  console.error(`[architecture-registry] cannot read registry: ${error.message}`);
  process.exit(1);
}

if (registry?.schemaVersion !== 1) fail('schemaVersion must be 1');
if (!registry?.capabilities || typeof registry.capabilities !== 'object') fail('capabilities object is required');

const allowedStatuses = new Set(['production', 'production-supporting', 'planned', 'legacy']);
let capabilityCount = 0;
const canonicalFiles = new Set();
const activeFiles = new Set();

for (const [id, entry] of Object.entries(registry.capabilities || {})) {
  capabilityCount += 1;
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id)) fail(`invalid capability id: ${id}`);

  const canonical = validateRepoPath(`${id}.canonical`, entry?.canonical);
  const responsibility = String(entry?.responsibility || '').trim();
  const status = String(entry?.status || '').trim();

  if (!responsibility) fail(`${id}: responsibility is required`);
  if (!allowedStatuses.has(status)) fail(`${id}: invalid status '${status}'`);
  if (canonical) {
    canonicalFiles.add(canonical);
    activeFiles.add(canonical);
  }

  const symbol = String(entry?.symbol || '').trim();
  if (symbol && canonical && existsSync(new URL(canonical, repoRoot))) {
    const source = readFileSync(new URL(canonical, repoRoot), 'utf8');
    if (!source.includes(symbol)) fail(`${id}: declared symbol '${symbol}' was not found in ${canonical}`);
  }

  if (entry?.companions !== undefined && !Array.isArray(entry.companions)) fail(`${id}: companions must be an array`);
  for (const [index, companion] of (entry?.companions || []).entries()) {
    const path = validateRepoPath(`${id}.companions[${index}]`, companion);
    if (path) activeFiles.add(path);
  }
}

if (registry?.legacyPriorArt !== undefined && (typeof registry.legacyPriorArt !== 'object' || Array.isArray(registry.legacyPriorArt))) {
  fail('legacyPriorArt must be an object when present');
}
for (const [path, note] of Object.entries(registry?.legacyPriorArt || {})) {
  validateRepoPath(`legacyPriorArt.${path}`, path);
  if (!String(note || '').trim()) fail(`legacyPriorArt.${path}: note is required`);
  if (activeFiles.has(path)) fail(`legacyPriorArt cannot also be an active canonical/companion file: ${path}`);
}

try {
  const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const wranglerMain = wrangler.match(/"main"\s*:\s*"([^"]+)"/)?.[1] || '';
  const registryMain = String(registry?.capabilities?.['runtime.entry']?.canonical || '');
  if (!wranglerMain) fail('wrangler.jsonc main entry could not be resolved');
  else if (wranglerMain !== registryMain) fail(`runtime.entry mismatch: registry=${registryMain} wrangler=${wranglerMain}`);
} catch (error) {
  fail(`cannot verify wrangler runtime entry: ${error.message}`);
}

if (!process.exitCode) {
  console.log(`[architecture-registry] OK: ${capabilityCount} capabilities across ${canonicalFiles.size} canonical files validated`);
}

import { readFileSync, existsSync } from 'node:fs';

const registryPath = new URL('../architecture/capabilities.json', import.meta.url);
const repoRoot = new URL('../', import.meta.url);

function fail(message) {
  console.error(`[architecture-registry] ${message}`);
  process.exitCode = 1;
}

let registry;
try {
  registry = JSON.parse(readFileSync(registryPath, 'utf8'));
} catch (error) {
  console.error(`[architecture-registry] cannot read registry: ${error.message}`);
  process.exit(1);
}

if (registry?.schemaVersion !== 1) fail('schemaVersion must be 1');
if (!registry?.capabilities || typeof registry.capabilities !== 'object') {
  fail('capabilities object is required');
}

const allowedStatuses = new Set(['production', 'production-supporting', 'planned', 'legacy']);
const canonicalOwners = new Map();

for (const [id, entry] of Object.entries(registry.capabilities || {})) {
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id)) {
    fail(`invalid capability id: ${id}`);
  }

  const canonical = String(entry?.canonical || '').trim();
  const responsibility = String(entry?.responsibility || '').trim();
  const status = String(entry?.status || '').trim();

  if (!canonical) {
    fail(`${id}: canonical path is required`);
    continue;
  }
  if (!canonical.startsWith('src/')) fail(`${id}: canonical path must currently live under src/: ${canonical}`);
  if (!responsibility) fail(`${id}: responsibility is required`);
  if (!allowedStatuses.has(status)) fail(`${id}: invalid status '${status}'`);

  const fileUrl = new URL(canonical, repoRoot);
  if (!existsSync(fileUrl)) fail(`${id}: canonical file does not exist: ${canonical}`);

  const previous = canonicalOwners.get(canonical);
  if (previous) fail(`${id}: canonical file is already owned by ${previous}: ${canonical}`);
  canonicalOwners.set(canonical, id);
}

if (!process.exitCode) {
  console.log(`[architecture-registry] OK: ${canonicalOwners.size} canonical capabilities validated`);
}

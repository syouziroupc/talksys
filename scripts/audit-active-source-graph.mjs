import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const registry = JSON.parse(readFileSync(path.join(root, 'architecture/capabilities.json'), 'utf8'));
const entry = String(registry?.capabilities?.['runtime.entry']?.canonical || '');
if (!entry) throw new Error('runtime.entry canonical is missing from architecture registry');

function walk(dir) {
  const out = [];
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) out.push(...walk(full));
    else if (item.isFile() && item.name.endsWith('.js')) out.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return out;
}

function relativeImports(file) {
  const source = readFileSync(path.join(root, file), 'utf8');
  const specs = new Set();
  const patterns = [
    /(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"](\.[^'"]+)['"]/g,
    /import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(source))) specs.add(match[1]);
  }
  const dir = path.posix.dirname(file);
  const resolved = [];
  for (const spec of specs) {
    let candidate = path.posix.normalize(path.posix.join(dir, spec));
    if (!path.posix.extname(candidate)) candidate += '.js';
    if (existsSync(path.join(root, candidate))) resolved.push(candidate);
  }
  return resolved;
}

const reachable = new Set();
const queue = [entry];
while (queue.length) {
  const file = queue.shift();
  if (!file || reachable.has(file)) continue;
  if (!existsSync(path.join(root, file))) throw new Error(`runtime graph references missing file: ${file}`);
  reachable.add(file);
  for (const imported of relativeImports(file)) if (!reachable.has(imported)) queue.push(imported);
}

const allSource = walk(path.join(root, 'src')).sort();
const unreachable = allSource.filter((file) => !reachable.has(file));
const requiredProduction = new Set();
for (const entryData of Object.values(registry.capabilities || {})) {
  if (entryData?.status !== 'production') continue;
  if (entryData.canonical) requiredProduction.add(String(entryData.canonical));
  for (const companion of entryData.companions || []) requiredProduction.add(String(companion));
}
const missingFromRuntime = [...requiredProduction].filter((file) => !reachable.has(file)).sort();

if (missingFromRuntime.length) {
  for (const file of missingFromRuntime) console.error(`[source-graph] production registry file is not reachable from runtime.entry: ${file}`);
  process.exit(1);
}

console.log(`[source-graph] runtime entry: ${entry}`);
console.log(`[source-graph] reachable production graph: ${reachable.size}/${allSource.length} src JavaScript files`);
console.log(`[source-graph] unreachable legacy/candidate files: ${unreachable.length}`);
for (const file of unreachable) console.log(`[source-graph] unreachable: ${file}`);
console.log('[source-graph] NOTE: unreachable means not statically reachable from runtime.entry; it is a cleanup candidate, not automatic proof that deletion is safe.');

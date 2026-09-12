import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const registry = JSON.parse(readFileSync(path.join(root, 'architecture/capabilities.json'), 'utf8'));
const entry = String(registry?.capabilities?.['runtime.entry']?.canonical || '');
if (!entry) throw new Error('runtime.entry canonical is missing from architecture registry');

const SKIP_DIRS = new Set(['.git', 'node_modules', '.wrangler', 'dist', 'coverage']);
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.jsonc', '.md', '.yml', '.yaml', '.txt', '.html', '.css']);

function repoPath(full) {
  return path.relative(root, full).split(path.sep).join('/');
}

function walkJavaScript(dir) {
  const out = [];
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(item.name)) continue;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) out.push(...walkJavaScript(full));
    else if (item.isFile() && item.name.endsWith('.js')) out.push(repoPath(full));
  }
  return out;
}

function walkTextFiles(dir) {
  const out = [];
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(item.name)) continue;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) out.push(...walkTextFiles(full));
    else if (item.isFile() && TEXT_EXTENSIONS.has(path.extname(item.name).toLowerCase())) out.push(repoPath(full));
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

function classifyReferenceFile(file) {
  if (file.startsWith('tests/')) return 'test';
  if (file.startsWith('src/')) return 'legacy-source';
  if (file.startsWith('archive/')) return 'archive';
  if (file.startsWith('scripts/') || file.startsWith('.github/')) return 'tooling';
  if (file.startsWith('architecture/') || /(?:^|\/)(?:README|CHANGELOG|CONTRIBUTING)(?:\.|$)/i.test(file)) return 'documentation';
  return 'config-or-other';
}

function textualReferences(target, textFiles) {
  const basename = path.posix.basename(target);
  const stem = basename.replace(/\.js$/i, '');
  const refs = [];
  for (const file of textFiles) {
    if (file === target) continue;
    let source = '';
    try { source = readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
    if (source.includes(target)
      || source.includes(basename)
      || source.includes(`./${stem}`)
      || source.includes(`../${stem}`)) {
      refs.push(file);
    }
  }
  return [...new Set(refs)].sort();
}

const reachable = new Set();
const queue = [entry];
while (queue.length) {
  const file = queue.shift();
  if (!file || reachable.has(file)) continue;
  if (!existsSync(path.join(root, file))) throw new Error(`runtime graph references missing file: ${file}`);
  if (file.startsWith('archive/')) {
    console.error(`[source-graph] production runtime must never import historical archive code: ${file}`);
    process.exit(1);
  }
  reachable.add(file);
  for (const imported of relativeImports(file)) if (!reachable.has(imported)) queue.push(imported);
}

const allSource = walkJavaScript(path.join(root, 'src')).sort();
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

const textFiles = walkTextFiles(root);
const legacyPriorArt = new Set(Object.keys(registry?.legacyPriorArt || {}));
const classification = unreachable.map((file) => {
  const refs = textualReferences(file, textFiles);
  const refsByKind = {};
  for (const ref of refs) {
    const kind = classifyReferenceFile(ref);
    (refsByKind[kind] ||= []).push(ref);
  }
  const protectedPriorArt = legacyPriorArt.has(file);
  const strongRefs = refs.filter((ref) => !ref.startsWith('src/') && !ref.startsWith('archive/'));
  const historicalOnly = refs.length > 0 && strongRefs.length === 0;
  let status = 'orphan-candidate';
  if (protectedPriorArt) status = 'prior-art-protected';
  else if (strongRefs.length) status = 'externally-referenced-legacy';
  else if (historicalOnly) status = 'legacy-source-only';
  return { file, status, refs, refsByKind };
});

const counts = classification.reduce((acc, item) => {
  acc[item.status] = (acc[item.status] || 0) + 1;
  return acc;
}, {});

console.log(`[source-graph] runtime entry: ${entry}`);
console.log(`[source-graph] reachable production graph: ${reachable.size}/${allSource.length} src JavaScript files`);
console.log(`[source-graph] unreachable legacy/candidate files: ${unreachable.length}`);
for (const status of ['prior-art-protected', 'externally-referenced-legacy', 'legacy-source-only', 'orphan-candidate']) {
  console.log(`[source-graph] classification ${status}: ${counts[status] || 0}`);
}
for (const item of classification) {
  const refSummary = Object.entries(item.refsByKind)
    .map(([kind, refs]) => `${kind}=${refs.length}`)
    .join(',');
  console.log(`[source-graph] ${item.status}: ${item.file}${refSummary ? ` (${refSummary})` : ''}`);
}
console.log('[source-graph] NOTE: archive references are historical-only and do not make a src file production-active. orphan-candidate means no textual reference was found outside the file and it is not registered prior art. Deletion still requires a separate small PR plus the full test and bundle checks.');

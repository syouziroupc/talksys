from pathlib import Path

p = Path('src/search-v45.js')
s = p.read_text()
needle = "import {\n  dedupeSearchResults,\n  hasUsefulSearchEvidence,\n  searchBingRss,\n  searchOpenStreetMapLocal,\n} from './search-fallbacks.js';\n"
replacement = needle + "import { fetchDirectPrimarySources } from './direct-primary-v45.js';\n"
if "./direct-primary-v45.js" not in s:
    if needle not in s: raise SystemExit('search import anchor not found')
    s = s.replace(needle, replacement, 1)

old = """  const r1 = Date.now();
  const first = await Promise.all(firstFacets.map(f => searchOne(f, deadline)));
  diagnostics.push(...first.map(x => x.diag));
  let merged = first.flatMap(x => x.results);
  let candidates = plan.candidateType === 'product_model' ? extractCandidates(merged,4) : [];
  timings.round1Ms = Date.now() - r1;"""
new = """  const r1 = Date.now();
  // A known manufacturer/model should not depend on a search index to discover
  // its own official page. Direct primary-source resolution runs beside the
  // single search index and never counts as a second search engine.
  const [first, directPrimary] = await Promise.all([
    Promise.all(firstFacets.map(f => searchOne(f, deadline))),
    fetchDirectPrimarySources(plan.resolvedQuestion, deadline),
  ]);
  diagnostics.push(...first.map(x => x.diag));
  let merged = [...(directPrimary.results || []), ...first.flatMap(x => x.results)];
  let candidates = plan.candidateType === 'product_model' ? extractCandidates(merged,4) : [];
  timings.round1Ms = Date.now() - r1;"""
if old not in s: raise SystemExit('round1 block not found')
s = s.replace(old, new, 1)

old = """  const hostCount = new Set(ranked.map(x => hostOf(x?.url)).filter(Boolean)).size;
  const evidenceUseful = ranked.length >= 2 || (ranked.length === 1 && ranked[0].queryGateScore >= 6);
  const sufficient = plan.researchMode === 'discover_then_verify'
    ? Boolean(candidates.length && evidenceUseful)
    : evidenceUseful;"""
new = """  const hostCount = new Set(ranked.map(x => hostOf(x?.url)).filter(Boolean)).size;
  const baseEvidenceUseful = ranked.length >= 2 || (ranked.length === 1 && ranked[0].queryGateScore >= 6);
  const requiresCurrentFirmwareVersion = /(最新|現在).*(BIOS|UEFI|ファームウェア)|(?:BIOS|UEFI|ファームウェア).*(最新|現在)/i.test(plan.resolvedQuestion);
  const hasCurrentFirmwareVersionEvidence = ranked.some((item) => {
    const body = `${item?.title || ''} ${item?.excerpt || item?.snippet || ''}`;
    const official = item?.primarySource === true || ['official_spec','official_support'].includes(item?.sourceRole);
    return official && /(?:version|ver\\.?|バージョン|BIOS)\\s*[:：v]?\\s*[a-z]?\\d+(?:[.\\-][a-z0-9]+)+/i.test(body);
  });
  const evidenceUseful = baseEvidenceUseful && (!requiresCurrentFirmwareVersion || hasCurrentFirmwareVersionEvidence);
  const sufficient = plan.researchMode === 'discover_then_verify'
    ? Boolean(candidates.length && evidenceUseful)
    : evidenceUseful;"""
if old not in s: raise SystemExit('evidence usefulness block not found')
s = s.replace(old, new, 1)

old = """    probeFailures: diagnostics.filter(x => !x.ok).length,
    probeDiagnostics: diagnostics,
    timings,"""
new = """    probeFailures: diagnostics.filter(x => !x.ok).length,
    probeDiagnostics: diagnostics,
    directPrimarySourceCount: (directPrimary.results || []).length,
    directPrimaryDiagnostics: directPrimary.diagnostics || [],
    directPrimaryTargets: (directPrimary.targets || []).map(x => ({ resolver: x.resolver, role: x.role, url: x.url, model: x.model })),
    requiresCurrentFirmwareVersion,
    hasCurrentFirmwareVersionEvidence,
    timings,"""
if old not in s: raise SystemExit('return diagnostics block not found')
s = s.replace(old, new, 1)
p.write_text(s)

p = Path('src/worker-v44.js')
s = p.read_text()
old = """        searchProvider: SEARCH_V45_PROVIDER,
        searchSingleProvider: true,
        searchStageAwareGate: true,"""
new = """        searchProvider: SEARCH_V45_PROVIDER,
        searchSingleProvider: true,
        searchDirectPrimaryResolver: true,
        searchPartialEvidenceAnswering: true,
        searchStageAwareGate: true,"""
if old not in s: raise SystemExit('health search provider block not found')
s = s.replace(old, new, 1)

old = """  if (!apiOk.length && !search.evidenceUseful) {
    answerSynthesisFallback = true;
    answerSynthesisError = 'external_evidence_unavailable_stable_only';
    try {
      answer = await runModel(env, [
        { role: 'system', content: CASUAL_PROMPT + '\\n今回の外部取得では十分な根拠が得られなかった。検索機能が無効・禁止・使えないとは絶対に説明しない。質問のうち、時間で変化しない一般的な判断基準・仕組み・注意点だけを具体的に答える。現在の価格、在庫、最新版、時刻、現行制度などは断定しない。現在情報が必要な部分は「今回の取得では確認できなかった」とだけ述べる。' },
        ...historyOf(normalizedBody?.history).slice(-8),
        { role: 'user', content: text },
      ], 420, 0.12, 6500);"""
new = """  if (!apiOk.length && !search.evidenceUseful) {
    answerSynthesisFallback = true;
    const partialEvidence = (search.results || []).slice(0, 5).map((item, index) =>
      `[${index + 1}] ${clean(item?.title, 180)}\\n${clean(item?.url, 500)}\\n${clean(item?.excerpt || item?.snippet, 1200)}`
    ).join('\\n\\n');
    answerSynthesisError = partialEvidence ? 'partial_external_evidence_stable_answer' : 'external_evidence_unavailable_stable_only';
    try {
      answer = await runModel(env, [
        { role: 'system', content: CASUAL_PROMPT + '\\n今回の外部取得では質問全体を確定できるだけの根拠が得られなかった。検索機能が無効・禁止・使えないとは絶対に説明しない。部分的な外部根拠がある場合は、そこから確認できる事実だけを明示し、不足する最新版・価格・在庫・時刻などを推測しない。加えて、時間で変化しない一般的な判断基準・仕組み・注意点は具体的に答えてよい。現在情報が必要なのに根拠がない部分は「今回の取得では確認できなかった」と述べる。' },
        ...(partialEvidence ? [{ role: 'system', content: `今回取得できた部分根拠（これ以外の外部事実は推測禁止）:\\n${partialEvidence}` }] : []),
        ...historyOf(normalizedBody?.history).slice(-8),
        { role: 'user', content: text },
      ], 480, 0.1, 6500);"""
if old not in s: raise SystemExit('stable-only block not found')
s = s.replace(old, new, 1)

old = """      probeFailures: search.probeFailures || 0,
      externalSubrequestBaseTarget: search.externalSubrequestBaseTarget || SEARCH_V44_EXTERNAL_SUBREQUEST_BASE_TARGET,"""
new = """      probeFailures: search.probeFailures || 0,
      directPrimarySourceCount: search.directPrimarySourceCount || 0,
      directPrimaryDiagnostics: search.directPrimaryDiagnostics || [],
      directPrimaryTargets: search.directPrimaryTargets || [],
      externalSubrequestBaseTarget: search.externalSubrequestBaseTarget || SEARCH_V44_EXTERNAL_SUBREQUEST_BASE_TARGET,"""
if old not in s: raise SystemExit('worker diagnostics block not found')
s = s.replace(old, new, 1)
p.write_text(s)

Path('tests/direct-primary-v45.test.mjs').write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveDirectPrimaryTargets, __test } from '../src/direct-primary-v45.js';

test('known MSI motherboard resolves official support and specification directly', () => {
  const targets = resolveDirectPrimaryTargets('MSI X79A-GD45の最新BIOSを公式で確認して');
  assert.ok(targets.some(x => x.url === 'https://jp.msi.com/Motherboard/X79A-GD45/Specification'));
  assert.ok(targets.some(x => x.url === 'https://jp.msi.com/Motherboard/X79A-GD45/support'));
  assert.ok(targets.every(x => x.model === 'X79A-GD45'));
});

test('direct source resolver does not invent URLs for unknown vendors', () => {
  assert.deepEqual(resolveDirectPrimaryTargets('謎メーカー ZZ-999 の最新BIOS'), []);
});

test('firmware evidence classifier requires version-like evidence for latest version claims', () => {
  assert.equal(__test.evidenceKind('X79A-GD45 BIOS provides Plug and Play BIOS').hasVersionLike, false);
  assert.equal(__test.evidenceKind('X79A-GD45 BIOS Version 2.8 2014-08-11').hasVersionLike, true);
});

test('worker advertises and returns partial primary-source diagnostics', () => {
  const worker = fs.readFileSync(new URL('../src/worker-v44.js', import.meta.url), 'utf8');
  assert.match(worker, /searchDirectPrimaryResolver: true/);
  assert.match(worker, /searchPartialEvidenceAnswering: true/);
  assert.match(worker, /partial_external_evidence_stable_answer/);
  assert.match(worker, /directPrimaryDiagnostics/);
});
''')

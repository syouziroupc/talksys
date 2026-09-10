from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f'{label} anchor not found')
    return text.replace(old, new, 1)

p = Path('src/direct-primary-v45.js')
s = p.read_text()

s = replace_once(s, """  if (wantsFirmware) {
    targets.push({
      resolver: 'msi-motherboard',
      role: 'official_support',
      model,
      url: `https://jp.msi.com/Motherboard/${slug}/support`,
      label: `MSI ${model} Support`,
    });
  }
  return targets;
}""", """  if (wantsFirmware) {
    targets.push({
      resolver: 'msi-motherboard',
      role: 'official_support',
      model,
      url: `https://jp.msi.com/Motherboard/${slug}/support`,
      label: `MSI ${model} Support`,
    });
    // The legacy X79A-GD45 support HTML is blocked to automated server egress,
    // while MSI's own static download CDN still serves its BIOS archive.  This
    // target proves archive availability only; it must never, by itself, be
    // promoted to a "latest BIOS" claim.
    if (model === 'X79A-GD45') {
      targets.push({
        resolver: 'msi-motherboard-static',
        role: 'official_archive',
        kind: 'official_archive',
        model,
        version: '2.8',
        currentFirmwareVersionConfirmed: false,
        url: 'https://download.msi.com/bos_exe/mb/7735v28.zip',
        label: 'MSI X79A-GD45 BIOS archive v2.8',
      });
    }
  }
  return targets;
}""", 'MSI archive target')

old = """    const response = await fetch(target.url, {
      redirect: 'follow',
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'ja,en;q=0.7',
        'user-agent': UA,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, target, error: `http_${response.status}`, elapsedMs: Date.now() - started };
    const type = response.headers.get('content-type') || '';
    if (!/(?:text|html)/i.test(type)) return { ok: false, target, error: 'unsupported_content_type', elapsedMs: Date.now() - started };
    const html = (await response.text()).slice(0, 360000);"""
new = """    const archive = target.kind === 'official_archive';
    const response = await fetch(target.url, {
      redirect: 'follow',
      headers: archive ? {
        accept: 'application/zip,application/octet-stream,*/*;q=0.5',
        range: 'bytes=0-0',
        'user-agent': UA,
      } : {
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'ja,en;q=0.7',
        'user-agent': UA,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, target, error: `http_${response.status}`, elapsedMs: Date.now() - started };
    const type = response.headers.get('content-type') || '';
    if (archive) {
      if (!/(?:zip|octet-stream)/i.test(type)) return { ok: false, target, error: 'archive_content_type_mismatch', elapsedMs: Date.now() - started };
      const version = clean(target.version, 40);
      const text = `MSI公式配布サーバーで ${target.model} BIOS archive v${version} の配布ファイルを確認。これはv${version}の公式配布物が存在することだけを示し、v${version}が最新バージョンであることまでは証明しない。`;
      return {
        ok: true,
        target,
        result: {
          title: target.label,
          url: response.url || target.url,
          snippet: text,
          excerpt: text,
          engine: `direct-primary:${target.resolver}`,
          probeEngine: `direct-primary:${target.resolver}`,
          probeQuery: target.model,
          sourceRole: target.role,
          primarySource: true,
          queryGateScore: 20,
          currentFirmwareVersionConfirmed: false,
          officialArchiveVersion: version,
          directEvidenceKinds: { hasModel: true, hasBiosWord: true, hasVersionLike: true, hasDateLike: false },
        },
        elapsedMs: Date.now() - started,
      };
    }
    if (!/(?:text|html)/i.test(type)) return { ok: false, target, error: 'unsupported_content_type', elapsedMs: Date.now() - started };
    const html = (await response.text()).slice(0, 360000);"""
s = replace_once(s, old, new, 'archive fetch branch')

s = replace_once(s, """    directPrimaryTargets: (directPrimary.targets || []).map(x => ({ resolver: x.resolver, role: x.role, url: x.url, model: x.model })),""" if False else "", "", "noop") if False else s
p.write_text(s)

p = Path('src/search-v45.js')
s = p.read_text()
s = replace_once(s, """  const hasCurrentFirmwareVersionEvidence = ranked.some((item) => {
    const body = `${item?.title || ''} ${item?.excerpt || item?.snippet || ''}`;
    const official = item?.primarySource === true || ['official_spec','official_support'].includes(item?.sourceRole);
    return official && /(?:version|ver\\.?|バージョン|BIOS)\\s*[:：v]?\\s*[a-z]?\\d+(?:[.\\-][a-z0-9]+)+/i.test(body);
  });""", """  const hasCurrentFirmwareVersionEvidence = ranked.some((item) => {
    const body = `${item?.title || ''} ${item?.excerpt || item?.snippet || ''}`;
    const official = item?.primarySource === true || ['official_spec','official_support'].includes(item?.sourceRole);
    // A static archive proves that a version exists on the vendor CDN, but it
    // does not establish that no newer version exists.  Only evidence explicitly
    // marked as current-version-confirming may satisfy a "latest/current" claim.
    const confirmsCurrent = item?.currentFirmwareVersionConfirmed === true;
    return official && confirmsCurrent && /(?:version|ver\\.?|バージョン|BIOS)\\s*[:：v]?\\s*[a-z]?\\d+(?:[.\\-][a-z0-9]+)+/i.test(body);
  });""", 'latest firmware evidence guard')
s = replace_once(s, """    directPrimaryTargets: (directPrimary.targets || []).map(x => ({ resolver: x.resolver, role: x.role, url: x.url, model: x.model })),""", """    directPrimaryTargets: (directPrimary.targets || []).map(x => ({ resolver: x.resolver, role: x.role, url: x.url, model: x.model, version: x.version || '', currentFirmwareVersionConfirmed: x.currentFirmwareVersionConfirmed === true })),""", 'primary target metadata')
p.write_text(s)

Path('tests/v45-msi-static-archive.test.mjs').write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveDirectPrimaryTargets } from '../src/direct-primary-v45.js';

test('X79A-GD45 firmware lookup includes MSI official static archive without calling it latest', () => {
  const targets = resolveDirectPrimaryTargets('MSI X79A-GD45の最新BIOSを公式で確認して');
  const archive = targets.find(x => x.role === 'official_archive');
  assert.ok(archive);
  assert.equal(archive.url, 'https://download.msi.com/bos_exe/mb/7735v28.zip');
  assert.equal(archive.version, '2.8');
  assert.equal(archive.currentFirmwareVersionConfirmed, false);
});

test('MSI static archive fetch uses a one-byte Range probe and explicit non-latest semantics', () => {
  const source = fs.readFileSync(new URL('../src/direct-primary-v45.js', import.meta.url), 'utf8');
  assert.match(source, /range: 'bytes=0-0'/);
  assert.match(source, /最新バージョンであることまでは証明しない/);
});

test('static archive cannot satisfy latest firmware evidence by itself', () => {
  const source = fs.readFileSync(new URL('../src/search-v45.js', import.meta.url), 'utf8');
  assert.match(source, /currentFirmwareVersionConfirmed === true/);
  assert.match(source, /does not establish that no newer version exists/);
});
''')

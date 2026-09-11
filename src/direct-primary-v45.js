// Direct primary-source resolution for facts where the user already supplied a
// concrete vendor/model.  This layer is intentionally small and deterministic:
// a resolver may only emit URLs whose structure is known for that vendor, and a
// fetched page is admitted only when it contains the requested model string.

const UA = 'Mozilla/5.0 TalkSys/45 (+https://talksys.syouziroupc.workers.dev)';

function clean(value, max = 3000) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalize(value) {
  return clean(value, 8000).normalize('NFKC').toLowerCase();
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function msiMotherboardResolver(question) {
  const match = clean(question).match(/\b(X79A-[A-Z0-9-]+)\b/i);
  if (!match) return [];
  const model = match[1].toUpperCase();
  const slug = encodeURIComponent(model);
  const wantsFirmware = /(BIOS|UEFI|ファームウェア|ドライバ|support|サポート)/i.test(question);
  const targets = [
    {
      resolver: 'msi-motherboard',
      role: 'official_spec',
      model,
      url: `https://jp.msi.com/Motherboard/${slug}/Specification`,
      label: `MSI ${model} Specification`,
    },
  ];
  if (wantsFirmware) {
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
}

const RESOLVERS = [msiMotherboardResolver];

export function resolveDirectPrimaryTargets(question) {
  const out = [];
  const seen = new Set();
  for (const resolver of RESOLVERS) {
    for (const target of resolver(question) || []) {
      if (!target?.url || seen.has(target.url)) continue;
      seen.add(target.url);
      out.push(target);
    }
  }
  return out.slice(0, 3);
}

function evidenceKind(text) {
  const value = normalize(text);
  return {
    hasModel: /x79a-[a-z0-9-]+/.test(value),
    hasBiosWord: /\bbios\b|uefi|firmware|ファームウェア/.test(value),
    hasVersionLike: /(?:version|ver\.?|バージョン|bios)\s*[:：v]?\s*[a-z]?\d+(?:[.\-][a-z0-9]+)+/i.test(text),
    hasDateLike: /\b20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b/.test(text),
  };
}

async function fetchOne(target, deadline) {
  const started = Date.now();
  const remaining = deadline - started;
  if (remaining < 350) return { ok: false, target, error: 'budget_exhausted', elapsedMs: 0 };
  const timeoutMs = Math.max(300, Math.min(1300, remaining - 100));
  try {
    const archive = target.kind === 'official_archive';
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
    const html = (await response.text()).slice(0, 360000);
    const text = stripHtml(html).slice(0, 5000);
    const model = normalize(target.model).replace(/\s+/g, '');
    const body = normalize(text).replace(/\s+/g, '');
    // Dynamic support shells that do not contain the requested model are not
    // treated as evidence merely because the URL returned HTTP 200.
    if (!text || !body.includes(model)) return { ok: false, target, error: 'model_not_in_page', elapsedMs: Date.now() - started };
    const kinds = evidenceKind(text);
    return {
      ok: true,
      target,
      result: {
        title: target.label,
        url: response.url || target.url,
        snippet: text.slice(0, 1500),
        excerpt: text.slice(0, 5000),
        engine: `direct-primary:${target.resolver}`,
        probeEngine: `direct-primary:${target.resolver}`,
        probeQuery: target.model,
        sourceRole: target.role,
        primarySource: true,
        queryGateScore: 20,
        directEvidenceKinds: kinds,
      },
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    return { ok: false, target, error: clean(error?.name || error?.message || error, 100) || 'fetch_failed', elapsedMs: Date.now() - started };
  }
}

export async function fetchDirectPrimarySources(question, deadline) {
  const targets = resolveDirectPrimaryTargets(question);
  if (!targets.length) return { results: [], diagnostics: [], targets: [] };
  const settled = await Promise.all(targets.map((target) => fetchOne(target, deadline)));
  return {
    targets,
    results: settled.filter((x) => x.ok && x.result).map((x) => x.result),
    diagnostics: settled.map((x) => ({
      engine: `direct-primary:${x.target?.resolver || 'unknown'}`,
      query: x.target?.model || '',
      role: x.target?.role || '',
      url: x.target?.url || '',
      ok: x.ok === true,
      count: x.ok ? 1 : 0,
      error: x.error || '',
      elapsedMs: Number(x.elapsedMs) || 0,
    })),
  };
}

export const __test = { evidenceKind, msiMotherboardResolver, stripHtml };

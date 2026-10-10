export const GROUNDING_EVIDENCE_REVISION = 'talksys-grounding-evidence-v110-r1';

export const GROUNDING_FAIL_CLOSED_ANSWER =
  '確認できる根拠を十分に取得できなかったため、推測では答えません。もう一度お尋ねいただければ再確認します。';

function compact(value, max = 12000) {
  return String(value ?? '').replace(/\r/g, '').trim().slice(0, max);
}

function groundingMetadata(payload = {}) {
  const candidate = Array.isArray(payload?.candidates) ? payload.candidates[0] : null;
  return candidate?.groundingMetadata || candidate?.grounding_metadata || {};
}

function normalizedRange(startValue, endValue, textLength) {
  const start = Number(startValue);
  const end = Number(endValue);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const s = Math.max(0, Math.min(textLength, Math.trunc(start)));
  const e = Math.max(s, Math.min(textLength, Math.trunc(end)));
  if (e <= s) return null;
  return { start: s, end: e };
}

export function groundingSearchPerformed(payload = {}) {
  const steps = Array.isArray(payload?.steps) ? payload.steps : [];
  if (steps.some((step) => /^google_search_/.test(String(step?.type || '')))) return true;
  const grounding = groundingMetadata(payload);
  return Array.isArray(grounding?.webSearchQueries) && grounding.webSearchQueries.length > 0;
}

export function groundingSources(payload = {}) {
  const out = [];
  const seen = new Set();
  const push = (url, title = '') => {
    const href = compact(url, 1200);
    if (!/^https?:\/\//i.test(href) || seen.has(href)) return;
    seen.add(href);
    out.push({ url: href, title: compact(title || href, 300) });
  };

  for (const step of Array.isArray(payload?.steps) ? payload.steps : []) {
    if (step?.type === 'model_output') {
      for (const part of Array.isArray(step?.content) ? step.content : []) {
        for (const annotation of Array.isArray(part?.annotations) ? part.annotations : []) {
          if (annotation?.type === 'url_citation') push(annotation?.url, annotation?.title);
        }
      }
    }
    if (step?.type === 'google_search_result') {
      for (const item of Array.isArray(step?.result) ? step.result : []) {
        push(item?.url || item?.uri, item?.title || item?.name);
      }
    }
  }

  const grounding = groundingMetadata(payload);
  for (const chunk of Array.isArray(grounding?.groundingChunks) ? grounding.groundingChunks : []) {
    const web = chunk?.web || {};
    push(web?.uri || web?.url, web?.title);
  }
  return out.slice(0, 24);
}

export function groundingCitationSpans(payload = {}, answer = '') {
  const text = String(answer ?? '');
  const out = [];
  const push = (startValue, endValue, url = '', title = '', source = '') => {
    const range = normalizedRange(startValue, endValue, text.length);
    if (!range) return;
    out.push({
      ...range,
      url: compact(url, 1200),
      title: compact(title, 300),
      source: compact(source, 80),
    });
  };

  for (const step of Array.isArray(payload?.steps) ? payload.steps : []) {
    if (step?.type !== 'model_output') continue;
    for (const part of Array.isArray(step?.content) ? step.content : []) {
      if (part?.type !== 'text') continue;
      for (const annotation of Array.isArray(part?.annotations) ? part.annotations : []) {
        if (annotation?.type !== 'url_citation') continue;
        push(
          annotation?.start_index ?? annotation?.startIndex,
          annotation?.end_index ?? annotation?.endIndex,
          annotation?.url,
          annotation?.title,
          'interactions-url-citation',
        );
      }
    }
  }

  const grounding = groundingMetadata(payload);
  const chunks = Array.isArray(grounding?.groundingChunks) ? grounding.groundingChunks : [];
  for (const support of Array.isArray(grounding?.groundingSupports) ? grounding.groundingSupports : []) {
    const segment = support?.segment || {};
    const indices = Array.isArray(support?.groundingChunkIndices)
      ? support.groundingChunkIndices
      : (Array.isArray(support?.grounding_chunk_indices) ? support.grounding_chunk_indices : []);
    const firstChunk = chunks[Number(indices[0])] || {};
    const web = firstChunk?.web || {};
    push(
      segment?.startIndex ?? segment?.start_index,
      segment?.endIndex ?? segment?.end_index,
      web?.uri || web?.url,
      web?.title,
      'generate-content-grounding-support',
    );
  }

  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

function citationCount(payload = {}) {
  let count = 0;
  for (const step of Array.isArray(payload?.steps) ? payload.steps : []) {
    if (step?.type !== 'model_output') continue;
    for (const part of Array.isArray(step?.content) ? step.content : []) {
      if (part?.type !== 'text') continue;
      for (const annotation of Array.isArray(part?.annotations) ? part.annotations : []) {
        if (annotation?.type === 'url_citation' && /^https?:\/\//i.test(compact(annotation?.url, 1200))) count += 1;
      }
    }
  }
  const grounding = groundingMetadata(payload);
  return count + (Array.isArray(grounding?.groundingSupports) ? grounding.groundingSupports.length : 0);
}

function factualSegments(answer = '') {
  const text = String(answer ?? '');
  const out = [];
  const re = /[^。！？!?\n]+[。！？!?]?/g;
  let match;
  while ((match = re.exec(text))) {
    const raw = match[0];
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const leading = raw.indexOf(trimmed);
    const start = match.index + Math.max(0, leading);
    const end = start + trimmed.length;
    if (/(?:確認でき|分かりません|わかりません|不明|推測|根拠|情報が見つかりません)/.test(trimmed)) continue;
    if (/[0-9０-９一-龠々ァ-ヶA-Za-z]/.test(trimmed)) out.push({ text: trimmed, start, end });
  }
  return out;
}

function hardClaims(answer = '') {
  const text = String(answer ?? '').normalize('NFKC');
  const patterns = [
    /\b\d{1,2}:\d{2}\b/g,
    /\b\d{1,2}時(?:\d{1,2}分)?/g,
    /\b\d{1,4}年\d{1,2}月\d{1,2}日/g,
    /\b\d{1,2}月\d{1,2}日/g,
    /(?:¥|￥|\$|€|£)\s?\d[\d,.]*/g,
    /\d[\d,.]*\s?(?:円|ドル|ユーロ|ポンド|%|％|km|m|cm|mm|kg|g|GB|MB|TB|MHz|GHz|人|件|台|本|個|便|号)/gi,
    /0\d{1,4}-\d{1,4}-\d{3,4}/g,
  ];
  const out = [];
  const seen = new Set();
  for (const re of patterns) {
    let match;
    while ((match = re.exec(text))) {
      const key = `${match.index}:${match[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text: match[0], start: match.index, end: match.index + match[0].length });
    }
  }
  return out;
}

function overlaps(span, start, end) {
  return span.start < end && span.end > start;
}

export function groundingEvidenceReport({ payload = {}, answer = '', required = false, highRisk = false } = {}) {
  const searched = groundingSearchPerformed(payload);
  const sources = groundingSources(payload);
  const citations = citationCount(payload);
  const spans = groundingCitationSpans(payload, answer);
  const reasons = [];

  if (!required) {
    return {
      required: false,
      highRisk: Boolean(highRisk),
      passed: true,
      searched,
      sourceCount: sources.length,
      citationCount: citations,
      citationSpanCount: spans.length,
      unsupportedClaimCount: 0,
      unsupportedHardClaimCount: 0,
      reasons,
    };
  }

  if (!searched) reasons.push('no_search');
  if (sources.length === 0) reasons.push('no_sources');
  if (citations === 0) reasons.push('no_citations');

  let unsupportedClaimCount = 0;
  let unsupportedHardClaimCount = 0;
  if (highRisk && citations > 0) {
    const segments = factualSegments(answer);
    unsupportedClaimCount = segments.filter((segment) => !spans.some((span) => overlaps(span, segment.start, segment.end))).length;
    const claims = hardClaims(answer);
    unsupportedHardClaimCount = claims.filter((claim) => !spans.some((span) => overlaps(span, claim.start, claim.end))).length;
    if (spans.length === 0) reasons.push('no_citation_spans');
    if (unsupportedClaimCount > 0) reasons.push('unsupported_claim_segment');
    if (unsupportedHardClaimCount > 0) reasons.push('unsupported_hard_claim');
  }

  return {
    required: true,
    highRisk: Boolean(highRisk),
    passed: reasons.length === 0,
    searched,
    sourceCount: sources.length,
    citationCount: citations,
    citationSpanCount: spans.length,
    unsupportedClaimCount,
    unsupportedHardClaimCount,
    reasons: [...new Set(reasons)],
  };
}

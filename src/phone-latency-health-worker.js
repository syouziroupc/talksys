const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function percentile(values, p) {
  if (!values.length) return null;
  const index = Math.max(0, Math.min(values.length - 1, Math.ceil(values.length * p) - 1));
  return values[index];
}

function summarize(rows = []) {
  const turns = new Map();
  for (const row of rows) {
    const turnId = String(row?.turn_id || '');
    const stage = String(row?.stage || '');
    const elapsed = Number(row?.elapsed_ms);
    if (!turnId || !stage || !Number.isFinite(elapsed)) continue;

    const turn = turns.get(turnId) || {
      createdAt: '',
      values: {},
      cacheHit: false,
      cacheMiss: false,
    };
    const createdAt = String(row?.created_at || '');
    if (!turn.createdAt || createdAt > turn.createdAt) turn.createdAt = createdAt;
    if (stage === 'ack_cache_hit') turn.cacheHit = true;
    else if (stage === 'ack_cache_miss') turn.cacheMiss = true;
    else turn.values[stage] = elapsed;
    turns.set(turnId, turn);
  }

  const completed = [...turns.values()]
    .filter((turn) => Number.isFinite(turn.values.ack_first_pcmu))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const ack = completed.map((turn) => turn.values.ack_first_pcmu).sort((a, b) => a - b);
  const latest = completed[0] || null;

  return {
    ok: true,
    revision: 'talksys-phone-latency-health-v1',
    metricDefinition: 'estimated caller speech end to first outbound receipt-backchannel PCMU frame',
    privacy: 'aggregate timing only; no phone numbers, call IDs, turn IDs, transcripts, or message content',
    generatedAt: new Date().toISOString(),
    sampleCount: ack.length,
    latestAt: latest?.createdAt || null,
    latestAckFirstPcmuMs: latest?.values?.ack_first_pcmu ?? null,
    latestVadFinalizeMs: latest?.values?.vad_finalize ?? null,
    latestSttEndMs: latest?.values?.stt_end ?? null,
    latestAckCacheHit: latest?.cacheHit ?? null,
    latestAckCacheMiss: latest?.cacheMiss ?? null,
    ackFirstPcmuMs: {
      min: ack.length ? ack[0] : null,
      p50: percentile(ack, 0.50),
      p95: percentile(ack, 0.95),
      max: ack.length ? ack[ack.length - 1] : null,
    },
    recent: completed.slice(0, 20).map((turn) => ({
      observedAt: turn.createdAt || null,
      ackFirstPcmuMs: turn.values.ack_first_pcmu ?? null,
      vadFinalizeMs: turn.values.vad_finalize ?? null,
      sttEndMs: turn.values.stt_end ?? null,
      ackCacheHit: turn.cacheHit,
      ackCacheMiss: turn.cacheMiss,
    })),
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'GET' || (url.pathname !== '/' && url.pathname !== '/health')) {
      return new Response(JSON.stringify({ ok: false, error: 'not_found' }), { status: 404, headers: JSON_HEADERS });
    }
    if (!env?.TALKSYS_LOG_DB?.prepare) {
      return new Response(JSON.stringify({ ok: false, error: 'd1_binding_unavailable' }), { status: 503, headers: JSON_HEADERS });
    }

    try {
      const result = await env.TALKSYS_LOG_DB.prepare(
        "SELECT turn_id, stage, elapsed_ms, created_at FROM phone_latency_events WHERE stage IN ('vad_finalize','stt_end','ack_cache_hit','ack_cache_miss','ack_first_pcmu') ORDER BY id DESC LIMIT 1000"
      ).all();
      return new Response(JSON.stringify(summarize(result?.results || []), null, 2), { status: 200, headers: JSON_HEADERS });
    } catch (error) {
      return new Response(JSON.stringify({
        ok: false,
        error: 'latency_query_failed',
        detail: String(error?.message || error).slice(0, 300),
      }), { status: 503, headers: JSON_HEADERS });
    }
  },
};

export const __test = { summarize, percentile };

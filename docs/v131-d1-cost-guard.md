# V131 D1 cost guard — draft branch only

This branch is NOT authorized for staging or production deployment before 2026-10-30. V130/main must remain unchanged.

## Observed account totals (2026-09-20 to 2026-10-19)

- D1 rows read: 36.43 billion. **This is the 30-billion-row figure.**
- D1 rows written: 53 million.
- These are Cloudflare account-level totals, not demonstrated TalkSys-only attribution.

## Implemented write reduction

The only production-path insertion point is inside \`appendLatencyEvent\`, immediately BEFORE calling D1. It invokes the deterministic pure function in \`src/telephony/phone-d1-write-policy.js\`.

- Default (missing or any value other than exactly \`compact\`): preserve ALL latency D1 writes.
- \`PHONE_D1_LATENCY_POLICY=compact\`: retain all faults, key STT/turn/answer timestamps, first PCMU timestamps, API and TTS usage, greeting measurements, profile load, slow events, and summaries.
- Other routine stages: persist full detail for 1 in 10 turns, chosen deterministically by turn ID.
- \`PHONE_D1_LATENCY_SAMPLE_ONE_IN=1\` keeps all events even in compact mode; valid range 1–100; invalid values use 10.
- \`PHONE_D1_LATENCY_SLOW_MS=5000\`: always persist slow events; range 1–600000.
- Existing console event logging occurs *before* the D1 guard and is unchanged.
- No changes to call records, messages, personalization, memory jobs, API usage, call status, voice routing, VAD, STT, TTS, or interruption handling.
- Reduced event inserts may also save index writes; actual savings require comparing database metrics.
- Critical events remain in D1, but earlier noncritical events sampled out cannot be retrospectively restored. Do not enable if every forensic D1 event is mandatory.

## Activation only after 2026-10-30 and explicit approval

1. Identify the responsible **database** and queries in Cloudflare D1 Metrics/Analytics. Account totals do not establish TalkSys responsibility.
2. Measure baseline D1 rows_read and rows_written by database and query class.
3. Test the compact policy with mock D1 and staging phone E2E; compare normal answers, STT/VAD, TTS, barge-in, message history, memory processing and admin latency views.
4. Explicitly set the opt-in policy. Do not modify default Wrangler vars or deploy automatically.
5. Compare write rows over matched workloads. Roll back by clearing policy or setting \`full\` if performance or diagnostics degrade.

## Separate read-side investigation

The 36.43B **read** rows are the larger cost concern. Use \`EXPLAIN QUERY PLAN\` against frequent SQL on the actual high-cost DB. Investigate full scans, unindexed filters, repeated DDL and maintenance joins.

Do not add indexes blindly; each secondary index creates extra write work. Confirm query-frequency evidence first.

Sources: Cloudflare D1 *Use indexes* and *Metrics and analytics*, 2026.

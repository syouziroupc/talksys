import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GROUNDING_EVIDENCE_REVISION,
  groundingCitationSpans,
  groundingEvidenceReport,
} from '../src/grounding-evidence-gate.js';

function interactionsPayload(answer, annotations = [], withSearch = true) {
  return {
    steps: [
      ...(withSearch ? [
        { type: 'google_search_call', arguments: { queries: ['別府駅 次の電車'] } },
        { type: 'google_search_result', result: [{ title: '公式時刻表', url: 'https://example.com/timetable' }] },
      ] : []),
      { type: 'model_output', content: [{ type: 'text', text: answer, annotations }] },
    ],
  };
}

test('v110 revision is stable', () => {
  assert.equal(GROUNDING_EVIDENCE_REVISION, 'talksys-grounding-evidence-v110-r1');
});

test('high-risk transit passes when the factual answer is fully cited', () => {
  const answer = '次は17時02分発の大神行きです。';
  const payload = interactionsPayload(answer, [{
    type: 'url_citation',
    start_index: 0,
    end_index: answer.length,
    url: 'https://example.com/timetable',
    title: '公式時刻表',
  }]);
  const report = groundingEvidenceReport({ payload, answer, required: true, highRisk: true });
  assert.equal(report.passed, true);
  assert.equal(report.sourceCount >= 1, true);
  assert.equal(report.citationCount >= 1, true);
  assert.equal(report.citationSpanCount >= 1, true);
  assert.equal(report.unsupportedHardClaimCount, 0);
});

test('search without a citation fails closed', () => {
  const answer = '次は17時02分発です。';
  const payload = interactionsPayload(answer, []);
  const report = groundingEvidenceReport({ payload, answer, required: true, highRisk: true });
  assert.equal(report.passed, false);
  assert.ok(report.reasons.includes('no_citations'));
});

test('uncited high-risk sentence and time are rejected even when another sentence is cited', () => {
  const first = '別府駅の時刻表を確認しました。';
  const second = '次は17時02分発です。';
  const answer = first + second;
  const payload = interactionsPayload(answer, [{
    type: 'url_citation',
    start_index: 0,
    end_index: first.length,
    url: 'https://example.com/timetable',
    title: '公式時刻表',
  }]);
  const report = groundingEvidenceReport({ payload, answer, required: true, highRisk: true });
  assert.equal(report.passed, false);
  assert.ok(report.reasons.includes('unsupported_claim_segment'));
  assert.ok(report.reasons.includes('unsupported_hard_claim'));
});

test('generateContent groundingSupports are accepted as citation spans', () => {
  const answer = '営業時間は18時までです。';
  const payload = {
    candidates: [{
      content: { parts: [{ text: answer }] },
      groundingMetadata: {
        webSearchQueries: ['店舗 営業時間'],
        groundingChunks: [{ web: { uri: 'https://example.com/shop', title: '店舗公式' } }],
        groundingSupports: [{
          segment: { startIndex: 0, endIndex: answer.length },
          groundingChunkIndices: [0],
        }],
      },
    }],
  };
  assert.equal(groundingCitationSpans(payload, answer).length, 1);
  const report = groundingEvidenceReport({ payload, answer, required: true, highRisk: true });
  assert.equal(report.passed, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { groundingEvidenceReport } from '../src/grounding-evidence-gate.js';
import { __test as integratedTest } from '../src/integrated-entry.js';
import { PHONE_RELEASE_VERSION, PHONE_PERSONALIZATION_ACTIVE_REVISION, PHONE_RUNTIME_LOG_REVISION } from '../src/telephony/index.js';

const integrated = fs.readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');
const telephony = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');

function searchedPayload(answer, annotations = []) {
  return {
    steps: [
      { type: 'google_search_call', arguments: { queries: ['別府駅 時刻表'] } },
      { type: 'google_search_result', result: [{ title: '時刻表', url: 'https://example.com/timetable' }] },
      { type: 'model_output', content: [{ type: 'text', text: answer, annotations }] },
    ],
  };
}

test('v121 treats search plus concrete sources as usable evidence even when citation metadata is omitted', () => {
  const answer = '次の列車は12時30分発です。';
  const report = groundingEvidenceReport({ payload: searchedPayload(answer), answer, required: true, highRisk: true });
  assert.equal(report.passed, false, 'v110 diagnostic report still records missing citation metadata');
  assert.ok(report.reasons.includes('no_citations'));
  assert.equal(integratedTest.groundingEvidenceUsable(report), true);
});

test('v121 still blocks evidence-free dynamic answers and hard claims explicitly contradicted by citation coverage', () => {
  const noSource = groundingEvidenceReport({ payload: {}, answer: '今日は晴れです。', required: true, highRisk: true });
  assert.equal(integratedTest.groundingEvidenceUsable(noSource), false);

  const first = '別府駅の情報を確認しました。';
  const second = '次は12時30分発です。';
  const answer = first + second;
  const partial = groundingEvidenceReport({
    payload: searchedPayload(answer, [{ type: 'url_citation', start_index: 0, end_index: first.length, url: 'https://example.com/timetable', title: '時刻表' }]),
    answer,
    required: true,
    highRisk: true,
  });
  assert.ok(partial.unsupportedHardClaimCount > 0);
  assert.equal(integratedTest.groundingEvidenceUsable(partial), false);
});

test('v121 never exposes the generic 推測では答えません sentence from the active Gemini turn path', () => {
  const start = integrated.indexOf('export async function runGeminiTurn');
  const end = integrated.indexOf('export async function commonTalkSysTurn', start);
  assert.ok(start >= 0 && end > start);
  const block = integrated.slice(start, end);
  assert.doesNotMatch(block, /GROUNDING_FAIL_CLOSED_ANSWER/);
  assert.match(block, /evidenceFailureClarification/);
  assert.match(block, /groundingEvidenceUsable/);
});

test('v121 emits grounding diagnostics into phone latency logs', () => {
  assert.match(telephony, /groundingEvidenceReasons:Array\.isArray\(turn\?\.payload\?\.groundingEvidenceReasons\)/);
  assert.match(telephony, /groundingSourceCount:Number\(turn\?\.payload\?\.groundingSourceCount\|\|0\)/);
  assert.match(telephony, /groundingCitationCount:Number\(turn\?\.payload\?\.groundingCitationCount\|\|0\)/);
});

test('phone history profile editing is dirty-safe while the 3 second call poll remains active', () => {
  assert.match(telephony, /profileDirty=false/);
  assert.match(telephony, /refreshProfile:false/);
  assert.match(telephony, /if\(profileDirty&&selectedPhone===nextPhone&&!force\)return/);
  assert.match(telephony, /setInterval\(async\(\)=>/);
  assert.match(telephony, /profileDirty=true/);
});

test('personalization screen exposes caller-scoped call history and conversation drill-down', () => {
  assert.match(telephony, /async function profileCalls\(request, env, phoneNumber\)/);
  assert.match(telephony, /WHERE from_number=\?/);
  assert.match(telephony, /profileCallsMatch=url\.pathname\.match/);
  assert.match(telephony, /id="profileCallHistory"/);
  assert.match(telephony, /id="profileCallMessages"/);
  assert.match(telephony, /loadProfileCalls\(selectedPhone\)/);
  assert.match(telephony, /loadProfileCallMessages/);
});

test('v121 phone logs identify the new release and personalization revision', () => {
  assert.equal(PHONE_RELEASE_VERSION, 'v121');
  assert.equal(PHONE_PERSONALIZATION_ACTIVE_REVISION, 'talksys-phone-personalization-v121-r1');
  assert.equal(PHONE_RUNTIME_LOG_REVISION, 'talksys-phone-runtime-log-v121-r1');
});

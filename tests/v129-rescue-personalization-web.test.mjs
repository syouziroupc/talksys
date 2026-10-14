// v129 rescue regression suite
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { thinkingLevelForQuestion, currentMarketFreshnessIssue, buildTalkSysSystemInstruction } from '../src/integrated-entry.js';
import { isTelephonyPath, PHONE_RELEASE_VERSION } from '../src/telephony/index.js';

test('v129 uses medium by default and reserves high for dynamic math/deadlines', () => {
  assert.equal(thinkingLevelForQuestion('ブラウザとは何ですか'), 'medium');
  assert.equal(thinkingLevelForQuestion('現在のドル円で500ドルを円換算して手数料3.25%を引いて'), 'high');
  assert.equal(thinkingLevelForQuestion('今から別府駅を出て16時30分までに博多へ間に合う？'), 'high');
  assert.equal(thinkingLevelForQuestion('今から別府駅から大分駅へ行く次の列車は？'), 'medium');
});

test('v129 detects the known TSE 15:00-close hallucination and stale intraday timestamps', () => {
  const now = new Date('2026-10-14T06:10:00Z');
  assert.equal(currentMarketFreshnessIssue('トヨタの現在の株価は？', '東証は15時で取引終了しました。', now), 'tse_close_time_1500');
  assert.equal(currentMarketFreshnessIssue('トヨタの現在の株価は？', '株価は3000円、13時00分時点です。', now), 'stale_intraday_quote');
  assert.equal(currentMarketFreshnessIssue('トヨタの現在の株価は？', '株価は3000円、15時08分時点です。', now), '');
});

test('system prompt is compact and preserves explicit terminology', () => {
  const prompt = buildTalkSysSystemInstruction(new Date('2026-10-14T09:00:00Z'), { forceSearch: true });
  assert.match(prompt, /ブラウザ、アカウント、Cloudflare/);
  assert.match(prompt, /Google検索/);
  assert.doesNotMatch(prompt, /発話禁止/);
  assert.doesNotMatch(prompt, /インターネットを見る画面/);
});

test('integrated Gemini path explicitly configures thinking and no longer post-replaces senior terms', async () => {
  const source = await readFile(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');
  assert.match(source, /generation_config:\s*\{ thinking_level: thinkingLevel \}/);
  assert.match(source, /thinkingConfig:\s*\{ thinkingLevel \}/);
  assert.match(source, /let answer = normalizeSpokenJapanese\(interaction\.answer\)/);
  assert.doesNotMatch(source, /let answer = simplifyForSenior\(normalizeSpokenJapanese\(interaction\.answer\)\)/);
});

test('phone personalization dashboard exposes read-only memory status behind the admin API', async () => {
  const source = await readFile(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
  assert.equal(PHONE_RELEASE_VERSION, 'v129');
  assert.equal(isTelephonyPath('/phone/api/profiles/%2B819012345678/memory-status'), true);
  assert.match(source, /id="memoryStatus"/);
  assert.match(source, /profileMemoryStatus/);
  assert.match(source, /phone_memory_state/);
  assert.match(source, /phone_memory_audit/);
  assert.match(source, /adminAuthorized\(request, env\)/);
  assert.doesNotMatch(source, /phone-memory-maintenance|runPhoneMemoryMaintenance/);
});

test('memory maintenance module remains unchanged and isolated from live telephony', async () => {
  const memorySource = await readFile(new URL('../src/phone-memory-maintenance.js', import.meta.url), 'utf8');
  assert.match(memorySource, /PHONE_MEMORY_REVISION/);
  assert.match(memorySource, /runPhoneMemoryMaintenance/);
});

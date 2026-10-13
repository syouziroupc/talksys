import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  PHONE_MEMORY_PRIMARY_MODEL,
  PHONE_MEMORY_SHADOW_MODEL,
  PHONE_MEMORY_REVISION,
  buildTranscript,
  evidenceAppearsInUserText,
  mergeProfileLines,
  phoneMemoryEnabled,
  validateExtraction,
} from '../src/phone-memory-maintenance.js';

const runtimeSource = fs.readFileSync(new URL('../src/runtime-entry.js', import.meta.url), 'utf8');
const telephonySource = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('background memory uses Gemini primary with Granite shadow and remains kill-switchable', () => {
  assert.equal(PHONE_MEMORY_PRIMARY_MODEL, 'gemini-3.5-flash-lite');
  assert.equal(PHONE_MEMORY_SHADOW_MODEL, '@cf/ibm-granite/granite-4.0-h-micro');
  assert.match(PHONE_MEMORY_REVISION, /phone-memory-maintenance/);
  assert.equal(phoneMemoryEnabled({ PHONE_MEMORY_ENABLED: 'true' }), true);
  assert.equal(phoneMemoryEnabled({ PHONE_MEMORY_ENABLED: 'false' }), false);
});

test('only evidence actually present in user speech is accepted', () => {
  const userTexts = ['Androidのスマホを使っています。ゆっくり説明してほしいです。'];
  assert.equal(evidenceAppearsInUserText('Androidのスマホを使っています。', userTexts), true);
  assert.equal(evidenceAppearsInUserText('iPhoneを使っています。', userTexts), false);

  const result = validateExtraction({
    preferred_name: { value: '', evidence: '', confidence: 0 },
    personalization: [
      { text: 'ゆっくり説明する', evidence: 'ゆっくり説明してほしいです。', confidence: 0.96 },
      { text: '短く説明する', evidence: '短く説明してください。', confidence: 0.99 },
    ],
    memory: [
      { text: 'Androidのスマホを使用', evidence: 'Androidのスマホを使っています。', confidence: 0.98 },
      { text: 'iPhoneを使用', evidence: 'iPhoneを使っています。', confidence: 0.99 },
    ],
  }, userTexts, { display_name: '' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.personalization.map((x) => x.text), ['ゆっくり説明する']);
  assert.deepEqual(result.memory.map((x) => x.text), ['Androidのスマホを使用']);
});

test('automatic preferred name requires explicit evidence and never replaces an existing manual name', () => {
  const userTexts = ['田中と呼んでください。'];
  const raw = {
    preferred_name: { value: '田中さん', evidence: '田中と呼んでください。', confidence: 0.97 },
    personalization: [],
    memory: [],
  };
  const fresh = validateExtraction(raw, userTexts, { display_name: '' });
  assert.equal(fresh.preferredName, '田中さん');
  const existing = validateExtraction(raw, userTexts, { display_name: 'たなか様' });
  assert.equal(existing.preferredName, 'たなか様');
});

test('memory merge is additive and deduplicates without deleting existing operator text', () => {
  const merged = mergeProfileLines('・Androidを使用\n・説明は一工程ずつ', [
    { text: 'Androidを使用' },
    { text: 'プリンター接続の相談が継続中' },
  ], 4000);
  assert.match(merged.text, /Androidを使用/);
  assert.match(merged.text, /説明は一工程ずつ/);
  assert.match(merged.text, /プリンター接続の相談が継続中/);
  assert.deepEqual(merged.added, ['プリンター接続の相談が継続中']);
});

test('transcript builder separates user and assistant roles for evidence checking', () => {
  const built = buildTranscript([
    { id: 10, role: 'user', content: 'Androidです。' },
    { id: 11, role: 'assistant', content: 'わかりました。' },
    { id: 12, role: 'system', content: 'ignore this' },
  ]);
  assert.equal(built.fromMessageId, 10);
  assert.equal(built.toMessageId, 11);
  assert.deepEqual(built.userTexts, ['Androidです。']);
  assert.match(built.transcript, /^利用者: Androidです。\nフォーンズ: わかりました。$/);
  assert.doesNotMatch(built.transcript, /ignore this/);
});

test('memory maintenance remains outside the live telephony source and scheduled wrapper delegates HTTP unchanged', () => {
  assert.doesNotMatch(telephonySource, /phone-memory-maintenance|runPhoneMemoryMaintenance/);
  assert.match(runtimeSource, /return integratedEntry\.fetch\(request, env, ctx\)/);
  assert.match(runtimeSource, /scheduled\(controller, env, ctx\)/);
  assert.match(runtimeSource, /runPhoneMemoryMaintenance\(env\)/);
  assert.match(wrangler, /"main"\s*:\s*"src\/runtime-entry\.js"/);
  assert.match(wrangler, /"crons"\s*:\s*\["15 18 \* \* \*"\]/);
  assert.match(wrangler, /"TELEPHONY_VAD_RMS"\s*:\s*"0\.0045"/);
  assert.match(wrangler, /"TELEPHONY_TTS_DELIVERY"\s*:\s*"loud-bright"/);
  assert.match(wrangler, /"TELEPHONY_TTS_OUTPUT_GAIN_DB"\s*:\s*"3\.0"/);
});

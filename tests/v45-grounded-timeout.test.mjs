import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mechanicalGroundedAnswer } from '../src/worker-v44.js';

test('World Bank evidence survives answer synthesis timeout without invented fallback facts', () => {
  const answer = mechanicalGroundedAnswer([{
    ok: true,
    tool: 'world_bank_wdi',
    attribution: 'World Bank Open Data (CC BY 4.0)',
    data: { latest: { country: 'Japan', countryCode: 'JPN', indicatorCode: 'NY.GDP.PCAP.CD', year: '2025', value: 32487.231 } },
  }], {}, '日本の一人当たりGDPは？');
  assert.match(answer, /2025年/);
  assert.match(answer, /一人当たりGDP/);
  assert.match(answer, /32,487\.23/);
  assert.match(answer, /World Bank/);
  assert.doesNotMatch(answer, /確認してください|概ね|一般的に知ら/);
});

test('web evidence is retained mechanically when grounded synthesis times out', () => {
  const answer = mechanicalGroundedAnswer([], { results: [
    { title: '公式仕様 A', excerpt: '候補Aの確認済み仕様です。', url: 'https://example.com/a' },
    { title: '販売情報 B', excerpt: '候補Bの確認済み価格情報です。', url: 'https://example.com/b' },
  ] }, '候補を比較して');
  assert.match(answer, /公式仕様 A/);
  assert.match(answer, /候補Aの確認済み仕様/);
  assert.match(answer, /販売情報 B/);
});

test('external research failure never falls back to ungrounded casual model', () => {
  const source = readFileSync(new URL('../src/worker-v44.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /data = await casualTurn\(normalizedBody, env, \{ fallbackError/);
  assert.match(source, /researchFailureTurn\(normalizedBody, error\)/);
  assert.match(source, /externalFailureUsesCasualModel: false/);
});

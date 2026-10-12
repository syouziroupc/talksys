import test from 'node:test';
import assert from 'node:assert/strict';
import { __test as integratedTest } from '../src/integrated-entry.js';
import { PHONE_RELEASE_VERSION, PHONE_RUNTIME_LOG_REVISION } from '../src/telephony/index.js';

const FIXED = new Date('2026-10-12T02:32:00Z'); // 11:32 JST

const areaFixture = {
  offices: {
    '440000': { name: '大分県', officeName: '大分地方気象台', parent: '010900', children: ['440010'] },
  },
  class10s: {
    '440010': { name: '中部', parent: '440000', children: ['440010'] },
  },
  class15s: {
    '440010': { name: '中部', parent: '440010', children: ['4420200'] },
  },
  class20s: {
    '4420200': { name: '別府市', kana: 'べっぷし', parent: '440010' },
  },
};

const forecastFixture = [{
  publishingOffice: '大分地方気象台',
  reportDatetime: '2026-10-12T11:00:00+09:00',
  timeSeries: [{
    timeDefines: [
      '2026-10-12T11:00:00+09:00',
      '2026-10-13T00:00:00+09:00',
    ],
    areas: [{
      area: { name: '中部', code: '440010' },
      weatherCodes: ['100', '213'],
      weathers: ['晴れ', 'くもり　昼過ぎ　から　時々　雨'],
      winds: ['北の風', '南の風'],
    }],
  }],
}];

test('v122 resolves Beppu City to the official Oita central forecast area', () => {
  const resolved = integratedTest.resolveJmaWeatherArea(areaFixture, '別府市の今日の天気は？');
  assert.deepEqual(resolved, {
    locationCode: '4420200',
    locationName: '別府市',
    weatherAreaCode: '440010',
    weatherAreaName: '中部',
    officeCode: '440000',
    officeName: '大分県',
    publishingOffice: '大分地方気象台',
  });
});

test('v122 selects today or tomorrow from JMA timeDefines without inventing values', () => {
  const resolved = integratedTest.resolveJmaWeatherArea(areaFixture, '別府市の今日の天気は？');
  const today = integratedTest.jmaWeatherAnswer(forecastFixture, resolved, '別府市の今日の天気は？', FIXED);
  assert.match(today.answer, /気象庁の予報では/);
  assert.match(today.answer, /別府市/);
  assert.match(today.answer, /大分県中部/);
  assert.match(today.answer, /今日は晴れ/);
  assert.equal(today.reportDatetime, '2026-10-12T11:00:00+09:00');

  const tomorrow = integratedTest.jmaWeatherAnswer(forecastFixture, resolved, '別府市の明日の天気は？', FIXED);
  assert.match(tomorrow.answer, /明日は/);
  assert.match(tomorrow.answer, /くもり/);
  assert.match(tomorrow.answer, /時々.*雨/);
});

test('v122 live turn uses JMA before Gemini for explicit Japanese weather queries', async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).endsWith('/bosai/common/const/area.json')) {
      return new Response(JSON.stringify(areaFixture), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (String(url).endsWith('/bosai/forecast/data/forecast/440000.json')) {
      return new Response(JSON.stringify(forecastFixture), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const result = await integratedTest.runGeminiTurn(
      { text: '別府市の今日の天気は？', history: [] },
      { GEMINI_API_KEY: 'unused-for-jma' },
      undefined,
      { now: FIXED },
    );
    assert.equal(urls.length, 2);
    assert.equal(result.route, 'structured-jma-weather');
    assert.equal(result.generationProvider, 'jma');
    assert.equal(result.generationModel, 'jma-forecast-json');
    assert.equal(result.groundingFailClosed, false);
    assert.equal(result.groundingEvidencePassed, true);
    assert.equal(result.groundingSourceCount, 1);
    assert.equal(result.search, true);
    assert.match(result.answer, /気象庁.*別府市.*晴れ/);
    assert.equal(result.sources.length, 1);
    assert.match(result.sources[0].url, /forecast\/440000\.json/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('v122 leaves under-specified transit clarification intact', () => {
  assert.equal(
    integratedTest.evidenceFailureClarification('次の別府駅の電車の時間は？'),
    '次の電車は行き先によって変わります。どちら方面か、行き先を教えてください。',
  );
});

test('v122 release metadata advances without changing phone audio transport', () => {
  assert.equal(PHONE_RELEASE_VERSION, 'v122');
  assert.equal(PHONE_RUNTIME_LOG_REVISION, 'talksys-phone-runtime-log-v122-r1');
});

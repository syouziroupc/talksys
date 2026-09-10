from pathlib import Path

p = Path('src/worker-v44.js')
s = p.read_text()
marker = "async function synthesizeGroundedAnswer(env, body, search) {"
helper = r'''function evidenceNumber(value, maximumFractionDigits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return clean(value, 80);
  return new Intl.NumberFormat('ja-JP', { maximumFractionDigits }).format(n);
}

export function mechanicalGroundedAnswer(apiResults = [], search = {}, question = '') {
  const ok = (apiResults || []).filter((x) => x?.ok);
  for (const item of ok) {
    const data = item?.data || {};
    if (item.tool === 'world_bank_wdi' && data.latest) {
      const x = data.latest;
      const labels = {
        'NY.GDP.PCAP.CD': '一人当たりGDP',
        'NY.GDP.MKTP.CD': 'GDP',
        'SP.POP.TOTL': '人口',
        'SL.UEM.TOTL.ZS': '失業率',
        'FP.CPI.TOTL.ZG': 'インフレ率',
        'SP.DYN.LE00.IN': '平均寿命',
        'SP.DYN.TFRT.IN': '合計特殊出生率',
      };
      const units = {
        'NY.GDP.PCAP.CD': '米ドル',
        'NY.GDP.MKTP.CD': '米ドル',
        'SP.POP.TOTL': '人',
        'SL.UEM.TOTL.ZS': '%',
        'FP.CPI.TOTL.ZG': '%',
        'SP.DYN.LE00.IN': '年',
      };
      const label = labels[x.indicatorCode] || clean(x.indicator, 100) || '値';
      const unit = clean(x.unit, 40) || units[x.indicatorCode] || '';
      return `${clean(x.year, 20)}年の${clean(x.country, 100) || clean(x.countryCode, 20)}の${label}は${evidenceNumber(x.value)}${unit}です。${clean(item.attribution, 180) || 'World Bank Open Data'}`;
    }
    if (item.tool === 'frankfurter' && Number.isFinite(Number(data.converted))) {
      return `${clean(data.date, 30)}のレートでは、${evidenceNumber(data.amount, 4)} ${clean(data.base, 10)}は${evidenceNumber(data.converted, 4)} ${clean(data.quote, 10)}です。1 ${clean(data.base, 10)}=${evidenceNumber(data.rate, 6)} ${clean(data.quote, 10)}です。${clean(item.attribution, 180)}`;
    }
    if (item.tool === 'jma_weather' && Array.isArray(data.periods) && data.periods.length) {
      const first = data.periods[0] || {};
      const pop = Array.isArray(data.precipitation) ? data.precipitation.find((x) => clean(x?.probabilityPercent, 10)) : null;
      const temp = Array.isArray(data.temperatures) ? data.temperatures.find((x) => clean(x?.celsius, 10)) : null;
      const extras = [pop ? `降水確率${clean(pop.probabilityPercent, 10)}%` : '', temp ? `気温${clean(temp.celsius, 10)}度` : ''].filter(Boolean).join('、');
      return `気象庁の取得データでは、${clean(data.targetArea, 100) || '対象地域'}の予報は「${clean(first.weather, 220)}」です。${extras ? `${extras}です。` : ''}${clean(item.attribution, 180)}`;
    }
    if (item.tool === 'nager_holidays' && Array.isArray(data.holidays) && data.holidays.length) {
      const named = data.holidays.find((x) => clean(question, 800).includes(clean(x?.localName, 120))) || data.holidays[0];
      return `${clean(named.localName || named.name, 160)}は${clean(named.date, 30)}です。${clean(item.attribution, 180)}`;
    }
    if (item.tool === 'crossref' && Array.isArray(data.works) && data.works.length) {
      const work = data.works[0];
      return `Crossrefで確認できた先頭の文献は「${clean(work.title, 400)}」です。${work.doi ? `DOIは${clean(work.doi, 180)}です。` : ''}${clean(item.attribution, 180)}`;
    }
  }
  if (ok.length) {
    const item = ok[0];
    return `構造化APIから根拠は取得できました。取得値は ${clean(JSON.stringify(item.data ?? {}), 1200)}。${clean(item.attribution, 180)}`;
  }
  const web = (search?.results || []).filter((x) => !x?.structuredApi).slice(0, 3);
  if (web.length) {
    const facts = web.map((x) => `${clean(x?.title, 180)}: ${clean(x?.excerpt || x?.snippet, 420)}`).filter(Boolean).join(' / ');
    return `回答生成がタイムアウトしたため、取得済みのWeb根拠だけを返します。${facts}`;
  }
  return '外部情報を取得できなかったため、現在情報は断定しません。';
}

function researchFailureTurn(body, error) {
  const text = canonicalizeInput(body?.text, 1800);
  return {
    ok: true,
    answer: '外部情報を取得できなかったため、現在情報は断定しません。',
    search: true,
    searchUseful: false,
    searchFallback: true,
    route: 'research-failure-v45',
    resolvedQuestion: text,
    queries: [],
    sources: [],
    timings: { totalMs: 0, glmMs: 0 },
    model: 'mechanical-guard',
    planner: 'unified-router-v45',
    languageMode: 'ja-only',
    researchError: clean(error?.message || error, 280),
  };
}

'''
if 'export function mechanicalGroundedAnswer' not in s:
    if marker not in s:
        raise SystemExit('synthesis marker not found')
    s = s.replace(marker, helper + marker)

old = '''  if (webFallbackUsed) {
    const searchStarted = Date.now();
    search = await runDeepSearchV44(env.AI, text, history, requestSignal);
    searchMs = Date.now() - searchStarted;
  } else {
'''
new = '''  let webResearchError = '';
  if (webFallbackUsed) {
    const searchStarted = Date.now();
    try {
      search = await runDeepSearchV44(env.AI, text, history, requestSignal);
    } catch (error) {
      webResearchError = clean(error?.message || error, 240);
      if (!apiOk.length) throw error;
      search = {
        revision: SEARCH_V44_REVISION,
        evidenceUseful: true,
        results: [],
        rounds: 0,
        coverage: { sufficient: true, reason: 'structured API evidence retained after web research failure' },
        plan: { resolvedQuestion: text, queries: [], facets: [] },
        researchMode: 'api_retained_after_web_failure',
        candidateType: 'none',
        queryResultGate: true,
        authorityAfterRelevance: true,
        subrequestBudgetAware: true,
      };
    }
    searchMs = Date.now() - searchStarted;
  } else {
'''
if old in s:
    s = s.replace(old, new)
elif "let webResearchError = '';" not in s:
    raise SystemExit('web search block target not found')

old2 = "  const answer = await synthesizeGroundedAnswer(env, normalizedBody, search);\n"
new2 = '''  let answer;
  let answerSynthesisFallback = false;
  let answerSynthesisError = '';
  try {
    answer = await synthesizeGroundedAnswer(env, normalizedBody, search);
  } catch (error) {
    answerSynthesisFallback = true;
    answerSynthesisError = clean(error?.message || error, 240);
    answer = { text: mechanicalGroundedAnswer(apiOk, search, text), ms: 0 };
  }
'''
if old2 in s:
    s = s.replace(old2, new2)
elif 'let answerSynthesisFallback = false;' not in s:
    raise SystemExit('answer target not found')

if 'answerSynthesisFallback,\n    answerSynthesisError,' not in s:
    s = s.replace("    apiSources,\n    search: webFallbackUsed,\n", "    apiSources,\n    answerSynthesisFallback,\n    answerSynthesisError,\n    webResearchError,\n    search: webFallbackUsed,\n")

old3 = '''        } catch (error) {
          data = await casualTurn(normalizedBody, env, { fallbackError: error?.message || error });
        }
'''
new3 = '''        } catch (error) {
          data = researchFailureTurn(normalizedBody, error);
        }
'''
if old3 in s:
    s = s.replace(old3, new3)
elif 'data = researchFailureTurn(normalizedBody, error);' not in s:
    raise SystemExit('outer fallback target not found')

if 'groundedEvidenceFallback: true' not in s:
    s = s.replace("        modelTimeoutFallback: true,\n", "        modelTimeoutFallback: true,\n        groundedEvidenceFallback: true,\n        externalFailureUsesCasualModel: false,\n")
if 'mechanicalGroundedAnswer,' not in s.split('export const __test = {', 1)[1]:
    s = s.replace("  boundedPromise,\n", "  boundedPromise,\n  mechanicalGroundedAnswer,\n")
assert "data = await casualTurn(normalizedBody, env, { fallbackError" not in s
assert "worker-v43" not in s
p.write_text(s)

t = Path('tests/v45-grounded-timeout.test.mjs')
t.write_text(r'''import test from 'node:test';
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
''')

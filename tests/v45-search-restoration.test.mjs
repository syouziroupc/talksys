import test from 'node:test';
import assert from 'node:assert/strict';
import { SEARCH_V45_GENERAL_WEB_SEARCH_ENABLED, SEARCH_V44_MAX_ENGINE_RETRIES, SEARCH_V45_PROVIDER, __test as searchTest } from '../src/search-v45.js';
import { resolveDirectPrimaryTargets } from '../src/direct-primary-v45.js';
import { classifyTurn } from '../src/worker-v44.js';

test('v45 general web search is enabled with rotation and retries', () => {
  assert.equal(SEARCH_V45_GENERAL_WEB_SEARCH_ENABLED, true);
  assert.ok(SEARCH_V44_MAX_ENGINE_RETRIES >= 2);
  assert.match(SEARCH_V45_PROVIDER, /rotating-web/);
});

test('known used-PC price query is routed to seller evidence, not manufacturer support', () => {
  const plan = searchTest.simplePlan('CF-SV8の現在の中古価格を調べて、安い候補を教えて', []);
  assert.equal(plan.intent, 'shopping');
  assert.equal(plan.facets[0].sourceRole, 'seller');
  assert.match(plan.facets[0].primaryQuery, /CF-SV8.*中古.*価格/);
});

test('news query receives news evidence role and latin entity tokenization', () => {
  const plan = searchTest.simplePlan('OpenAIの今日の最新ニュースを検索して', []);
  assert.equal(plan.intent, 'news');
  assert.equal(plan.facets[0].sourceRole, 'news');
  assert.ok(searchTest.queryTerms('OpenAI 今日 最新ニュース').includes('openai'));
});

test('X79A model implies MSI primary resolver without requiring user to say MSI', () => {
  const targets = resolveDirectPrimaryTargets('X79A-GD45の最新BIOSを公式情報から確認して');
  assert.ok(targets.some(x => /msi\.com/i.test(x.url)));
});

test('short comparative shopping follow-up inherits external lookup need', () => {
  const history = [
    { role: 'user', content: '2万円以下で中古ノートPCを探して' },
    { role: 'assistant', content: '候補を確認します。' },
  ];
  const decision = classifyTurn('その中でもっと安いのある？', history);
  assert.equal(decision.mode, 'external');
  assert.equal(decision.webSearch, true);
});

test('explicit no-external request still wins', () => {
  const decision = classifyTurn('検索は使わないで、一般論だけ教えて', []);
  assert.equal(decision.webSearch, false);
  assert.equal(decision.noExternal, true);
});

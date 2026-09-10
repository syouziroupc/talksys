import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { __test as router } from '../src/worker-v44.js';

test('v45 turn router has no v43 worker dependency', () => {
  const source = fs.readFileSync(new URL('../src/worker-v44.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /worker-v43/);
  assert.doesNotMatch(source, /baseWorker\.fetch/);
});

test('explicit no-search instructions dominate routing', () => {
  for (const q of [
    'Web検索は使わないで。RAMとSSDの違いを説明して',
    '外部アクセス禁止。HTTP 404って何？',
    '検索禁止で答えて。RAMとは何？',
  ]) {
    const d = router.classifyTurn(q, []);
    assert.notEqual(d.mode, 'external');
    assert.equal(d.webSearch, false);
  }
});

test('stable knowledge and conversation remain local', () => {
  assert.equal(router.shouldSearchByDefault('RAMとSSDの違いを説明して'), false);
  assert.equal(router.shouldSearchByDefault('HTTP 404って何？'), false);
  assert.equal(router.shouldSearchByDefault('今日は疲れた'), false);
  assert.equal(router.shouldSearchByDefault('さっき何について話してた？'), false);
});

test('current or explicitly researched facts still use research route', () => {
  assert.equal(router.classifyTurn('MSI X79A-GD45のBIOS最新バージョンを調べて').mode, 'external');
  assert.equal(router.shouldSearchByDefault('MSI X79A-GD45のBIOS最新バージョンを調べて'), true);
  assert.equal(router.shouldSearchByDefault('パナのCF-SV8、中古で今いくら？'), true);
});

test('old phone-specialized delegation is disabled', () => {
  assert.equal(router.shouldPreserveSpecializedTurn('Xperiaの最新価格を調べて', []), false);
  assert.equal(router.shouldPreserveSpecializedTurn('どこで買えばいい？', [{ role:'user', content:'安いスマホがほしい' }]), false);
});

test('NFKC and spoken Japanese are canonicalized before routing', () => {
  assert.equal(router.canonicalizeInput('Ｐａｎａｓｏｎｉｃ ＣＦ－ＳＶ８'), 'Panasonic CF-SV8');
  assert.match(router.canonicalizeInput('べっぷのきょうのてんき'), /別府の今日のてんき/);
});

test('deterministic questions do not touch web search', () => {
  const cases = [
    ['12345÷15はいくつ？', /823/],
    ['24800円を15%引きするといくら？', /21,080/],
    ['2進数1010は10進数でいくつ？', /10/],
    ['華氏86度は摂氏何度？', /30/],
    ['2025年2月29日は存在する？', /存在しません/],
  ];
  for (const [q, expected] of cases) {
    const d = router.classifyTurn(q, []);
    assert.equal(d.mode, 'deterministic', q);
    assert.equal(d.webSearch, false, q);
    assert.match(d.deterministic.answer, expected, q);
  }
});

test('bare numbers and unresolved Chuo ward are clarified before search', () => {
  const bare = router.classifyTurn('42', []);
  assert.equal(bare.mode, 'clarify');
  assert.equal(bare.reason, 'bare_number');

  const ward = router.classifyTurn('中央区の中古PC店を探して。ただしどの中央区か分からないなら勝手に都市を決めないで', []);
  assert.equal(ward.mode, 'clarify');
  assert.equal(ward.webSearch, false);

  assert.equal(router.classifyTurn('東京都中央区の中古PC店を探して', []).mode, 'external');
});

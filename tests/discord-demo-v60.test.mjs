import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DISCORD_DEMO_REVISION,
  __test,
} from '../src/integrated-entry.js';

const {
  verifyDiscordSignature,
  discordQuestion,
  discordContent,
} = __test;

test('Discord demo revision and slash command parsing are stable', () => {
  assert.equal(DISCORD_DEMO_REVISION, 'talksys-discord-demo-v1');
  assert.equal(discordQuestion({
    type: 2,
    data: {
      name: 'talk',
      options: [{ name: 'question', value: '別府駅から大分駅の次の電車は？' }],
    },
  }), '別府駅から大分駅の次の電車は？');
  assert.equal(discordQuestion({ type: 2, data: { name: 'other', options: [] } }), '');
});

test('Discord formatter includes verified sources without allowing overlong messages', () => {
  const content = discordContent({
    answer: '確認した回答です。',
    sources: [
      { title: '公式情報', url: 'https://example.com/official' },
      { title: '無効', url: 'javascript:alert(1)' },
    ],
  });
  assert.match(content, /確認した回答です/);
  assert.match(content, /公式情報/);
  assert.match(content, /https:\/\/example\.com\/official/);
  assert.doesNotMatch(content, /javascript:/);
  assert.ok(content.length <= 1950);
});

test('Discord signature verifier fails closed on missing or malformed credentials', async () => {
  assert.equal(await verifyDiscordSignature({}), false);
  assert.equal(await verifyDiscordSignature({
    bodyText: '{}',
    signature: 'zz',
    timestamp: '1',
    publicKey: '00',
  }), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { handleTelephonyRequest } from '../src/telephony/index.js';

test('phone profiles inline browser script parses and binds the display button', async () => {
  const response = await handleTelephonyRequest(new Request('https://example.test/phone-profiles'), {}, {}, {});
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /id="loginBtn"/);
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'inline browser script must exist');
  assert.doesNotThrow(() => new vm.Script(match[1]), 'rendered browser script must be valid JavaScript');

  const elements = new Map();
  const makeElement = (id) => ({
    id,
    value: '',
    textContent: '',
    innerHTML: '',
    className: '',
    dataset: {},
    classList: { add() {}, remove() {} },
    addEventListener() {},
    querySelectorAll() { return []; },
  });
  const context = {
    sessionStorage: { getItem() { return ''; }, setItem() {} },
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeElement(id));
        return elements.get(id);
      },
      querySelectorAll() { return []; },
    },
    location: { href: 'https://example.test/phone-profiles' },
    history: { replaceState() {} },
    alert() {},
    console,
    URL,
    String,
    Number,
    Boolean,
    Date,
    Error,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(match[1], context);
  assert.equal(typeof context.document.getElementById('loginBtn').onclick, 'function');
});

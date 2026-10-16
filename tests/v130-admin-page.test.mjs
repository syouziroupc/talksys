import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { v130AdminPage } from '../src/v130-admin-page.js';
import { isV130LogManagementPath } from '../src/v130-log-management.js';

test('V130 admin dashboard includes required management controls', () => {
  const html = v130AdminPage(new Request('https://example.test/phone'));
  assert.match(html, /TalkSys 電話管理/);
  const required = ['loginBtn','reloadTop','q','status','lifecycle','from','to','callRows','trashSelected','restoreSelected','jsonlBtn','latency','profileEditor','saveProfileBtn','trashPhoneLogsBtn','trashUserBtn','purgeUserBtn','trashView'];
  for (const id of required) assert.equal(html.includes(`id="${id}"`), true, `missing ${id}`);
  const start = html.indexOf('<script>');
  const end = html.lastIndexOf('</script>');
  assert.ok(start >= 0 && end > start, 'inline script must exist');
  const script = html.slice(start + 8, end);
  assert.doesNotThrow(() => new vm.Script(script), 'dashboard script must parse');
});

test('V130 log management routes never match realtime audio endpoints', () => {
  assert.equal(isV130LogManagementPath('/phone/api/v130/calls'), true);
  assert.equal(isV130LogManagementPath('/phone/api/v130/calls/trash'), true);
  assert.equal(isV130LogManagementPath('/phone/api/v130/trash'), true);
  assert.equal(isV130LogManagementPath('/phone/api/v130/users/%2B819012345678/logs/trash'), true);
  assert.equal(isV130LogManagementPath('/telnyx/media'), false);
  assert.equal(isV130LogManagementPath('/api/transcribe'), false);
  assert.equal(isV130LogManagementPath('/api/turn'), false);
});

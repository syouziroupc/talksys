import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const updater = fs.readFileSync(new URL('../discord-voice-smoke/update-and-start.ps1', import.meta.url), 'utf8');
const readme = fs.readFileSync(new URL('../discord-voice-smoke/README.md', import.meta.url), 'utf8');

test('Discord update launcher only fast-forwards a clean local checkout', () => {
  assert.match(updater, /git status --porcelain/);
  assert.match(updater, /git fetch origin main/);
  assert.match(updater, /git rev-parse --abbrev-ref HEAD/);
  assert.match(updater, /git merge-base --is-ancestor HEAD origin\/main/);
  assert.match(updater, /git merge --ff-only origin\/main/);
  assert.match(updater, /ローカル変更があります/);
  assert.match(updater, /Discord試験は main ブランチで実行してください/);
  assert.match(updater, /先行または分岐しています/);
  assert.doesNotMatch(updater, /reset --hard|clean -f/);
});

test('Discord update launcher starts the existing secret-aware launcher after update', () => {
  assert.match(updater, /start\.ps1/);
  assert.match(updater, /git rev-parse --short HEAD/);
  assert.match(readme, /update-and-start\.ps1/);
  assert.match(readme, /\[capture\] finalized/);
  assert.match(readme, /\[stt\] confirmed Whisper start/);
  assert.match(readme, /\[metrics\] voice latency persisted/);
  assert.doesNotMatch(readme, /WebSocket先行接続|batch STT|\/api\/turn-stream/);
});


test('Discord launcher supervises the bridge process and restarts unexpected exits', () => {
  const launcher = fs.readFileSync(new URL('../discord-voice-smoke/start.ps1', import.meta.url), 'utf8');
  assert.match(launcher, /\[supervisor\] starting Discord bridge process/);
  assert.match(launcher, /& node \$entry/);
  assert.match(launcher, /Restarting in 2 seconds/);
  assert.match(launcher, /\$rapidFailures -ge 5/);
  assert.match(launcher, /短時間に5回連続で異常終了/);
});

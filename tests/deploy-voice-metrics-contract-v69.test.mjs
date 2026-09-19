import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const deploy = fs.readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');

test('production deploy verifies Discord latency logging contract', () => {
  assert.match(deploy, /discordVoiceMetricsEndpoint==='\/api\/voice-metrics'/);
  assert.match(deploy, /persistentConversationLogs==='d1-private'/);
  assert.match(deploy, /conversationLogEndpoint==='\/api\/conversation-logs'/);
  assert.match(deploy, /\$PRODUCTION_URL\/api\/voice-metrics/);
  assert.match(deploy, /metrics_code=.*%\{http_code\}/s);
  assert.match(deploy, /Discord voice metrics correctly requires the permanent shared token/);
});

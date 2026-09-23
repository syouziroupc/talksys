import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const bridge = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');

test('v85 suppresses adjacent completed duplicate turns without broad long-term dedupe', () => {
  assert.match(bridge, /RECENT_USER_TURN_WINDOW_MS = 2500/);
  assert.match(bridge, /recentAcceptedUserTurns/);
  assert.match(bridge, /looksLikeRecentUserDuplicate/);
  assert.match(bridge, /adjacent completed duplicate/);
  assert.match(bridge, /rememberAcceptedUserTurn\(confirmedTranscript, userId, timeline\)/);
});

test('v85 only applies transcript corroboration to short speech that started during bot playback', () => {
  assert.match(bridge, /shouldDropUncorroboratedBotOverlap/);
  assert.match(bridge, /captureMetrics\?\.overlappedBotPlayback/);
  assert.match(bridge, /BOT_OVERLAP_SHORT_TEXT_MAX = 12/);
  assert.match(bridge, /captureMetrics\?\.realtimeTranscript/);
  assert.match(bridge, /!sameUtterance\(confirmed, realtime\)/);
  assert.match(bridge, /bot-overlap-unconfirmed/);
});

test('v85 preserves explicit stop and short correction barge-ins', () => {
  assert.match(bridge, /policy\?\.action === 'interrupt'/);
  assert.match(bridge, /違う\|ちがう\|いや\|そうじゃない\|それ違う\|訂正/);
  assert.match(bridge, /interruptActiveAnswer\('explicit-user-stop'\)/);
});

test('Whisper remains authoritative for the final TalkSys turn', () => {
  assert.match(bridge, /const turn = await talk\(confirmedTranscript, utteranceId, controller\.signal\)/);
  assert.match(bridge, /geminiInputText: confirmedTranscript/);
});

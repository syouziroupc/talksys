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

test('Whisper remains authoritative primary text for the final TalkSys turn', () => {
  assert.match(bridge, /const turn = await talk\(confirmedTranscript, utteranceId, controller\.signal, speechAlternatives\)/);
  assert.match(bridge, /geminiInputText: confirmedTranscript/);
});


test('v85 pre-answer cue arbiter prevents wait cue and fast reaction from speaking independently', () => {
  assert.match(bridge, /let preAnswerCueSerial = 0/);
  assert.match(bridge, /activeWaitCue\?\.stop\?\.\('fast-reaction-won'\)/);
  assert.match(bridge, /cueSerial !== preAnswerCueSerial/);
  assert.match(bridge, /preAnswerCueSerial \+= 1;[\s\S]*final-answer-ready/);
});


test('v87 Discord Windows TTS uses the same Japanese voice preference family as Web', () => {
  assert.match(bridge, /Nanami/);
  assert.match(bridge, /Haruka\|Sayaka\|Ichiro\|Keita/);
  assert.match(bridge, /Google\.\*\(日本語\|Japanese\)/);
  assert.match(bridge, /voice=' \+ \[string\]\$pick\.VoiceInfo\.Name/);
});


test('Windows TTS selector avoids complex Sort-Object syntax and stays PowerShell 5.1 friendly', () => {
  assert.match(bridge, /foreach\(\$v in \$ja\)/);
  assert.match(bridge, /\$best=-1/);
  assert.doesNotMatch(bridge, /Sort-Object @\{Expression/);
  assert.match(bridge, /\$s\.SelectVoice\(\[string\]\$pick\.VoiceInfo\.Name\)/);
});

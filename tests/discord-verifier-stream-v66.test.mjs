import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');
const discord = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');

test('Discord no longer has a private final-answer stream endpoint', () => {
  assert.doesNotMatch(server, /url\.pathname === '\/api\/turn-stream'/);
  assert.doesNotMatch(discord, /\/api\/turn-stream|talkStream|event\?\.type === 'sentence'/);
  assert.match(discord, /TALKSYS_BASE_URL \+ '\/api\/turn'/);
});

test('v84 common web/Discord turn runner is single-pass grounded', () => {
  assert.match(server, /export async function commonTalkSysTurn/);
  assert.match(server, /return runGeminiTurn\(body, env, signal, options\)/);
  assert.match(server, /shouldRunGenericVerification\(_text = '', _payload = \{\}\)/);
  assert.match(server, /reason: 'v84-single-pass-grounded'/);
  assert.doesNotMatch(server, /if \(shouldRunGenericVerification\(text, interaction\.payload\)\)/);
  assert.match(server, /const result = await commonTalkSysTurn\(commonBody, env, signal\)/);
});

test('immediate transit guard remains inside the same common runner', () => {
  assert.match(server, /const immediateTransit = isImmediateTransitQuestion\(text\)/);
  assert.match(server, /while \(pastImmediateTransitDepartures\(interaction\.answer, now\)\.length > 0/);
  assert.match(discord, /const turn = await talk\(confirmedTranscript/);
});

test('Discord commits conversation history only from the completed common /api/turn response', () => {
  assert.match(discord, /const body = await response\.json\(\)\.catch/);
  assert.match(discord, /if \(body\.interactionId\) previousInteractionId = body\.interactionId/);
  assert.match(discord, /history\.push\(\{ role: 'user', content: text \}, \{ role: 'assistant', content: body\.answer \}\)/);
  assert.doesNotMatch(discord, /sentenceCount|doneBody|onSentence/);
});

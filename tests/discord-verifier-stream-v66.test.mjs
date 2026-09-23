import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');
const discord = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');

test('Discord final-answer endpoint uses the same common final-answer runner as web', () => {
  assert.match(server, /export async function commonTalkSysTurn/);
  assert.match(server, /return runGeminiTurn\(body, env, signal, options\)/);
  assert.match(server, /const result = await commonTalkSysTurn\(commonBody, env, signal\)/);
  assert.match(server, /discordTurnStreamResponse[\s\S]*runTalkSysTurn\(request, env, commonBody, request\.signal, ctx\)/);
  assert.doesNotMatch(server, /type: 'speculative'/);
});

test('generic verification stays entirely inside the common runner before Discord emits sentences', () => {
  const common = server.indexOf('export async function commonTalkSysTurn');
  const discordStream = server.indexOf('function discordTurnStreamResponse');
  assert.ok(common >= 0);
  assert.ok(discordStream > common);
  assert.match(server, /shouldRunGenericVerification\(text, interaction\.payload\)/);
  assert.match(server, /runGenericGeminiVerification\(env, body, interaction, signal, now\)/);
  assert.match(server, /await emitFinalAnswer\(result\.answer\)/);
  assert.doesNotMatch(server.slice(discordStream), /createGeminiInteractionStream\(/);
});

test('immediate transit inherits the exact web temporal guard through commonTalkSysTurn', () => {
  assert.match(server, /const immediateTransit = isImmediateTransitQuestion\(text\)/);
  assert.match(server, /while \(pastImmediateTransitDepartures\(interaction\.answer, now\)\.length > 0/);
  assert.match(server, /commonTalkSysTurn\(commonBody, env, signal\)/);
  assert.doesNotMatch(server.slice(server.indexOf('function discordTurnStreamResponse')), /isImmediateTransitQuestion\(text\)/);
});

test('Discord turn stream is private, SSE, logged, and exposes common timing metadata', () => {
  assert.match(server, /url\.pathname === '\/api\/turn-stream'/);
  assert.match(server, /discordVoiceTtsAuthorized\(request, env\)/);
  assert.match(server, /text\/event-stream; charset=utf-8/);
  assert.match(server, /runTalkSysTurn\(request, env, commonBody, request\.signal, ctx\)/);
  assert.match(server, /primaryMs: result\?\.timings\?\.primaryMs/);
  assert.match(server, /verifierMs: result\?\.timings\?\.verifierMs/);
  assert.match(server, /answerGenerationTotalMs: result\?\.timings\?\.totalMs/);
});

test('Discord consumes final sentence events and commits history only from the final done event', () => {
  assert.match(discord, /async function talkStream\(text, onSentence, utteranceId = '', signal\)/);
  assert.match(discord, /event\?\.type === 'sentence'/);
  assert.match(discord, /onSentence\(String\(event\.text\)\)/);
  assert.match(discord, /event\?\.type === 'done'/);
  assert.match(discord, /history\.push\(\{ role: 'user', content: text \}, \{ role: 'assistant', content: doneBody\.answer \}\)/);
  assert.doesNotMatch(discord, /onSpeculative|speculativeText|speculativeAudioPromise/);
});

test('legacy batch turn remains as a no-stream fallback', () => {
  assert.match(discord, /TALKSYS_BASE_URL \+ '\/api\/turn'/);
  assert.match(discord, /falling back to \/api\/turn/);
  assert.match(discord, /return \{ answer: await talk\(text, utteranceId, signal\), streamed: false/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('../src/integrated-entry.js', import.meta.url), 'utf8');
const discord = fs.readFileSync(new URL('../discord-voice-smoke/src/index.mjs', import.meta.url), 'utf8');

test('Discord final-answer endpoint streams the verifier rather than the unverified primary answer', () => {
  const primary = server.indexOf('primary = await createGeminiInteraction');
  const verifier = server.indexOf('createGeminiInteractionStream(env, verifyBody');
  const emitVerifier = server.indexOf("event?.event_type === 'step.delta'");
  assert.ok(primary >= 0);
  assert.ok(verifier > primary);
  assert.ok(emitVerifier > verifier);
  assert.match(server, /text: buildGenericVerificationInput\(body, primary, now\)/);
  assert.match(server, /stream: true/);
  assert.match(server, /delta\?\.type === 'text'/);
});

test('streamed final sentences stay behind generic verification and preserve the batch fallback', () => {
  assert.match(server, /if \(!shouldRunGenericVerification\(text, primary\.payload\)\)/);
  assert.match(server, /runGenericGeminiVerification\(env, body, primary, request\.signal, now\)/);
  assert.match(server, /verificationFailOpen = true/);
  assert.match(server, /if \(emittedSentences === 0 && primary\)/);
  assert.match(server, /emittedSentences >= 4/);
});

test('immediate transit keeps the complete temporal guard before any streamed speech', () => {
  assert.match(server, /if \(isImmediateTransitQuestion\(text\)\) \{/);
  assert.match(server, /const result = await runGeminiTurn\(body, env, request\.signal, \{ now \}\)/);
  assert.match(server, /await emitWholeAnswer\(result\.answer\)/);
});

test('Discord turn stream is private, SSE, logged, and exposes timing metadata', () => {
  assert.match(server, /url\.pathname === '\/api\/turn-stream'/);
  assert.match(server, /discordVoiceTtsAuthorized\(request, env\)/);
  assert.match(server, /text\/event-stream; charset=utf-8/);
  assert.match(server, /scheduleConversationLog\(ctx, env, request, body, result, 'turn', 200\)/);
  assert.match(server, /primaryMs/);
  assert.match(server, /verifierMs/);
});

test('Discord consumes sentence events immediately and only commits history on the final done event', () => {
  assert.match(discord, /async function talkStream\(text, onSentence\)/);
  assert.match(discord, /event\?\.type === 'sentence'/);
  assert.match(discord, /onSentence\(String\(event\.text\)\)/);
  assert.match(discord, /event\?\.type === 'done'/);
  assert.match(discord, /history\.push\(\{ role: 'user', content: text \}, \{ role: 'assistant', content: doneBody\.answer \}\)/);
  assert.match(discord, /const audioPromise = synthesize\(sentence\)/);
});

test('legacy batch turn remains as a no-stream fallback', () => {
  assert.match(discord, /TALKSYS_BASE_URL \+ '\/api\/turn'/);
  assert.match(discord, /falling back to \/api\/turn/);
  assert.match(discord, /return \{ answer: await talk\(text\), streamed: false/);
});

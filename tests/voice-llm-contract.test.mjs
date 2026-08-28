import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/worker.js', import.meta.url), 'utf8');
const realtime = await readFile(new URL('../src/realtime-voice-client.js', import.meta.url), 'utf8');
const fallback = await readFile(new URL('../src/voice-fallback-client.js', import.meta.url), 'utf8');

test('voice routes casual chat to GPT-OSS 20B and grounded facts to GPT-OSS 120B', () => {
  assert.match(source, /CASUAL_VOICE_MODEL\s*=\s*'@cf\/openai\/gpt-oss-20b'/);
  assert.match(source, /GROUNDED_VOICE_MODEL\s*=\s*'@cf\/openai\/gpt-oss-120b'/);
  assert.match(source, /await\s+this\.env\.AI\.run\(\s*CASUAL_VOICE_MODEL/);
  assert.match(source, /await\s+this\.env\.AI\.run\(\s*GROUNDED_VOICE_MODEL/);
});

test('casual path allows useful 2 to 4 sentence replies on 20B', () => {
  assert.match(source, /原則2〜4文/);
  assert.match(source, /max_tokens:\s*220/);
  assert.match(source, /casualPrompt:\s*'gptoss20b-balanced-2-4-sentences'/);
  assert.match(source, /casualResponseSentences:\s*'2-4'/);
});

test('GPT-OSS grounded path uses documented messages/max_tokens style', () => {
  assert.match(source, /function\s+groundedChatInput/);
  assert.match(source, /max_tokens:\s*420/);
  assert.match(source, /GROUNDED_VOICE_MODEL,[\s\S]*groundedChatInput/);
});

test('grounded prompt forbids unsupported external and screen claims', () => {
  assert.match(source, /検索結果にない固有名詞、数値、日付、仕様を勝手に補完しない/);
  assert.match(source, /実際に行っていないPC操作/);
  assert.match(source, /現在画面を断定できるのは/);
});

test('screen intent and web search are mutually exclusive', () => {
  assert.match(source, /const\s+screenIntent\s*=\s*mightNeedScreen\(transcript\)/);
  assert.match(source, /const\s+searchIntent\s*=\s*!screenIntent\s*&&\s*needsWebSearch\(transcript\)/);
});

test('cloud TTS is skipped and device ja-JP is production speech path', () => {
  assert.match(source, /beforeSynthesize\(\)\s*\{\s*return null;/);
  assert.match(source, /connectionGreetingTts:\s*false/);
  assert.match(source, /cloudTtsDisabled:\s*true/);
  assert.match(source, /ttsPrimary:\s*'device-ja-JP'/);
});

test('device TTS events suppress PCM and VAD to prevent self-listening', () => {
  assert.match(fallback, /talksys:tts-start/);
  assert.match(fallback, /talksys:tts-end/);
  assert.match(realtime, /TTS_ECHO_GUARD_MS\s*=\s*350/);
  assert.match(realtime, /function\s+micSuppressedForTts/);
  assert.match(realtime, /if\s*\(micSuppressedForTts\(\)\)\s*\{[\s\S]*?resetSpeechDetection\(\);[\s\S]*?return;/);
  assert.match(realtime, /window\.addEventListener\('talksys:tts-start',\s*handleDeviceTtsStart\)/);
  assert.match(realtime, /window\.addEventListener\('talksys:tts-end',\s*handleDeviceTtsEnd\)/);
  assert.match(source, /selfSpeechGuard:\s*true/);
  assert.match(source, /halfDuplexDuringDeviceTts:\s*true/);
  assert.match(source, /bargeIn:\s*false/);
});

test('voice mirrors finalized assistant text in complete transcript format', () => {
  assert.match(source, /type:\s*'transcript'/);
  assert.match(source, /role:\s*'assistant'/);
  assert.match(source, /text:\s*reply/);
});

test('voice health exposes GPT-OSS v10 grounding and echo guard', () => {
  assert.match(source, /VOICE_REVISION\s*=\s*'grounded-gptoss-v10'/);
  assert.match(source, /webSearch:\s*true/);
  assert.match(source, /webSearchPolicy:\s*'knowledge-questions-default-search'/);
  assert.match(source, /webSearchEngine:\s*'wikipedia\+bing-html\+google-news'/);
  assert.match(source, /searchRelevanceFilter:\s*true/);
  assert.match(source, /ttsEchoGuardMs:\s*350/);
});

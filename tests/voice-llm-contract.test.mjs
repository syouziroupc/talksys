import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/worker.js', import.meta.url), 'utf8');
const realtime = await readFile(new URL('../src/realtime-voice-client.js', import.meta.url), 'utf8');
const fallback = await readFile(new URL('../src/voice-fallback-client.js', import.meta.url), 'utf8');
const streaming = await readFile(new URL('../src/streaming-workers-ai.js', import.meta.url), 'utf8');

test('voice uses one unified Qwen 3.8 27B runtime model', () => {
  assert.match(streaming, /LIVE_VOICE_MODEL\s*=\s*'@cf\/qwen\/qwen3\.8-27b'/);
  assert.match(streaming, /ai\.run\(LIVE_VOICE_MODEL/);
  assert.match(streaming, /reasoning_effort:\s*null/);
  assert.match(streaming, /enable_thinking:\s*false/);
});

test('casual path allows useful 2 to 4 sentence replies', () => {
  assert.match(source, /原則2〜4文/);
  assert.match(source, /max_tokens:\s*220/);
  assert.match(source, /casualResponseSentences:\s*'2-4'/);
});

test('grounded questions still search but do not switch to another runtime model', () => {
  assert.match(source, /function\s+groundedChatInput/);
  assert.match(source, /max_tokens:\s*420/);
  assert.match(source, /const\s+searchIntent\s*=\s*!screenIntent\s*&&\s*needsWebSearch\(transcript\)/);
  assert.match(source, /streamWorkersAIText\(this\.env\.AI,\s*model,\s*input/);
});

test('LLM response is streamed into early speech chunks', () => {
  assert.match(source, /assistant_stream_start/);
  assert.match(source, /assistant_speech_chunk/);
  assert.match(source, /assistant_stream_end/);
  assert.match(source, /llmStreaming:\s*true/);
  assert.match(source, /incrementalSpeechChunks:\s*true/);
  assert.match(fallback, /talksys:assistant-speech-chunk/);
});

test('typed chat is routed to the same voice agent instance', () => {
  assert.match(fallback, /agents\/talk-sys-voice-agent\/default/);
  assert.match(fallback, /type:\s*'text_message'/);
  assert.match(fallback, /form\.addEventListener\('submit',[\s\S]*true\)/);
  assert.match(fallback, /stopImmediatePropagation\(\)/);
});

test('grounded prompt forbids unsupported external and screen claims', () => {
  assert.match(source, /検索結果にない固有名詞、数値、日付、仕様を勝手に補完しない/);
  assert.match(source, /実際に行っていないPC操作/);
  assert.match(source, /現在画面を断定できるのは/);
});

test('cloud TTS is skipped and device ja-JP streams chunks', () => {
  assert.match(source, /beforeSynthesize\(\)\s*\{\s*return null;/);
  assert.match(source, /cloudTtsDisabled:\s*true/);
  assert.match(source, /ttsPrimary:\s*'device-ja-JP-streamed-chunks'/);
  assert.match(fallback, /speechSynthesis\.speak\(makeUtterance\(text, generation\)\)/);
});

test('40ms capture and safe barge-in are enabled', () => {
  assert.match(realtime, /CHUNK_SAMPLES\s*=\s*640/);
  assert.match(realtime, /SILENCE_MS\s*=\s*520/);
  assert.match(realtime, /TTS_BARGE_FRAMES\s*=\s*4/);
  assert.match(realtime, /function\s+processBargeIn/);
  assert.match(realtime, /talksys:barge-in/);
  assert.match(source, /halfDuplexDuringDeviceTts:\s*false/);
  assert.match(source, /bargeIn:\s*true/);
});

test('assistant echo is filtered after barge-in', () => {
  assert.match(source, /function\s+looksLikeAssistantEcho/);
  assert.match(source, /echoTranscriptFilter:\s*true/);
  assert.match(source, /looksLikeAssistantEcho\(text,\s*recentAssistant\)/);
});

test('voice mirrors finalized assistant text in complete transcript format', () => {
  assert.match(source, /type:\s*'transcript'/);
  assert.match(source, /role:\s*'assistant'/);
  assert.match(source, /text:\s*reply/);
});

test('voice health exposes live stream v11 and Gemini Live upgrade path', () => {
  assert.match(source, /VOICE_REVISION\s*=\s*'live-stream-v11'/);
  assert.match(source, /webSearchPolicy:\s*'knowledge-questions-default-search'/);
  assert.match(source, /geminiLivePreferredWhenConfigured:\s*true/);
  assert.match(source, /api\/gemini-live-token/);
});

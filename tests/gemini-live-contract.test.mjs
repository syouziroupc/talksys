import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GEMINI_LIVE_V13_CLIENT } from '../src/gemini-live-v13-client.js';
import { GEMINI_TRANSCRIBE_COMPANION } from '../src/gemini-transcribe-companion.js';

const workerSource = fs.readFileSync(new URL('../src/worker-v13.js', import.meta.url), 'utf8');
const wranglerSource = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const desktopSource = fs.readFileSync(new URL('../desktop/gemini-live.js', import.meta.url), 'utf8');
const desktopTranscribe = fs.readFileSync(new URL('../desktop/gemini-transcribe.js', import.meta.url), 'utf8');
const desktopHtml = fs.readFileSync(new URL('../desktop/index.html', import.meta.url), 'utf8');

test('Gemini Live v13.1 is the primary native audio path', () => {
  assert.match(GEMINI_LIVE_V13_CLIENT, /gemini-3\.1-flash-live-preview/);
  assert.match(GEMINI_LIVE_V13_CLIENT, /CHUNK_SAMPLES = 640/);
  assert.match(GEMINI_LIVE_V13_CLIENT, /audio\/pcm;rate=/);
  assert.match(GEMINI_LIVE_V13_CLIENT, /thinkingLevel: 'LOW'/);
  assert.match(GEMINI_LIVE_V13_CLIENT, /voiceName: 'Kore'/);
  assert.doesNotMatch(GEMINI_LIVE_V13_CLIENT, /SpeechSynthesisUtterance/);
  assert.match(wranglerSource, /"main":\s*"src\/worker-v13\.js"/);
});

test('conversation transcription is Japanese SMART mode with custom vocabulary', () => {
  assert.match(GEMINI_LIVE_V13_CLIENT, /inputAudioTranscription:/);
  assert.match(GEMINI_LIVE_V13_CLIENT, /languageCodes: \['ja-JP'\]/);
  assert.match(GEMINI_LIVE_V13_CLIENT, /customVocabulary: CUSTOM_VOCABULARY/);
  assert.match(GEMINI_LIVE_V13_CLIENT, /mode: 'SMART'/);
  assert.match(GEMINI_LIVE_V13_CLIENT, /interimInputTranscription/);
  assert.match(GEMINI_LIVE_V13_CLIENT, /TRANSCRIPT_GRACE_MS = 520/);
});

test('dedicated Gemini 3.5 Transcribe companion improves displayed Japanese transcript', () => {
  assert.match(GEMINI_TRANSCRIBE_COMPANION, /gemini-3\.5-transcribe-live/);
  assert.match(GEMINI_TRANSCRIBE_COMPANION, /purpose: 'transcription'/);
  assert.match(GEMINI_TRANSCRIBE_COMPANION, /languageCodes: \['ja-JP'\]/);
  assert.match(GEMINI_TRANSCRIBE_COMPANION, /customVocabulary: CUSTOM_VOCABULARY/);
  assert.match(GEMINI_TRANSCRIBE_COMPANION, /mode: 'SMART'/);
  assert.match(GEMINI_TRANSCRIBE_COMPANION, /interimInputTranscription/);
  assert.match(GEMINI_TRANSCRIBE_COMPANION, /inputTranscription/);
  assert.match(GEMINI_TRANSCRIBE_COMPANION, /高精度文字起こし/);
});

test('hybrid VAD ends speech quickly while server VAD remains enabled', () => {
  assert.match(GEMINI_LIVE_V13_CLIENT, /LOCAL_END_SILENCE_MS = 560/);
  assert.match(GEMINI_LIVE_V13_CLIENT, /audioStreamEnd: true/);
  assert.match(GEMINI_LIVE_V13_CLIENT, /automaticActivityDetection:/);
  assert.match(GEMINI_LIVE_V13_CLIENT, /disabled: false/);
  assert.match(GEMINI_LIVE_V13_CLIENT, /silenceDurationMs: 800/);
  assert.match(GEMINI_LIVE_V13_CLIENT, /START_OF_ACTIVITY_INTERRUPTS/);
});

test('search, long conversation and typed chat stay inside one Live session', () => {
  assert.match(GEMINI_LIVE_V13_CLIENT, /googleSearch: \{\}/);
  assert.match(GEMINI_LIVE_V13_CLIENT, /sessionResumption:/);
  assert.match(GEMINI_LIVE_V13_CLIENT, /contextWindowCompression:/);
  assert.match(GEMINI_LIVE_V13_CLIENT, /SESSION_ROTATE_MS = 12 \* 60 \* 1000/);
  assert.match(GEMINI_LIVE_V13_CLIENT, /realtimeInput: \{ text \}/);
  assert.doesNotMatch(GEMINI_LIVE_V13_CLIENT, /clientContent:/);
  assert.match(GEMINI_LIVE_V13_CLIENT, /ちょっと調べますね/);
});

test('screen inspection is a Gemini function tool and unsupported claims are forbidden', () => {
  assert.match(GEMINI_LIVE_V13_CLIENT, /inspect_current_screen/);
  assert.match(GEMINI_LIVE_V13_CLIENT, /toolResponse:/);
  assert.match(GEMINI_LIVE_V13_CLIENT, /ツール結果にない画面内容/);
  assert.match(GEMINI_LIVE_V13_CLIENT, /\/api\/locate/);
});

test('worker serves v13.1, both model-bound token purposes, and keeps API key server-side', () => {
  assert.match(workerSource, /VOICE_REVISION = 'gemini-live-v13\.1'/);
  assert.match(workerSource, /GEMINI_LIVE_V13_CLIENT/);
  assert.match(workerSource, /GEMINI_TRANSCRIBE_COMPANION/);
  assert.match(workerSource, /GEMINI_TRANSCRIBE_MODEL = 'gemini-3\.5-transcribe-live'/);
  assert.match(workerSource, /purpose === 'transcription'/);
  assert.match(workerSource, /parallelHighAccuracyTranscription: true/);
  assert.match(workerSource, /spokenSearchWaitPhrase: true/);
  assert.match(workerSource, /typedChatTransport: 'realtimeInput\.text'/);
  assert.match(workerSource, /liveConnectConstraints: \{ model: `models\/\$\{model\}` \}/);
  assert.match(workerSource, /uses: 1/);
  assert.match(workerSource, /x-goog-api-key/);
  assert.match(workerSource, /gemini-transcribe\.js/);
  assert.doesNotMatch(GEMINI_LIVE_V13_CLIENT + GEMINI_TRANSCRIBE_COMPANION, /GEMINI_API_KEY/);
});

test('desktop uses Gemini native conversation and dedicated transcription rather than WebSpeech', () => {
  assert.match(desktopSource, /gemini-3\.1-flash-live-preview/);
  assert.match(desktopSource, /realtimeInput: \{ text:/);
  assert.match(desktopSource, /languageCodes: \['ja-JP'\]/);
  assert.match(desktopSource, /googleSearch: \{\}/);
  assert.match(desktopSource, /inspect_current_screen/);
  assert.match(desktopSource, /audioStreamEnd: true/);
  assert.match(desktopSource, /voiceName: 'Kore'/);
  assert.doesNotMatch(desktopSource, /SpeechRecognition|SpeechSynthesisUtterance/);
  assert.match(desktopTranscribe, /gemini-3\.5-transcribe-live/);
  assert.match(desktopTranscribe, /purpose: 'transcription'/);
  assert.match(desktopTranscribe, /languageCodes: \['ja-JP'\]/);
  assert.match(desktopTranscribe, /customVocabulary: CUSTOM_VOCABULARY/);
  assert.match(desktopTranscribe, /mode: 'SMART'/);
  assert.doesNotMatch(desktopTranscribe, /SpeechRecognition|SpeechSynthesisUtterance/);
  assert.match(desktopHtml, /script src="gemini-live\.js"/);
  assert.match(desktopHtml, /script src="gemini-transcribe\.js"/);
  assert.doesNotMatch(desktopHtml, /realtime-voice\.js|voice-fallback\.js|renderer\.js/);
  assert.match(desktopHtml, /wss:\/\/generativelanguage\.googleapis\.com/);
});
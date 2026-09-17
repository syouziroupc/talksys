import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TALK_CLIENT_V45, CLIENT_REVISION, INTERACTION_REVISION } from '../src/talk-client-v45.js';
import { TALK_HTML_V45, UI_REVISION } from '../src/ui-v45.js';
import { STT_MODEL, STT_REVISION, analyzeWav, weakSpeechSignal } from '../src/stt-v45.js';

const worker = fs.readFileSync(new URL('../src/worker-v44.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const deploy = fs.readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');

test('v45 shell no longer delegates UI or voice to the legacy worker', () => {
  assert.doesNotMatch(worker, /import\(['"]\.\/worker\.js['"]\)|fetchShell\(/);
  assert.doesNotMatch(worker, /routeAgentRequest|@cloudflare\/voice|\/agents\//);
  assert.match(worker, /TALK_HTML_V45/);
  assert.match(worker, /TALK_CLIENT_V45/);
  assert.match(worker, /transcribeV45/);
});

test('v45 microphone client keeps the proven HTTP adaptive-VAD path', () => {
  assert.equal(CLIENT_REVISION, 'talksys-v46-streaming-vad');
  assert.equal(INTERACTION_REVISION, 'talksys-v52-native-gemini-3-5-flash-lite-r1');
  assert.match(TALK_CLIENT_V45, /getUserMedia/);
  assert.match(TALK_CLIENT_V45, /createScriptProcessor/);
  assert.match(TALK_CLIENT_V45, /\/api\/transcribe/);
  assert.match(TALK_CLIENT_V45, /\/api\/turn/);
  assert.match(TALK_CLIENT_V45, /noiseBoost/);
  assert.match(TALK_CLIENT_V45, /calibrationUntil/);
  assert.match(TALK_CLIENT_V45, /雑音候補を自動破棄/);
  assert.match(TALK_CLIENT_V45, /previousInteractionId:geminiInteractionId/);
  assert.match(TALK_CLIENT_V45, /planner:'gemini-native'/);
  assert.match(TALK_CLIENT_V45, /__TALKSYS_CLIENT_REVISION__='talksys-v46-streaming-vad'/);
  assert.match(TALK_CLIENT_V45, /__TALKSYS_INTERACTION_REVISION__='talksys-v52-native-gemini-3-5-flash-lite-r1'/);
  assert.doesNotMatch(TALK_CLIENT_V45, /new\s+WebSocket|\/agents\//);
});

test('emergency text input can preempt an in-flight or spoken turn', () => {
  assert.match(TALK_CLIENT_V45, /非常文字入力で現在の応答を割込み/);
  assert.match(TALK_CLIENT_V45, /turnSeq\+\+/);
  assert.match(TALK_CLIENT_V45, /speechSynthesis&&window\.speechSynthesis\.cancel/);
  assert.doesNotMatch(TALK_CLIENT_V45, /if\(!v\|\|busy\)return/);
});

test('voice interaction is slightly faster without changing the proven transport', () => {
  assert.match(TALK_CLIENT_V45, /u\.rate=1\.12/);
  assert.match(TALK_CLIENT_V45, /SILENCE_MS=480/);
});

test('v45 UI contains current controls and an honest Foonz status', () => {
  assert.equal(UI_REVISION, 'talksys-v45-ui-restored-20260911');
  for (const id of ['chat','status','mic','form','input','diag','log','tts-test','phone-provider']) assert.match(TALK_HTML_V45, new RegExp(`id=["']${id}["']`));
  assert.match(TALK_HTML_V45, /\/talk-v45\.js/);
  assert.match(TALK_HTML_V45, /Foonz/);
  assert.match(TALK_HTML_V45, /電話網連携準備中/);
  assert.doesNotMatch(TALK_HTML_V45, /realtime-voice\.js|voice-fallback\.js|\/agents\//);
});

test('v45 STT keeps signal gating before Whisper', () => {
  assert.equal(STT_MODEL, '@cf/openai/whisper-large-v3-turbo');
  assert.equal(STT_REVISION, 'talksys-v45-hardened-whisper');
  const invalid = analyzeWav(new ArrayBuffer(44));
  assert.equal(invalid.valid, false);
  assert.equal(weakSpeechSignal(invalid), true);
});

test('Wrangler stays on the clean non-Durable-Object production entry', () => {
  assert.match(wrangler, /"main"\s*:\s*"src\/worker-v44\.js"/);
  assert.doesNotMatch(wrangler, /"durable_objects"\s*:/);
});

test('production deployment derives revision contract from source and checks current UI and microphone', () => {
  assert.match(deploy, /CLIENT_REVISION/);
  assert.match(deploy, /UI_REVISION/);
  assert.match(deploy, /STT_REVISION/);
  assert.match(deploy, /talksys-v46-streaming-vad/);
  assert.match(deploy, /talksys-v45-ui-restored-20260911/);
  assert.match(deploy, /\/talk-v45\.js/);
  assert.match(deploy, /getUserMedia/);
  assert.match(deploy, /\/api\/transcribe/);
  assert.doesNotMatch(deploy, /talksys-v45-standalone-http-adaptive-vad/);
});

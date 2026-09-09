import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const client = await readFile(new URL('../src/cloudflare-live-client-v32.js', import.meta.url), 'utf8');
const production = await readFile(new URL('../src/worker-v32-production.js', import.meta.url), 'utf8');
const trace = await readFile(new URL('../src/search-trace-client-v32.js', import.meta.url), 'utf8');

test('v32 microphone client is standalone instead of another inherited string patch', () => {
  assert.doesNotMatch(client, /cloudflare-live-client-v31/);
  assert.doesNotMatch(client, /replaceOnce\(/);
  assert.doesNotMatch(client, /IS_ANDROID|Android|Xperia/i);
  assert.match(client, /unified-capture-state-machine-v32/);
});

test('every browser platform proves real PCM generation before start_call', () => {
  assert.match(client, /captureState !== 'verified' \|\| frameCount < 1/);
  assert.match(client, /if \(frameCount === 1\)/);
  assert.match(client, /maybeStartCall\(\)/);
  assert.match(client, /callStartPending = true/);
  assert.match(client, /flushPreRoll\(\)/);
});

test('capture uses native device rate and produces fixed 16 kHz 40 ms frames', () => {
  assert.match(client, /const TARGET_RATE = 16000/);
  assert.match(client, /const CHUNK_SAMPLES = 640/);
  assert.match(client, /function createCaptureContext\(\)[\s\S]*new AudioCtor\(\)/);
  assert.doesNotMatch(client, /createCaptureContext[\s\S]{0,400}sampleRate:\s*48000/);
  assert.match(client, /this\.step=sampleRate\/16000/);
  assert.match(client, /while\(this\.pending\.length>=640\)/);
  assert.match(client, /view\.setInt16\(i \* 2,[\s\S]*true\)/);
});

test('AudioWorklet and ScriptProcessor are platform-neutral verified backends', () => {
  assert.match(client, /installProcessor\('audio-worklet'\)/);
  assert.match(client, /installProcessor\('script-processor'\)/);
  assert.match(client, /waitForFrame\(baseline\)/);
  assert.match(client, /talksys-mic-capture-fallback/);
  assert.match(client, /recoverCapture\('capture-stalled'\)/);
});

test('client counts transmitted PCM and server proves receipt at STT ingress', () => {
  assert.match(client, /pcmFramesSent \+= 1/);
  assert.match(client, /pcmBytesSent \+= buffer\.byteLength/);
  assert.match(client, /data\.type === 'mic_transport'/);
  assert.match(production, /session\.feed = \(chunk\)/);
  assert.match(production, /type: 'mic_transport'/);
  assert.match(production, /sampleRate: 16000/);
  assert.match(production, /format: 's16le-mono'/);
  assert.match(production, /frames === 1 \|\| frames % 25 === 0/);
});

test('microphone diagnostics expose counters and RMS but never raw audio', () => {
  assert.match(client, /window\.__talksysVoiceDebug/);
  assert.match(client, /serverFramesReceived/);
  assert.match(client, /serverLastRms/);
  assert.match(production, /microphoneRawAudioInDiagnostics: false/);
  assert.doesNotMatch(production, /audio:\s*chunk|samples:\s*chunk|rawAudio/);
});

test('processing view shows client transmit and server STT receive separately', () => {
  assert.match(trace, /talksys-mic-tx/);
  assert.match(trace, /マイクPCM送信/);
  assert.match(trace, /talksys-mic-transport/);
  assert.match(trace, /STT入口でPCM受信確認/);
});

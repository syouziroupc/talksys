import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { phoneNoiseSuppressionSelfTest, PHONE_NOISE_SUPPRESSION_REVISION } from '../src/telephony/phone-noise-suppressor.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const workerLoader = fs.readFileSync(new URL('../src/telephony/speex-worker-loader.js', import.meta.url), 'utf8');
const telephony = fs.readFileSync(new URL('../src/telephony/index.js', import.meta.url), 'utf8');

test('v126 keeps Node tests on byte-loader but production workerd on precompiled Wasm', async () => {
  assert.equal(pkg.imports['#speex-runtime-loader'].workerd, './src/telephony/speex-worker-loader.js');
  assert.equal(pkg.imports['#speex-runtime-loader'].default, './src/telephony/speex-node-loader.js');
  assert.match(workerLoader, /speex-worker\.wasm/);
  assert.match(workerLoader, /new WebAssembly\.Instance\(speexWasmModule, imports\)/);
  assert.match(workerLoader, /receiveInstance\(instance, speexWasmModule\)/);
  assert.doesNotMatch(workerLoader, /wasmBinary/);
  const result = await phoneNoiseSuppressionSelfTest();
  assert.equal(result.ok, true);
  assert.equal(result.runtimeKind, 'node-wasm-binary');
  assert.equal(PHONE_NOISE_SUPPRESSION_REVISION, 'talksys-phone-speex-v126-worker-r1');
});

test('v126 health makes Worker Speex readiness a deploy-visible contract', () => {
  assert.match(telephony, /await phoneNoiseSuppressionSelfTest\(\)/);
  assert.match(telephony, /noiseSuppressionRuntime/);
  assert.match(telephony, /runtimeKind:phoneNoiseSuppressor\?\.runtimeKind/);
  assert.match(telephony, /initError:noiseInitError/);
});

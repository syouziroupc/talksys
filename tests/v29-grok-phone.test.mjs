import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  GROK_CONVERSATION_MODEL_V29,
  streamGrokConversationV29,
} from '../src/grok-conversation-v29.js';
import {
  GrokJapaneseTTSV29,
  GROK_TTS_MODEL_V29,
} from '../src/grok-japanese-tts-v29.js';
import {
  GROK_PHONE_STT_MODEL_V29,
  twilioConnectTwiml,
  phoneHealth,
  __test as phoneTest,
} from '../src/grok-phone-v29.js';

async function collect(iterable) {
  let out = '';
  for await (const chunk of iterable) out += String(chunk || '');
  return out;
}

function sseStream(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

test('v29 conversation uses Grok 4.20 non-reasoning only', async () => {
  const calls = [];
  const ai = {
    run(model, input) {
      calls.push({ model, input });
      return Promise.resolve(sseStream('Grokで回答します。'));
    },
  };
  const text = await collect(streamGrokConversationV29(ai, [{ role: 'user', content: 'こんにちは' }]));
  assert.equal(text, 'Grokで回答します。');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, GROK_CONVERSATION_MODEL_V29);
  assert.equal(calls[0].model, 'xai/grok-4.20-0309-non-reasoning');
  assert.equal(calls[0].input.stream, true);
  assert.equal('reasoning_effort' in calls[0].input, false);
});

test('v29 retries only the same Grok conversation model once', async () => {
  const calls = [];
  const ai = {
    run(model, input) {
      calls.push({ model, input });
      if (calls.length === 1) return Promise.reject(new Error('temporary failure'));
      return Promise.resolve({ choices: [{ message: { content: '同じGrokで復旧しました。' } }] });
    },
  };
  const text = await collect(streamGrokConversationV29(ai, [{ role: 'user', content: '相談です' }], {
    openTimeoutMs: 100,
    retryTimeoutMs: 300,
  }));
  assert.equal(text, '同じGrokで復旧しました。');
  assert.deepEqual(calls.map((call) => call.model), [GROK_CONVERSATION_MODEL_V29, GROK_CONVERSATION_MODEL_V29]);
  assert.equal(calls[0].input.stream, true);
  assert.equal(calls[1].input.stream, false);
});

test('Grok TTS is the only TTS and has browser MP3 plus native telephony mulaw/8000', async () => {
  const calls = [];
  const ai = {
    async run(model, input) {
      calls.push({ model, input });
      return { audio: btoa(String.fromCharCode(0x11, 0x7f, 0x00, 0x55)) };
    },
  };
  const tts = new GrokJapaneseTTSV29(ai);
  const browser = await tts.synthesize('こんにちは。');
  const phone = await tts.synthesizeTelephony('こんにちは。');
  assert.ok(browser instanceof ArrayBuffer);
  assert.ok(phone instanceof ArrayBuffer);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.model === GROK_TTS_MODEL_V29));
  assert.equal(calls[0].input.output_format.codec, 'mp3');
  assert.equal(calls[1].input.output_format.codec, 'mulaw');
  assert.equal(calls[1].input.output_format.sample_rate, 8000);
  assert.equal(calls[1].input.voice_id, 'ara');
  assert.equal(calls[1].input.language, 'ja');
});

test('phone STT passes raw Twilio mulaw directly to Grok STT', async () => {
  let call = null;
  const ai = {
    async run(model, input) {
      call = { model, input };
      return { text: '電話からの相談です' };
    },
  };
  const text = await phoneTest.transcribeMulaw(ai, new Uint8Array([0xff, 0xff, 0x7f, 0x00]));
  assert.equal(text, '電話からの相談です');
  assert.equal(call.model, GROK_PHONE_STT_MODEL_V29);
  assert.equal(call.input.audio_format, 'mulaw');
  assert.equal(call.input.sample_rate, 8000);
  assert.match(call.input.file, /^data:audio\/basic;base64,/);
});

test('Twilio inbound route uses bidirectional websocket transport and optional phone token', () => {
  const request = new Request('https://talksys.example/phone/incoming');
  const xml = twilioConnectTwiml(request, { TALKSYS_PHONE_TOKEN: 'secret-test' });
  assert.match(xml, /<Connect><Stream url="wss:\/\/talksys\.example\/phone\/media">/);
  assert.match(xml, /<Parameter name="Token" value="secret-test"\/>/);
  const health = phoneHealth({ TALKSYS_PHONE_TOKEN: 'secret-test' });
  assert.equal(health.transport, 'twilio-bidirectional-media-stream');
  assert.equal(health.inputCodec, 'audio/x-mulaw');
  assert.equal(health.sampleRate, 8000);
  assert.equal(health.sttModel, 'xai/grok-stt');
  assert.equal(health.ttsModel, 'xai/grok-tts');
  assert.equal(health.bargeInClear, true);
  assert.equal(health.phoneTokenConfigured, true);
});

test('v29 production path is Grok-centered with no Qwen GLM DeepSeek GPT-OSS or Melo fallback', async () => {
  const [worker, production, conversation, tts, phone, wrangler] = await Promise.all([
    readFile(new URL('../src/worker-v29.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/worker-v29-production.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/grok-conversation-v29.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/grok-japanese-tts-v29.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/grok-phone-v29.js', import.meta.url), 'utf8'),
    readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
  ]);
  const active = `${worker}\n${production}\n${conversation}\n${tts}\n${phone}`;
  assert.match(active, /xai\/grok-4\.20-0309-non-reasoning/);
  assert.match(active, /xai\/grok-tts/);
  assert.match(active, /xai\/grok-stt/);
  assert.doesNotMatch(active, /@cf\/qwen\/|@cf\/zai-org\/glm-|@cf\/deepseek-ai\/|@cf\/openai\/gpt-oss-|MeloJapaneseTTS/i);
  assert.match(active, /event:\s*'clear'/);
  assert.match(active, /event:\s*'media'/);
  assert.match(active, /event:\s*'mark'/);
  assert.match(wrangler, /"main":\s*"src\/worker-v29-production\.js"/);
});

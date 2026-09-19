import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REALTIME_VOICE_REVISION as SERVER_REALTIME_REVISION,
  REALTIME_STT_MODEL,
  __test as integrated,
} from '../src/integrated-entry.js';
import {
  REALTIME_VOICE_REVISION as CLIENT_REALTIME_REVISION,
  TALK_CLIENT_V45,
  __test as clientFlags,
} from '../src/talk-client-v45.js';
import { fastReaction, sameUtterance, FAST_REACTION_REVISION } from '../src/voice-fast-reaction.js';

test('v61 fast reactions are context-sensitive and intentionally a little longer', () => {
  assert.equal(FAST_REACTION_REVISION, 'talksys-v61-quality-buffer-r1');
  assert.deepEqual(fastReaction('こんにちは').text, 'こんにちは。');
  assert.deepEqual(fastReaction('ありがとう').text, 'どういたしまして。');
  assert.deepEqual(fastReaction('今から別府駅の次の電車を調べて').text, 'はい、少し確認しながら調べますね。');
  assert.deepEqual(fastReaction('ちょっと相談したい').text, 'はい、内容を確認しますね。');
  assert.equal(fastReaction('えーと').shouldSpeak, false);
});

test('similar realtime and Whisper transcripts are recognized as the same utterance', () => {
  assert.equal(sameUtterance('別府駅から大分駅まで調べて', '別府駅から大分駅まで調べてください'), true);
  assert.equal(sameUtterance('今日の天気を教えて', 'パソコンの価格を教えて'), false);
});

test('Gemini final-answer input knows a backchannel was already spoken and avoids repeating it', () => {
  const input = integrated.interactionInput({
    text: '別府の今日の天気を教えて',
    spokenBackchannel: 'はい、少し確認しながら調べますね。',
    history: [],
  }, { now: new Date('2026-09-18T02:00:00Z') });
  assert.match(input, /短い相槌「はい、少し確認しながら調べますね。」をすでに読み上げ/);
  assert.match(input, /同じ相槌や挨拶を繰り返さず/);
  assert.match(input, /別府の今日の天気を教えて/);
});

test('realtime STT endpoint uses Japanese Nova-3 websocket with interim results and fast endpointing', async () => {
  assert.equal(SERVER_REALTIME_REVISION, 'talksys-v65-discord-hearing-tune-r1');
  assert.equal(REALTIME_STT_MODEL, '@cf/deepgram/nova-3');
  let call;
  const response = new Response(null, { status: 200 });
  const env = {
    AI: {
      async run(model, args, options) {
        call = { model, args, options };
        return response;
      },
    },
  };
  const request = new Request('https://talksys.test/api/realtime-stt', {
    headers: { upgrade: 'websocket' },
  });
  const got = await integrated.realtimeSttResponse(request, env);
  assert.equal(got, response);
  assert.equal(call.model, '@cf/deepgram/nova-3');
  assert.equal(call.args.encoding, 'linear16');
  assert.equal(call.args.sample_rate, '16000');
  assert.equal(call.args.language, 'ja');
  assert.equal(call.args.interim_results, 'true');
  assert.equal(typeof call.args.interim_results, 'string');
  assert.equal(call.args.punctuate, 'true');
  assert.equal(call.args.smart_format, 'true');
  assert.equal(call.args.endpointing, '250');
  assert.equal('vad_events' in call.args, false);
  assert.equal('utterance_end_ms' in call.args, false);
  assert.equal(call.options.websocket, true);
});

test('browser streams mic frames but keeps Whisper batch STT as authoritative fallback', () => {
  assert.equal(CLIENT_REALTIME_REVISION, 'talksys-v59.2-realtime-stt-minimal-r1');
  assert.equal(clientFlags.realtimeJapaneseStt, true);
  assert.equal(clientFlags.fastReactionHandoff, true);
  assert.equal(clientFlags.batchFastReactionFallback, true);
  assert.doesNotThrow(() => new Function(TALK_CLIENT_V45));
  assert.match(TALK_CLIENT_V45, /\/api\/realtime-stt/);
  assert.match(TALK_CLIENT_V45, /sendRealtimeSttFrame/);
  assert.match(TALK_CLIENT_V45, /リアルタイム終端/);
  assert.match(TALK_CLIENT_V45, /\/api\/fast-reaction/);
  assert.match(TALK_CLIENT_V45, /spokenBackchannel/);
  assert.match(TALK_CLIENT_V45, /高速相槌 batch:/);
  assert.match(TALK_CLIENT_V45, /j\?\.fastReaction\?\.shouldSpeak/);
  assert.match(TALK_CLIENT_V45, /\/api\/transcribe/);
});

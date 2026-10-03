import fs from 'node:fs';

function replaceOnce(text, before, after, label) {
  const first = text.indexOf(before);
  if (first < 0) throw new Error(`patch target missing: ${label}`);
  if (text.indexOf(before, first + before.length) >= 0) throw new Error(`patch target not unique: ${label}`);
  return text.slice(0, first) + after + text.slice(first + before.length);
}

const path = 'discord-voice-smoke/src/index.mjs';
let source = fs.readFileSync(path, 'utf8');

source = replaceOnce(
  source,
  "import { arbitrateSuccessfulTranscript, classifySttFailure, rescueFailedWhisper } from '../../src/voice-transcript-arbiter.js';",
  "import { arbitrateSuccessfulTranscript, classifySttFailure, rescueFailedWhisper } from '../../src/voice-transcript-arbiter.js';\nimport { guardFfmpegStdin } from './ffmpeg-stdin.mjs';",
  'ffmpeg stdin guard import',
);

source = replaceOnce(
  source,
  "const DISCORD_STABILITY_PATCH_REVISION = 'talksys-r5-stability-coordinator-p1';",
  "const DISCORD_STABILITY_PATCH_REVISION = 'talksys-r5-stability-coordinator-p2-stdin-fast-reaction';",
  'stability revision',
);

source = replaceOnce(
  source,
  `    if (payload?.speech_final) {
      const text = [...helper.finalParts, (!payload?.is_final && transcript ? transcript : '')].filter(Boolean).join(' ').trim() || transcript;
      if (text && helper.active) helper.active.latestRealtimeTranscript = text;
      helper.finalParts = [];
      helper.interim = '';
    }`,
  `    if (payload?.speech_final) {
      const text = [...helper.finalParts, (!payload?.is_final && transcript ? transcript : '')].filter(Boolean).join(' ').trim() || transcript;
      if (text && helper.active) helper.active.latestRealtimeTranscript = text;
      if (text) triggerWebFastReaction(helper, text, 'speech-final');
      helper.finalParts = [];
      helper.interim = '';
    }`,
  'Nova speech_final fast reaction',
);

source = replaceOnce(
  source,
  `  if (/UtteranceEnd/i.test(type)) {
    const text = helper.finalParts.join(' ').trim() || helper.interim;
    if (text && helper.active) helper.active.latestRealtimeTranscript = text;
    helper.finalParts = [];
    helper.interim = '';
  }`,
  `  if (/UtteranceEnd/i.test(type)) {
    const text = helper.finalParts.join(' ').trim() || helper.interim;
    if (text && helper.active) helper.active.latestRealtimeTranscript = text;
    if (text) triggerWebFastReaction(helper, text, 'utterance-end');
    helper.finalParts = [];
    helper.interim = '';
  }`,
  'Nova UtteranceEnd fast reaction',
);

source = replaceOnce(
  source,
  `  ffmpeg.on('error', (error) => console.error('[ffmpeg]', error.message));
  ffmpeg.stdin.end(mp3);`,
  `  ffmpeg.on('error', (error) => console.error('[ffmpeg]', error.message));
  guardFfmpegStdin(ffmpeg.stdin, {
    onExpected: (error) => mirrorRuntimeLog('FFMPEG-STDIN', \`expected close code=\${error?.code || '-'} message=\${error?.message || error}\`),
    onUnexpected: (error) => {
      console.error('[ffmpeg-stdin]', error?.message || error);
      mirrorRuntimeLog('ERROR', \`ffmpeg stdin: \${error?.message || error}\`);
    },
  });
  ffmpeg.stdin.end(mp3);`,
  'ffmpeg stdin error guard',
);

fs.writeFileSync(path, source);
console.log('R5 ffmpeg stdin + fast reaction patch applied');

import { CLOUDFLARE_LIVE_CLIENT_V23 } from './cloudflare-live-client-v23.js';

function replaceOnce(source, target, replacement, label) {
  if (!source.includes(target)) throw new Error(`TalkSys v23 final client patch target missing: ${label}`);
  return source.replace(target, replacement);
}

let source = CLOUDFLARE_LIVE_CLIENT_V23;

source = replaceOnce(
  source,
  "  let lastFallbackAnswerAt = 0;\n",
  "  let lastFallbackAnswerAt = 0;\n  let serverTtsExpectedThisTurn = false;\n",
  'server TTS expectation state',
);

source = replaceOnce(
  source,
  `    if ((desiredCall || typedVoiceOutput) && !serverAudioThisTurn && value) {
`,
  `    if ((desiredCall || typedVoiceOutput) && !serverAudioThisTurn && !serverTtsExpectedThisTurn && value) {
`,
  'server-owned TTS suppresses browser replay',
);

source = replaceOnce(
  source,
  `        else if (data.status === 'speaking') setStatus((desiredCall || typedVoiceOutput) ? 'AIが話しています…' : '文字で回答しています…');
`,
  `        else if (data.status === 'speaking') {
          serverTtsExpectedThisTurn = true;
          setStatus((desiredCall || typedVoiceOutput) ? 'AIが話しています…' : '文字で回答しています…');
        }
`,
  'server speaking ownership',
);

source = replaceOnce(
  source,
  `      if (data.type === 'transcript' && data.text) {
        if (data.role === 'assistant') finishAssistantStream(data.text);
        else addMessage('user', data.text);
        return;
      }
`,
  `      if (data.type === 'transcript' && data.text) {
        if (data.role === 'assistant') finishAssistantStream(data.text);
        else {
          serverTtsExpectedThisTurn = false;
          serverAudioThisTurn = false;
          addMessage('user', data.text);
        }
        return;
      }
`,
  'new turn TTS reset',
);

source = replaceOnce(
  source,
  `          searchWaitActive = true;
          serverAudioThisTurn = false;
`,
  `          searchWaitActive = true;
          serverAudioThisTurn = false;
          serverTtsExpectedThisTurn = false;
`,
  'search turn TTS reset',
);

source = replaceOnce(
  source,
  `        if (/tts|speech|音声合成/i.test(message)) {
          if (currentAssistantText && !serverAudioThisTurn) setTimeout(() => speakJapaneseFallback(currentAssistantText), 120);
`,
  `        if (/tts|speech|音声合成/i.test(message)) {
          serverTtsExpectedThisTurn = false;
          if (currentAssistantText && !serverAudioThisTurn) setTimeout(() => speakJapaneseFallback(currentAssistantText, 'tts-error-fallback'), 120);
`,
  'explicit TTS error fallback',
);

export const CLOUDFLARE_LIVE_CLIENT_V23_FINAL = source;

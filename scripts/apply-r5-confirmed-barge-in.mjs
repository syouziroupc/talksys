import fs from 'node:fs';

function replaceOnce(text, before, after, label) {
  const first = text.indexOf(before);
  if (first < 0) throw new Error(`patch target missing: ${label}`);
  if (text.indexOf(before, first + before.length) >= 0) throw new Error(`patch target not unique: ${label}`);
  return text.slice(0, first) + after + text.slice(first + before.length);
}

const path = 'discord-voice-smoke/src/index.mjs';
let source = fs.readFileSync(path, 'utf8');

const anchor = `  if (shouldDropUncorroboratedBotOverlap(confirmedTranscript, captureMetrics, policy)) {
    console.warn(\`[turn-policy] dropped reason=bot-overlap-unconfirmed whisper="\${confirmedTranscript}" realtime="\${String(captureMetrics?.realtimeTranscript || '')}"\`);
    mirrorRuntimeLog('DROP', \`bot-overlap-unconfirmed: \${confirmedTranscript}\`);
    return;
  }
  if (answering) {`;

const replacement = `  if (shouldDropUncorroboratedBotOverlap(confirmedTranscript, captureMetrics, policy)) {
    console.warn(\`[turn-policy] dropped reason=bot-overlap-unconfirmed whisper="\${confirmedTranscript}" realtime="\${String(captureMetrics?.realtimeTranscript || '')}"\`);
    mirrorRuntimeLog('DROP', \`bot-overlap-unconfirmed: \${confirmedTranscript}\`);
    return;
  }

  // A final accepted user utterance that began while the bot was audibly
  // speaking is authoritative barge-in evidence. Preempt the old answer once,
  // then process this same utterance as the new turn instead of buffering it.
  if (answering && captureMetrics?.overlappedBotPlayback) {
    const interrupted = interruptActiveAnswer('confirmed-transcript-barge-in');
    if (interrupted) mirrorRuntimeLog('BARGE', \`confirmed transcript preempted prior answer utterance=\${utteranceId}\`);
  }

  if (answering) {`;

source = replaceOnce(source, anchor, replacement, 'confirmed barge-in before queue');
fs.writeFileSync(path, source);
console.log('confirmed barge-in patch applied');

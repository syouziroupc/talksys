import fs from 'node:fs';

function replaceOnce(text, before, after, label) {
  const first = text.indexOf(before);
  if (first < 0) throw new Error(`patch target missing: ${label}`);
  if (text.indexOf(before, first + before.length) >= 0) throw new Error(`patch target not unique: ${label}`);
  return text.slice(0, first) + after + text.slice(first + before.length);
}

const path = 'discord-voice-smoke/src/index.mjs';
let source = fs.readFileSync(path, 'utf8');

const oldMutations = `  if (body.interactionId) previousInteractionId = body.interactionId;
  if (body.search) {
    searchTrace = {
      resolvedQuestion: body.resolvedQuestion || text,
      queries: Array.isArray(body.queries) ? body.queries.slice(0, 6) : [],
      sources: Array.isArray(body.sources) ? body.sources.slice(0, 8) : [],
    };
  }
  history.push({ role: 'user', content: text }, { role: 'assistant', content: body.answer });
  if (history.length > MAX_HISTORY * 2) history.splice(0, history.length - MAX_HISTORY * 2);
`;
source = replaceOnce(source, oldMutations, '', 'remove eager conversation mutation');

const marker = `async function talk(text, utteranceId = '', signal) {`;
const commit = `function commitConversationTurn(text, body) {
  if (!body?.answer) return false;
  if (body.interactionId) previousInteractionId = body.interactionId;
  if (body.search) {
    searchTrace = {
      resolvedQuestion: body.resolvedQuestion || text,
      queries: Array.isArray(body.queries) ? body.queries.slice(0, 6) : [],
      sources: Array.isArray(body.sources) ? body.sources.slice(0, 8) : [],
    };
  }
  history.push({ role: 'user', content: text }, { role: 'assistant', content: body.answer });
  if (history.length > MAX_HISTORY * 2) history.splice(0, history.length - MAX_HISTORY * 2);
  mirrorRuntimeLog('CONTEXT-COMMIT', \`utterance committed interaction=\${body.interactionId || '-'} history=\${history.length}\`);
  return true;
}

${marker}`;
source = replaceOnce(source, marker, commit, 'insert transaction commit helper');

const afterPlayback = `    });
    timings.playbackMs = Date.now() - playbackWallStarted;
`;
const transactional = `    });
    if (!controller.signal.aborted && turnSerial === activeTurnSerial && sessionEpoch === voiceEpoch) {
      commitConversationTurn(confirmedTranscript, turn);
    } else {
      mirrorRuntimeLog('CONTEXT-DROP', \`uncommitted interrupted answer utterance=\${utteranceId}\`);
    }
    timings.playbackMs = Date.now() - playbackWallStarted;
`;
source = replaceOnce(source, afterPlayback, transactional, 'commit after completed playback');

fs.writeFileSync(path, source);
console.log('conversation transaction patch applied');

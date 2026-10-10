import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTalkmanRuntimeR6Source } from './build-talkman-runtime-r6.mjs';

export const TALKMAN_RUNTIME_R7_REVISION = 'talkman-group-v1-hardening-r7-search-progress';

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);
  if (first < 0) throw new Error(`TalkMan R7 anchor missing: ${label}`);
  if (first !== last) throw new Error(`TalkMan R7 anchor is not unique: ${label}`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

export function buildTalkmanRuntimeR7Source(input) {
  let source = buildTalkmanRuntimeR6Source(String(input || ''));

  source = replaceOnce(
    source,
    "const DISCORD_BRIDGE_REVISION = 'talksys-discord-bridge-v92-resilience-r5-talkman-v1-r6';",
    "const DISCORD_BRIDGE_REVISION = 'talksys-discord-bridge-v92-resilience-r5-talkman-v1-r7';",
    'R7 revision',
  );

  source = replaceOnce(
    source,
    `  const reaction = fastReaction(value);\n  if (!reaction?.shouldSpeak || !String(reaction?.text || '').trim()) return false;\n  active.reactionIssued = true;`,
    `  const reaction = fastReaction(value);\n  if (reaction?.kind === 'lookup' && !reaction?.terminal) {\n    mirrorRuntimeLog('REACTION-DEFER', \`${'${source}'} lookup waits for confirmed search-progress cue: ${'${value}'}\`);\n    return false;\n  }\n  if (!reaction?.shouldSpeak || !String(reaction?.text || '').trim()) return false;\n  active.reactionIssued = true;`,
    'defer realtime lookup reaction',
  );

  source = replaceOnce(
    source,
    `function startWaitCue(text, utteranceId, parentSignal, fastReaction = null) {\n  const controller = new AbortController();\n  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;\n  const cueSerial = ++preAnswerCueSerial;\n  let playing = false;\n  let stopped = false;\n\n  const done = (async () => {\n    try {\n      let cue = '';\n      if (fastReaction?.shouldSpeak && String(fastReaction?.text || '').trim()) {\n        cue = String(fastReaction.text).trim();\n      } else {\n        cue = await fetchSearchPreface(text, signal);\n      }\n      if (!cue || signal.aborted || stopped || cueSerial !== preAnswerCueSerial) return false;\n      const synthesized = await synthesize(cue, signal, { utteranceId, purpose: 'wait-cue' });\n      if (signal.aborted || stopped || cueSerial !== preAnswerCueSerial) return false;\n      playing = true;\n      await playMp3(synthesized.audio, { spokenText: cue, purpose: 'wait-cue' });\n      return true;\n    } catch (error) {\n      if (!signal.aborted && !stopped) console.warn('[wait-cue] failed:', error?.message || error);\n      return false;\n    } finally {\n      playing = false;\n    }\n  })();\n\n  return {\n    done,\n    stop(reason = 'answer-ready') {\n      if (stopped) return;\n      stopped = true;\n      try { controller.abort(reason); } catch {}\n      if (playing) player.stop(true);\n    },\n  };\n}`,
    `function startWaitCue(text, utteranceId, parentSignal, fastReaction = null) {\n  const controller = new AbortController();\n  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;\n  const cueSerial = ++preAnswerCueSerial;\n  const armedAt = Date.now();\n  const searchDelayMs = 1100;\n  let playing = false;\n  let stopped = false;\n\n  const waitRemaining = async (delayMs) => {\n    if (delayMs <= 0) return !signal.aborted && !stopped;\n    return new Promise((resolve) => {\n      let settled = false;\n      const finish = (value) => {\n        if (settled) return;\n        settled = true;\n        clearTimeout(timer);\n        try { signal.removeEventListener('abort', onAbort); } catch {}\n        resolve(value);\n      };\n      const onAbort = () => finish(false);\n      const timer = setTimeout(() => finish(true), delayMs);\n      if (signal.aborted) finish(false);\n      else signal.addEventListener('abort', onAbort, { once: true });\n    });\n  };\n\n  const done = (async () => {\n    try {\n      let cue = '';\n      const searchCue = fastReaction?.kind === 'lookup';\n      if (fastReaction?.shouldSpeak && String(fastReaction?.text || '').trim()) {\n        cue = String(fastReaction.text).trim();\n      } else {\n        cue = await fetchSearchPreface(text, signal);\n      }\n      if (!cue || signal.aborted || stopped || cueSerial !== preAnswerCueSerial) return false;\n\n      let audio = null;\n      if (fastReaction?.shouldSpeak) audio = await cachedReactionAudio(cue, signal);\n      else audio = (await synthesize(cue, signal, { utteranceId, purpose: 'wait-cue' })).audio;\n      if (!audio?.length || signal.aborted || stopped || cueSerial !== preAnswerCueSerial) return false;\n\n      if (searchCue) {\n        const remainingMs = Math.max(0, searchDelayMs - (Date.now() - armedAt));\n        const ready = await waitRemaining(remainingMs);\n        if (!ready || signal.aborted || stopped || cueSerial !== preAnswerCueSerial) return false;\n      }\n\n      playing = true;\n      await playMp3(audio, { spokenText: cue, purpose: searchCue ? 'search-progress' : 'wait-cue' });\n      return true;\n    } catch (error) {\n      if (!signal.aborted && !stopped) console.warn('[wait-cue] failed:', error?.message || error);\n      return false;\n    } finally {\n      playing = false;\n    }\n  })();\n\n  return {\n    done,\n    isPlaying() { return playing; },\n    async finishForAnswer(reason = 'answer-ready') {\n      if (stopped) {\n        await done.catch(() => false);\n        return;\n      }\n      if (!playing) {\n        stopped = true;\n        try { controller.abort(reason); } catch {}\n      }\n      await done.catch(() => false);\n    },\n    stop(reason = 'user-interrupt') {\n      if (stopped) return;\n      stopped = true;\n      try { controller.abort(reason); } catch {}\n      if (playing) player.stop(true);\n    },\n  };\n}`,
    'search progress delayed soft handoff',
  );

  source = replaceOnce(
    source,
    `    preAnswerCueSerial += 1;\n    activeWaitCue?.stop('final-answer-ready');\n    activeWaitCue = null;\n    activeFastReaction?.stop?.('final-answer-ready');\n    activeFastReaction = null;\n    player.stop(true);`,
    `    preAnswerCueSerial += 1;\n    const finishingWaitCue = activeWaitCue;\n    activeWaitCue = null;\n    if (finishingWaitCue) await finishingWaitCue.finishForAnswer('final-answer-ready');\n    activeFastReaction?.stop?.('final-answer-ready');\n    activeFastReaction = null;`,
    'answer soft handoff from search progress',
  );

  return source;
}

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const basePath = path.join(here, 'index-classic-base.mjs');
  const outPath = path.join(here, 'index-talkman.generated.mjs');
  const base = fs.readFileSync(basePath, 'utf8');
  const built = buildTalkmanRuntimeR7Source(base);
  fs.writeFileSync(outPath, built, 'utf8');
  process.stdout.write(`generated ${outPath} revision=${TALKMAN_RUNTIME_R7_REVISION}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

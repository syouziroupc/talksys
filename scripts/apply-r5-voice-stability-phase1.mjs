import fs from 'node:fs';

function replaceOnce(text, before, after, label) {
  const first = text.indexOf(before);
  if (first < 0) throw new Error(`patch target missing: ${label}`);
  if (text.indexOf(before, first + before.length) >= 0) throw new Error(`patch target not unique: ${label}`);
  return text.slice(0, first) + after + text.slice(first + before.length);
}

const indexPath = 'discord-voice-smoke/src/index.mjs';
let index = fs.readFileSync(indexPath, 'utf8');

index = replaceOnce(index,
  "import { fastReaction, sameUtterance, classifyVoiceTurn, isIgnorableSttFailure } from '../../src/voice-fast-reaction.js';",
  "import { fastReaction, sameUtterance, classifyVoiceTurn } from '../../src/voice-fast-reaction.js';\nimport { arbitrateSuccessfulTranscript, classifySttFailure, rescueFailedWhisper } from '../../src/voice-transcript-arbiter.js';",
  'arbiter import');

index = replaceOnce(index,
  "const DISCORD_BRIDGE_REVISION = 'talksys-discord-bridge-v92-resilience-r5';",
  "const DISCORD_BRIDGE_REVISION = 'talksys-discord-bridge-v93-stability-coordinator-r1';",
  'bridge revision');

index = replaceOnce(index,
`      voice: connection?.state?.status || 'none',
      captures: sessions.size,
      revision: DISCORD_BRIDGE_REVISION,`,
`      voice: connection?.state?.status || 'none',
      player: player.state.status,
      captures: sessions.size,
      answering,
      queued: pendingTurns.length,
      activeUtterance: activeUserUtteranceId || '',
      logPending: discordLogQueue.length,
      revision: DISCORD_BRIDGE_REVISION,`,
  'heartbeat diagnostics');

index = replaceOnce(index,
`  if (/SpeechStarted/i.test(type)) {
    helper.finalParts = [];
    helper.interim = '';
    return;
  }`,
`  if (/SpeechStarted/i.test(type)) {
    helper.finalParts = [];
    helper.interim = '';
    if (helper.active) helper.active.realtimeSpeechStartedAt = Date.now();
    return;
  }`,
  'realtime SpeechStarted generation');

index = replaceOnce(index,
`    if (payload?.speech_final) {
      const text = [...helper.finalParts, (!payload?.is_final && transcript ? transcript : '')].filter(Boolean).join(' ').trim() || transcript;
      if (text) triggerWebFastReaction(helper, text);
      helper.finalParts = [];
      helper.interim = '';
    }`,
`    if (payload?.speech_final) {
      const text = [...helper.finalParts, (!payload?.is_final && transcript ? transcript : '')].filter(Boolean).join(' ').trim() || transcript;
      if (text && helper.active) helper.active.latestRealtimeTranscript = text;
      helper.finalParts = [];
      helper.interim = '';
    }`,
  'disable early speech-final reaction playback');

index = replaceOnce(index,
`  if (/UtteranceEnd/i.test(type)) {
    const text = helper.finalParts.join(' ').trim() || helper.interim;
    if (text) triggerWebFastReaction(helper, text);
    helper.finalParts = [];
    helper.interim = '';
  }`,
`  if (/UtteranceEnd/i.test(type)) {
    const text = helper.finalParts.join(' ').trim() || helper.interim;
    if (text && helper.active) helper.active.latestRealtimeTranscript = text;
    helper.finalParts = [];
    helper.interim = '';
  }`,
  'disable early utterance-end reaction playback');

index = replaceOnce(index,
`    latestRealtimeTranscript: '',
    latestRealtimeConfidence: null,
    realtimeWords: [],`,
`    latestRealtimeTranscript: '',
    latestRealtimeConfidence: null,
    realtimeWords: [],
    realtimeSpeechStartedAt: 0,`,
  'realtime generation field');

index = replaceOnce(index,
`    const realtimeWords = realtimeActive && Array.isArray(realtimeActive.realtimeWords) ? realtimeActive.realtimeWords.slice(0,120) : [];
    if (realtimeActive && realtimeTranscript) {
      triggerWebFastReaction(realtimeHelper, realtimeTranscript, 'capture-finalize');
    }`,
`    const realtimeWords = realtimeActive && Array.isArray(realtimeActive.realtimeWords) ? realtimeActive.realtimeWords.slice(0,120) : [];
    const realtimeSpeechStartedAt = Number(realtimeActive?.realtimeSpeechStartedAt || 0);
    if (realtimeActive && realtimeTranscript && realtimeSpeechStartedAt) {
      triggerWebFastReaction(realtimeHelper, realtimeTranscript, 'capture-finalize');
    }`,
  'capture-finalize reaction gate');

index = replaceOnce(index,
`      realtimeTranscript,
      realtimeConfidence,
      realtimeWords,
      bargeInTriggerMs: Number(timeline.bargeInTriggerMs) || 0,`,
`      realtimeTranscript,
      realtimeConfidence,
      realtimeWords,
      realtimeSpeechStartedAt,
      bargeInTriggerMs: Number(timeline.bargeInTriggerMs) || 0,`,
  'capture metrics realtime generation');

index = replaceOnce(index,
`    let correctedTranscript = correction.correctedTranscript || rawTranscript;
    let correctionReason = correction.correctionReason || '';
    if (correctionReason) mirrorRuntimeLog('STT-CORRECT', correctionReason + ': \\"' + rawTranscript + '\\" -> \\"' + correctedTranscript + '\\"');
    const echoRecord = looksLikeRecentBotEcho(rawTranscript, timeline);`,
`    let correctedTranscript = correction.correctedTranscript || rawTranscript;
    let correctionReason = correction.correctionReason || '';
    if (correctionReason) mirrorRuntimeLog('STT-CORRECT', correctionReason + ': \\"' + rawTranscript + '\\" -> \\"' + correctedTranscript + '\\"');

    const arbitration = arbitrateSuccessfulTranscript({ whisperText: correctedTranscript, captureMetrics, timeline });
    mirrorRuntimeLog('STT-ARBITER', arbitration.action + ' reason=' + arbitration.reason
      + ' whisper=\\"' + correctedTranscript + '\\" realtime=\\"' + String(captureMetrics?.realtimeTranscript || '') + '\\"');
    if (arbitration.action === 'drop') {
      activeFastReaction?.stop?.('stt-conflict');
      activeFastReaction = null;
      if (!answering && player.state.status !== AudioPlayerStatus.Playing) {
        await speakRecoveryPrompt('stt-transcript-conflict', sessionEpoch, timeline.utteranceEndAt || 0);
      }
      return;
    }
    if (arbitration.action === 'accept-realtime') {
      correctedTranscript = arbitration.text;
      correctionReason = [correctionReason, arbitration.reason].filter(Boolean).join(';');
    }

    const echoRecord = looksLikeRecentBotEcho(correctedTranscript, timeline);`,
  'successful transcript arbitration');

const oldRescue = `    if (isIgnorableSttFailure(message)) {
      const realtimeRescue = String(captureMetrics?.realtimeTranscript || '').trim();
      const rescuePolicy = classifyVoiceTurn(realtimeRescue, {
        answerInFlight: answering || player.state.status === AudioPlayerStatus.Playing,
      });
      if (realtimeRescue && rescuePolicy.action === 'answer') {
        mirrorRuntimeLog('STT-RESCUE', \`Whisper failed -> realtime: \${realtimeRescue}\`);
        await processConfirmedTranscript({
          confirmedTranscript: realtimeRescue,
          rawTranscript: realtimeRescue,
          correctedTranscript: realtimeRescue,
          correctionReason: 'realtime-rescue-after-whisper-failure',
          fastReaction: fastReaction(realtimeRescue),
          userId,
          sessionEpoch,
          utteranceId,
          timeline,
          captureMetrics,
          sttMeta: { model: 'realtime-rescue', whisperError: message },
        });
        return;
      }
      mirrorRuntimeLog('DROP', \`ignorable STT failure without usable realtime text: \${message}\`);
      return;
    }
    await speakRecoveryPrompt('stt-failed', sessionEpoch, timeline.utteranceEndAt || 0);`;

const newRescue = `    const failureKind = classifySttFailure(message);
    const rescue = rescueFailedWhisper({ error: message, captureMetrics, timeline });
    mirrorRuntimeLog('STT-ARBITER', \`failure=\${failureKind} action=\${rescue.action} reason=\${rescue.reason}\`);
    if (rescue.action === 'accept-realtime') {
      const rescuePolicy = classifyVoiceTurn(rescue.text, {
        answerInFlight: answering || player.state.status === AudioPlayerStatus.Playing,
      });
      if (rescuePolicy.action === 'answer') {
        mirrorRuntimeLog('STT-RESCUE', \`safe realtime rescue: \${rescue.text}\`);
        await processConfirmedTranscript({
          confirmedTranscript: rescue.text,
          rawTranscript: rescue.text,
          correctedTranscript: rescue.text,
          correctionReason: rescue.reason,
          fastReaction: fastReaction(rescue.text),
          userId,
          sessionEpoch,
          utteranceId,
          timeline,
          captureMetrics,
          sttMeta: { model: 'realtime-rescue', whisperError: message },
        });
        return;
      }
    }
    if (['no-speech', 'hallucination', 'weak-speech'].includes(failureKind)) {
      mirrorRuntimeLog('DROP', \`unsafe STT rescue blocked kind=\${failureKind}: \${message}\`);
      return;
    }
    await speakRecoveryPrompt('stt-failed', sessionEpoch, timeline.utteranceEndAt || 0);`;
index = replaceOnce(index, oldRescue, newRescue, 'safe failed-Whisper rescue');

index = replaceOnce(index,
`    } catch (localError) {
      const detail = String(localError?.message || localError || '');
      console.warn('[tts] Windows System.Speech failed; trying Cloudflare MeloTTS:', detail);`,
`    } catch (localError) {
      const detail = String(localError?.message || localError || '');
      if (signal?.aborted || localError?.name === 'AbortError' || /(?:^|\\b)abort(?:ed)?(?:\\b|$)/i.test(detail)) {
        mirrorRuntimeLog('TTS', 'Windows local cancelled; fallback suppressed');
        throw localError;
      }
      console.warn('[tts] Windows System.Speech failed; trying Cloudflare MeloTTS:', detail);`,
  'suppress TTS fallback after abort');

fs.writeFileSync(indexPath, index);

const startPath = 'discord-voice-smoke/start.ps1';
let start = fs.readFileSync(startPath, 'utf8');
start = replaceOnce(start,
`Set-Location $PSScriptRoot
. "$PSScriptRoot\\secret-store.ps1"`,
`Set-Location $PSScriptRoot
. "$PSScriptRoot\\secret-store.ps1"

$supervisorLogDir = Join-Path $env:LOCALAPPDATA 'TalkSys'
$supervisorLogFile = Join-Path $supervisorLogDir 'supervisor.log'
New-Item -ItemType Directory -Path $supervisorLogDir -Force | Out-Null
function Write-SupervisorLog {
  param([Parameter(Mandatory=$true)][string]$Message)
  $stamp = (Get-Date).ToString('o')
  try { Add-Content -LiteralPath $supervisorLogFile -Value ("$stamp $Message") -Encoding UTF8 } catch {}
}`,
  'supervisor durable logger');

start = replaceOnce(start,
`  $proc = Start-Process -FilePath 'node.exe' -ArgumentList @($entry) -PassThru -NoNewWindow
  $hung = $false`,
`  $proc = Start-Process -FilePath 'node.exe' -ArgumentList @($entry) -PassThru -NoNewWindow
  Write-SupervisorLog "START pid=$($proc.Id) entry=$entry"
  $hung = $false`,
  'supervisor process start log');

start = replaceOnce(start,
`          Write-Warning "[supervisor] blocking pipeline stage stuck stage=$stage age=$([math]::Round($stageAgeSeconds,1))s deadline=$([math]::Round($deadlineSeconds,1))s; requesting Discord bridge shutdown pid=$($proc.Id)"
          Stop-TalkSysBridgeGracefully -Process $proc -Reason "pipeline-stage-stuck:$stage"`,
`          Write-Warning "[supervisor] blocking pipeline stage stuck stage=$stage age=$([math]::Round($stageAgeSeconds,1))s deadline=$([math]::Round($deadlineSeconds,1))s; requesting Discord bridge shutdown pid=$($proc.Id)"
          Write-SupervisorLog "STUCK pid=$($proc.Id) stage=$stage age=$([math]::Round($stageAgeSeconds,1)) deadline=$([math]::Round($deadlineSeconds,1)) heartbeat=$((Get-Content -LiteralPath $heartbeatFile -Raw -ErrorAction SilentlyContinue))"
          Stop-TalkSysBridgeGracefully -Process $proc -Reason "pipeline-stage-stuck:$stage"`,
  'supervisor stuck evidence');

start = replaceOnce(start,
`      Write-Warning "[supervisor] heartbeat stale $([math]::Round($ageSeconds,1))s; requesting hung Discord bridge shutdown pid=$($proc.Id)"
      Stop-TalkSysBridgeGracefully -Process $proc -Reason "heartbeat-stale"`,
`      Write-Warning "[supervisor] heartbeat stale $([math]::Round($ageSeconds,1))s; requesting hung Discord bridge shutdown pid=$($proc.Id)"
      Write-SupervisorLog "HEARTBEAT_STALE pid=$($proc.Id) age=$([math]::Round($ageSeconds,1)) heartbeat=$((Get-Content -LiteralPath $heartbeatFile -Raw -ErrorAction SilentlyContinue))"
      Stop-TalkSysBridgeGracefully -Process $proc -Reason "heartbeat-stale"`,
  'supervisor heartbeat evidence');

start = replaceOnce(start,
`    Write-Host "[supervisor] Discord bridge stopped normally."
    exit 0`,
`    Write-Host "[supervisor] Discord bridge stopped normally."
    Write-SupervisorLog "STOP_NORMAL pid=$($proc.Id) uptime=$([math]::Round($uptimeSeconds,1))"
    exit 0`,
  'supervisor normal stop log');

start = replaceOnce(start,
`  Write-Warning "[supervisor] Discord bridge stopped code=$exitCode hung=$hung uptime=$([math]::Round($uptimeSeconds, 1))s. Restarting in $delaySeconds seconds..."`,
`  Write-Warning "[supervisor] Discord bridge stopped code=$exitCode hung=$hung uptime=$([math]::Round($uptimeSeconds, 1))s. Restarting in $delaySeconds seconds..."
  Write-SupervisorLog "RESTART pid=$($proc.Id) code=$exitCode hung=$hung uptime=$([math]::Round($uptimeSeconds,1)) delay=$delaySeconds"`,
  'supervisor restart log');

fs.writeFileSync(startPath, start);
console.log('R5 voice stability phase1 patch applied successfully');

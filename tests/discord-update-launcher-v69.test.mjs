import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const updater = fs.readFileSync(new URL('../discord-voice-smoke/update-and-start.ps1', import.meta.url), 'utf8');
const readme = fs.readFileSync(new URL('../discord-voice-smoke/README.md', import.meta.url), 'utf8');

test('Discord update launcher only fast-forwards a clean local checkout', () => {
  assert.match(updater, /git status --porcelain/);
  assert.match(updater, /git fetch origin main/);
  assert.match(updater, /git rev-parse --abbrev-ref HEAD/);
  assert.match(updater, /git merge-base --is-ancestor HEAD origin\/main/);
  assert.match(updater, /git merge --ff-only origin\/main/);
  assert.match(updater, /ローカル変更があります/);
  assert.match(updater, /Discord試験は main ブランチで実行してください/);
  assert.match(updater, /先行または分岐しています/);
  assert.doesNotMatch(updater, /reset --hard|clean -f/);
});

test('Discord update launcher starts the existing secret-aware launcher after update', () => {
  assert.match(updater, /start\.ps1/);
  assert.match(updater, /git rev-parse --short HEAD/);
  assert.match(readme, /update-and-start\.ps1/);
  assert.match(readme, /\[capture\] finalized/);
  assert.match(readme, /\[stt\] confirmed Whisper start/);
  assert.match(readme, /\[metrics\] voice latency persisted/);
  assert.doesNotMatch(readme, /WebSocket先行接続|batch STT|\/api\/turn-stream/);
});


test('Discord launcher supervises exits and hung bridge heartbeat/stage states', () => {
  const launcher = fs.readFileSync(new URL('../discord-voice-smoke/start.ps1', import.meta.url), 'utf8');
  assert.match(launcher, /\[supervisor\] starting Discord bridge process/);
  assert.match(launcher, /Start-Process -FilePath 'node\.exe'/);
  assert.match(launcher, /heartbeat stale/);
  assert.match(launcher, /pipeline stage stuck/);
  assert.match(launcher, /\$stageBlocking/);
  assert.match(launcher, /\$deadlineSeconds/);
  assert.match(launcher, /\$ageSeconds -gt 20/);
  assert.match(launcher, /Restarting in \$delaySeconds seconds/);
  assert.match(launcher, /\[math\]::Min\(60, \[math\]::Pow\(2, \[math\]::Min\(\$rapidFailures, 5\)\)\)/);
  assert.match(launcher, /\$rapidFailures -ge 12/);
  assert.match(launcher, /短時間に12回連続で異常終了/);
});


test('Discord updater shuts down the old bridge and verified supervisor before restart', () => {
  assert.match(updater, /Get-CimInstance Win32_Process/);
  assert.match(updater, /Name = 'node\.exe'/);
  assert.match(updater, /\[regex\]::Escape\(\$entry\)/);
  assert.match(updater, /talksys-discord-shutdown\.txt/);
  assert.match(updater, /Set-Content -LiteralPath \$shutdownFile -Value 'update-and-start'/);
  assert.match(updater, /ParentProcessId/);
  assert.match(updater, /\$parent\.CommandLine -match \$supervisorPattern/);
  assert.match(updater, /\$parent\.Name -match '\^powershell\(\?:\\\\\.exe\)\?\
  assert.match(updater, /taskkill\.exe \/PID \$parentPid \/T \/F/);
  assert.match(updater, /taskkill\.exe \/PID \$targetPid \/T \/F/);
  assert.match(updater, /for \(\$attempt = 1; \$attempt -le 3; \$attempt\+\+\)/);
  assert.match(updater, /旧TalkSys Discord Bot\/Supervisorの完全停止を確認できないため、新Botの起動を中止します/);
  assert.match(updater, /src\\index\.mjs/);
  assert.doesNotMatch(updater, /Stop-Process -Id \$proc\.ProcessId -Force/);
});

test('Discord supervisor treats updater-requested exit code as intentional stop, not crash restart', () => {
  const launcher = fs.readFileSync(new URL('../discord-voice-smoke/start.ps1', import.meta.url), 'utf8');
  assert.match(launcher, /\$externalShutdownExitCode = 73/);
  assert.match(launcher, /\$exitCode -eq \$externalShutdownExitCode/);
  assert.match(launcher, /external maintenance shutdown completed; supervisor exiting/);
});

test('Discord supervisor is process-level singleton even if the updater misses a restart gap', () => {
  const launcher = fs.readFileSync(new URL('../discord-voice-smoke/start.ps1', import.meta.url), 'utf8');
  assert.match(launcher, /System\.Threading\.Mutex/);
  assert.match(launcher, /Local\\TalkSysDiscordSupervisor/);
  assert.match(launcher, /if \(-not \$mutexCreated\)/);
  assert.match(launcher, /Supervisorは既に起動しています/);
  assert.match(launcher, /ReleaseMutex/);
});

test('Discord updater also detects a same-checkout supervisor while node.exe is between restarts', () => {
  assert.match(updater, /function Get-TalkSysSupervisorProcesses/);
  assert.match(updater, /\$_\.Name -match '\^\(\?:powershell\|pwsh\)\(\?:\\\\\.exe\)\?\
  assert.match(updater, /\$oldSupervisors = Get-TalkSysSupervisorProcesses/);
  assert.match(updater, /Get-TalkSysBridgeProcesses\)\.Count -eq 0 -and \(Get-TalkSysSupervisorProcesses\)\.Count -eq 0/);
  assert.match(updater, /terminating surviving verified Supervisor/);
  assert.match(updater, /親プロセス pid=\$parentPid を安全にSupervisorと確認できません/);
});
/);
  assert.match(updater, /taskkill\.exe \/PID \$parentPid \/T \/F/);
  assert.match(updater, /taskkill\.exe \/PID \$targetPid \/T \/F/);
  assert.match(updater, /for \(\$attempt = 1; \$attempt -le 3; \$attempt\+\+\)/);
  assert.match(updater, /旧TalkSys Discord Bot\/Supervisorの完全停止を確認できないため、新Botの起動を中止します/);
  assert.match(updater, /src\\index\.mjs/);
  assert.doesNotMatch(updater, /Stop-Process -Id \$proc\.ProcessId -Force/);
});

test('Discord supervisor treats updater-requested exit code as intentional stop, not crash restart', () => {
  const launcher = fs.readFileSync(new URL('../discord-voice-smoke/start.ps1', import.meta.url), 'utf8');
  assert.match(launcher, /\$externalShutdownExitCode = 73/);
  assert.match(launcher, /\$exitCode -eq \$externalShutdownExitCode/);
  assert.match(launcher, /external maintenance shutdown completed; supervisor exiting/);
});

test('Discord supervisor is process-level singleton even if the updater misses a restart gap', () => {
  const launcher = fs.readFileSync(new URL('../discord-voice-smoke/start.ps1', import.meta.url), 'utf8');
  assert.match(launcher, /System\.Threading\.Mutex/);
  assert.match(launcher, /Local\\TalkSysDiscordSupervisor/);
  assert.match(launcher, /if \(-not \$mutexCreated\)/);
  assert.match(launcher, /Supervisorは既に起動しています/);
  assert.match(launcher, /ReleaseMutex/);
});

test('Discord updater also detects a same-checkout supervisor while node.exe is between restarts', () => {
  assert.match(updater, /function Get-TalkSysSupervisorProcesses/);
  assert.match(updater, /Name = 'powershell\.exe'/);
  assert.match(updater, /\$oldSupervisors = Get-TalkSysSupervisorProcesses/);
  assert.match(updater, /Get-TalkSysBridgeProcesses\)\.Count -eq 0 -and \(Get-TalkSysSupervisorProcesses\)\.Count -eq 0/);
  assert.match(updater, /terminating surviving verified Supervisor/);
  assert.match(updater, /親プロセス pid=\$parentPid を安全にSupervisorと確認できません/);
});
/);
  assert.match(updater, /\$oldSupervisors = Get-TalkSysSupervisorProcesses/);
  assert.match(updater, /Get-TalkSysBridgeProcesses\)\.Count -eq 0 -and \(Get-TalkSysSupervisorProcesses\)\.Count -eq 0/);
  assert.match(updater, /terminating surviving verified Supervisor/);
  assert.match(updater, /親プロセス pid=\$parentPid を安全にSupervisorと確認できません/);
});
/);
  assert.match(updater, /taskkill\.exe \/PID \$parentPid \/T \/F/);
  assert.match(updater, /taskkill\.exe \/PID \$targetPid \/T \/F/);
  assert.match(updater, /for \(\$attempt = 1; \$attempt -le 3; \$attempt\+\+\)/);
  assert.match(updater, /旧TalkSys Discord Bot\/Supervisorの完全停止を確認できないため、新Botの起動を中止します/);
  assert.match(updater, /src\\index\.mjs/);
  assert.doesNotMatch(updater, /Stop-Process -Id \$proc\.ProcessId -Force/);
});

test('Discord supervisor treats updater-requested exit code as intentional stop, not crash restart', () => {
  const launcher = fs.readFileSync(new URL('../discord-voice-smoke/start.ps1', import.meta.url), 'utf8');
  assert.match(launcher, /\$externalShutdownExitCode = 73/);
  assert.match(launcher, /\$exitCode -eq \$externalShutdownExitCode/);
  assert.match(launcher, /external maintenance shutdown completed; supervisor exiting/);
});

test('Discord supervisor is process-level singleton even if the updater misses a restart gap', () => {
  const launcher = fs.readFileSync(new URL('../discord-voice-smoke/start.ps1', import.meta.url), 'utf8');
  assert.match(launcher, /System\.Threading\.Mutex/);
  assert.match(launcher, /Local\\TalkSysDiscordSupervisor/);
  assert.match(launcher, /if \(-not \$mutexCreated\)/);
  assert.match(launcher, /Supervisorは既に起動しています/);
  assert.match(launcher, /ReleaseMutex/);
});

test('Discord updater also detects a same-checkout supervisor while node.exe is between restarts', () => {
  assert.match(updater, /function Get-TalkSysSupervisorProcesses/);
  assert.match(updater, /Name = 'powershell\.exe'/);
  assert.match(updater, /\$oldSupervisors = Get-TalkSysSupervisorProcesses/);
  assert.match(updater, /Get-TalkSysBridgeProcesses\)\.Count -eq 0 -and \(Get-TalkSysSupervisorProcesses\)\.Count -eq 0/);
  assert.match(updater, /terminating surviving verified Supervisor/);
  assert.match(updater, /親プロセス pid=\$parentPid を安全にSupervisorと確認できません/);
});

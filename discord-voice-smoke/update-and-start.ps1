Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path $PSScriptRoot -Parent
Set-Location $RepoRoot

function Require-Git {
  try {
    $null = & git --version
  } catch {
    throw "Git が見つかりません。Git for Windowsを入れてから再実行してください。"
  }
}

Require-Git

if (-not (Test-Path (Join-Path $RepoRoot '.git'))) {
  throw "このスクリプトはTalkSysのGitリポジトリ内で実行してください。"
}

$dirty = (& git status --porcelain)
if ($dirty) {
  Write-Host "[stop] ローカル変更があります。誤上書きを防ぐため自動更新を中止します。" -ForegroundColor Yellow
  & git status --short
  throw "ローカル変更をcommit/stashしてから再実行してください。"
}

$branch = (& git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne 'main') {
  throw "現在のブランチは '$branch' です。Discord試験は main ブランチで実行してください。"
}

Write-Host "[update] fetching origin/main..."
& git fetch origin main
if ($LASTEXITCODE -ne 0) { throw "git fetch origin main に失敗しました。" }

$current = (& git rev-parse HEAD).Trim()
$remote = (& git rev-parse origin/main).Trim()

& git merge-base --is-ancestor HEAD origin/main
if ($LASTEXITCODE -ne 0) {
  throw "ローカルmainがorigin/mainより先行または分岐しています。自動更新せず停止します。"
}

if ($current -ne $remote) {
  Write-Host "[update] fast-forwarding to origin/main..."
  & git merge --ff-only origin/main
  if ($LASTEXITCODE -ne 0) {
    throw "origin/main へのfast-forward更新に失敗しました。"
  }
} else {
  Write-Host "[ok] already on latest origin/main"
}

$revision = (& git rev-parse --short HEAD).Trim()
Write-Host "[ok] TalkSys revision: $revision"

# Validate restart-critical secrets before stopping the currently running bridge.
# A failed interactive secret prompt must never turn an update into an outage.
. "$PSScriptRoot\secret-store.ps1"
if (-not $env:DISCORD_TOKEN) {
  $env:DISCORD_TOKEN = Get-TalkSysPersistedSecret 'discord-bot-token'
}
if (-not $env:DISCORD_BRIDGE_TOKEN) {
  $env:DISCORD_BRIDGE_TOKEN = Get-TalkSysPersistedSecret 'discord-bridge-token'
}
if (-not $env:DISCORD_TOKEN) {
  throw "DISCORD_TOKEN が未設定です。現在のBotは停止していません。先に discord-voice-smoke\start.ps1 を対話実行してDiscord Bot TokenをDPAPI保存してください。"
}
if (-not $env:DISCORD_BRIDGE_TOKEN) {
  throw "DISCORD_BRIDGE_TOKEN が未設定です。現在のBotは停止していません。先に setup-bridge-secret.ps1 を実行してください。"
}

try {
  $headers = @{ Authorization = "Bot $env:DISCORD_TOKEN" }
  $me = Invoke-RestMethod -Method Get -Uri 'https://discord.com/api/v10/users/@me' -Headers $headers -TimeoutSec 10
  if (-not $me.id) { throw "Discord token validation returned no bot id." }
  Write-Host "[ok] restart preflight: Discord Bot Token valid for bot id=$($me.id)"
} catch {
  throw "DISCORD_TOKEN の事前検証に失敗しました。現在のBotは停止していません。$($_.Exception.Message)"
}
Write-Host "[ok] restart preflight: Discord secrets available"

# Stop the old TalkSys bridge and its supervisor from this checkout.
# v114 r2+ bridges understand the shutdown-file protocol and exit with code 73,
# which tells start.ps1 to stop the supervisor instead of restarting the bot.
# Older bridges do not understand that protocol, so after a grace period we
# terminate only a verified same-checkout supervisor process tree.
$entry = Join-Path $PSScriptRoot 'src\index.mjs'
$supervisorScript = Join-Path $PSScriptRoot 'start.ps1'
$shutdownFile = Join-Path $env:TEMP 'talksys-discord-shutdown.txt'
$entryPattern = [regex]::Escape($entry)
$supervisorPattern = [regex]::Escape($supervisorScript)

function Get-TalkSysBridgeProcesses {
  return @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match $entryPattern })
}

function Get-TalkSysSupervisorProcesses {
  return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -match '^(?:powershell|pwsh)(?:\.exe)?$' -and
      $_.CommandLine -and
      $_.CommandLine -match $supervisorPattern
    })
}

function Stop-VerifiedProcessTree {
  param(
    [Parameter(Mandatory=$true)]$BridgeProcess
  )

  $targetPid = [int]$BridgeProcess.ProcessId
  $parentPid = [int]$BridgeProcess.ParentProcessId
  $parent = $null
  if ($parentPid -gt 0) {
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $parentPid" -ErrorAction SilentlyContinue
  }

  $verifiedSupervisor = $parent -and
    $parent.Name -match '^(?:powershell|pwsh)(?:\.exe)?$' -and
    $parent.CommandLine -and
    $parent.CommandLine -match $supervisorPattern

  if ($verifiedSupervisor) {
    Write-Warning "[restart] legacy/surviving supervisor detected pid=$parentPid; terminating verified TalkSys process tree."
    try {
      & taskkill.exe /PID $parentPid /T /F 2>$null | Out-Null
    } catch {}
  } elseif ($null -eq $parent) {
    Write-Warning "[restart] bridge pid=$targetPid has no live parent; terminating orphaned bridge tree."
    try {
      & taskkill.exe /PID $targetPid /T /F 2>$null | Out-Null
    } catch {}
  } else {
    throw "旧TalkSys bridge pid=$targetPid の親プロセス pid=$parentPid を安全にSupervisorと確認できません。旧SupervisorがBotを再生成する可能性があるため、新Botは起動しません。旧TalkSysのPowerShell画面を閉じてから再実行してください。"
  }
}

$oldBridges = Get-TalkSysBridgeProcesses
$oldSupervisors = Get-TalkSysSupervisorProcesses
if ($oldBridges.Count -gt 0 -or $oldSupervisors.Count -gt 0) {
  Write-Host "[restart] requesting graceful shutdown of old Discord bridge/supervisor..."
  try {
    Set-Content -LiteralPath $shutdownFile -Value 'update-and-start' -NoNewline -Force
  } catch {
    Write-Warning "[restart] failed to write shutdown request: $($_.Exception.Message)"
  }

  $graceDeadline = (Get-Date).AddSeconds(3)
  while ((Get-Date) -lt $graceDeadline) {
    if ((Get-TalkSysBridgeProcesses).Count -eq 0 -and (Get-TalkSysSupervisorProcesses).Count -eq 0) { break }
    Start-Sleep -Milliseconds 200
  }

  # Compatibility cleanup for pre-v114 supervisors, or any bridge that failed
  # to honor graceful shutdown. Repeat because an old supervisor can respawn
  # its child once before its own verified process tree is terminated.
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    $remaining = Get-TalkSysBridgeProcesses
    $remainingSupervisors = Get-TalkSysSupervisorProcesses
    if ($remaining.Count -eq 0 -and $remainingSupervisors.Count -eq 0) { break }

    foreach ($proc in $remaining) {
      Stop-VerifiedProcessTree -BridgeProcess $proc
    }

    # A verified supervisor can be between child restarts with no node.exe.
    foreach ($supervisor in (Get-TalkSysSupervisorProcesses)) {
      Write-Warning "[restart] terminating surviving verified Supervisor pid=$($supervisor.ProcessId)"
      try {
        & taskkill.exe /PID $supervisor.ProcessId /T /F 2>$null | Out-Null
      } catch {}
    }
    Start-Sleep -Milliseconds 500
  }

  if ((Get-TalkSysBridgeProcesses).Count -ne 0 -or (Get-TalkSysSupervisorProcesses).Count -ne 0) {
    throw "旧TalkSys Discord Bot/Supervisorの完全停止を確認できないため、新Botの起動を中止します。二重起動防止のため手動確認してください。"
  }

  if (Test-Path $shutdownFile) {
    Remove-Item $shutdownFile -Force -ErrorAction SilentlyContinue
  }
  Write-Host "[ok] old Discord bridge and supervisor are fully stopped."
}

Write-Host "[start] launching Discord voice bridge..."
& powershell -ExecutionPolicy Bypass -File "$PSScriptRoot\start.ps1"
exit $LASTEXITCODE

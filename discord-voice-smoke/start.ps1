Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Set-Location $PSScriptRoot

# Keep exactly one long-running TalkSys Discord supervisor per Windows host.
# The file may remain on disk after an abnormal exit, but the exclusive handle
# is released by Windows when the process exits, so the next launch can acquire it.
$lockRoot = if ($env:TEMP) { $env:TEMP } else { [System.IO.Path]::GetTempPath() }
$supervisorLockPath = Join-Path $lockRoot 'talksys-discord-supervisor.lock'
try {
  $supervisorLock = [System.IO.File]::Open(
    $supervisorLockPath,
    [System.IO.FileMode]::OpenOrCreate,
    [System.IO.FileAccess]::ReadWrite,
    [System.IO.FileShare]::None
  )
} catch [System.IO.IOException] {
  Write-Warning "[supervisor] another TalkSys Discord supervisor is already running; duplicate start refused."
  exit 0
}
$lockText = "pid=$PID started=$([DateTimeOffset]::Now.ToString('o'))"
$lockBytes = [System.Text.Encoding]::UTF8.GetBytes($lockText)
$supervisorLock.SetLength(0)
$supervisorLock.Write($lockBytes, 0, $lockBytes.Length)
$supervisorLock.Flush()
Write-Host "[supervisor] singleton lock acquired pid=$PID"

. "$PSScriptRoot\secret-store.ps1"

function Require-Node {
  try {
    $versionText = (& node --version).Trim().TrimStart('v')
  } catch {
    throw "Node.js が見つかりません。Node.js 22.12 以上を入れてから再実行してください。"
  }
  $version = [version]$versionText
  if ($version -lt [version]'22.12.0') {
    throw "Node.js 22.12 以上が必要です。現在: $versionText"
  }
  Write-Host "[ok] Node.js $versionText"
}

Require-Node

if (-not $env:DISCORD_TOKEN) {
  $env:DISCORD_TOKEN = Read-TalkSysSecret 'discord-bot-token' 'Discord Bot Token'
}
if (-not $env:DISCORD_BRIDGE_TOKEN) {
  $env:DISCORD_BRIDGE_TOKEN = Get-TalkSysPersistedSecret 'discord-bridge-token'
  if (-not $env:DISCORD_BRIDGE_TOKEN) {
    throw "DISCORD_BRIDGE_TOKEN が未設定です。先に .\setup-bridge-secret.ps1 を実行してください。"
  }
  Write-Host "[ok] loaded saved TalkSys Discord Bridge Token"
}
if (-not $env:TALKSYS_BASE_URL) {
  $env:TALKSYS_BASE_URL = "https://talksys.syouziroupc.workers.dev"
}

$packageJson = Join-Path $PSScriptRoot 'package.json'
$nodeModules = Join-Path $PSScriptRoot 'node_modules'
$dependencyStamp = Join-Path $nodeModules '.talksys-package-sha256'
$packageHash = (Get-FileHash -Algorithm SHA256 $packageJson).Hash
$installedHash = if (Test-Path $dependencyStamp) { (Get-Content $dependencyStamp -Raw).Trim() } else { '' }
$needsInstall = (-not (Test-Path $nodeModules)) -or ($installedHash -ne $packageHash)

if ($needsInstall) {
  Write-Host "[setup] installing Discord smoke dependencies..."
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "通常のnpm installが失敗したため、peer dependency競合を無視して再試行します。"
    npm install --no-audit --no-fund --legacy-peer-deps
    if ($LASTEXITCODE -ne 0) {
      throw "Discord依存関係のインストールに失敗しました。"
    }
  }
  Set-Content -Path $dependencyStamp -Value $packageHash -NoNewline
  Write-Host "[ok] Discord dependencies installed for current package.json"
} else {
  Write-Host "[ok] Discord dependencies unchanged; skipping npm install"
}

Write-Host "[start] Discord voice smoke"
Write-Host "[start] TalkSys: $env:TALKSYS_BASE_URL"
Write-Host "[start] mode: /talksys joins caller VC; /leave disconnects; TalkSys STT/turn/TTS permanent bridge auth"

$entry = Join-Path $PSScriptRoot 'src\index.mjs'
$heartbeatFile = Join-Path $env:TEMP 'talksys-discord-heartbeat.json'
$shutdownFile = Join-Path $env:TEMP 'talksys-discord-shutdown.txt'
$env:TALKSYS_BRIDGE_HEARTBEAT_FILE = $heartbeatFile
$env:TALKSYS_BRIDGE_SHUTDOWN_FILE = $shutdownFile
$rapidFailures = 0

function Stop-TalkSysBridgeGracefully {
  param(
    [Parameter(Mandatory=$true)]$Process,
    [Parameter(Mandatory=$true)][string]$Reason
  )

  try {
    Set-Content -LiteralPath $shutdownFile -Value $Reason -NoNewline -Force
  } catch {
    Write-Warning "[supervisor] failed to write graceful shutdown request: $($_.Exception.Message)"
  }

  $graceDeadline = (Get-Date).AddSeconds(2)
  while (-not $Process.HasExited -and (Get-Date) -lt $graceDeadline) {
    Start-Sleep -Milliseconds 200
    $Process.Refresh()
  }

  if (-not $Process.HasExited) {
    Write-Warning "[supervisor] graceful shutdown timed out; terminating process tree pid=$($Process.Id)"
    try {
      & taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null
    } catch {}
    Start-Sleep -Milliseconds 200
    $Process.Refresh()
  }

  if (-not $Process.HasExited) {
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
  }
}

while ($true) {
  if (Test-Path $heartbeatFile) { Remove-Item $heartbeatFile -Force -ErrorAction SilentlyContinue }
  if (Test-Path $shutdownFile) { Remove-Item $shutdownFile -Force -ErrorAction SilentlyContinue }
  $startedAt = Get-Date
  Write-Host "[supervisor] starting Discord bridge process..."
  $proc = Start-Process -FilePath 'node.exe' -ArgumentList @($entry) -PassThru -NoNewWindow
  $hung = $false
  $heartbeatSeen = $false

  while (-not $proc.HasExited) {
    Start-Sleep -Seconds 5
    $proc.Refresh()
    if ($proc.HasExited) { break }

    $ageSeconds = $null
    if (Test-Path $heartbeatFile) {
      $heartbeatSeen = $true
      try {
        $heartbeat = Get-Content -LiteralPath $heartbeatFile -Raw | ConvertFrom-Json
        $heartbeatAt = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$heartbeat.at).LocalDateTime
        $ageSeconds = ((Get-Date) - $heartbeatAt).TotalSeconds
        $stage = [string]$heartbeat.stage
        $stageAgeSeconds = 0
        if ($heartbeat.stageAt -and [int64]$heartbeat.stageAt -gt 0) {
          $stageAt = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$heartbeat.stageAt).LocalDateTime
          $stageAgeSeconds = ((Get-Date) - $stageAt).TotalSeconds
        }
        $blockingProp = $heartbeat.PSObject.Properties['stageBlocking']
        $deadlineProp = $heartbeat.PSObject.Properties['stageDeadlineMs']
        $stageBlocking = if ($blockingProp) { [bool]$blockingProp.Value } else { $stage -and $stage -ne 'idle' }
        $deadlineMs = if ($deadlineProp -and [double]$deadlineProp.Value -gt 0) { [double]$deadlineProp.Value } else { 30000 }
        $deadlineSeconds = [math]::Max(5, ($deadlineMs / 1000.0) + 5)
        if ($stageBlocking -and $stage -and $stage -ne 'idle' -and $stageAgeSeconds -gt $deadlineSeconds) {
          $hung = $true
          Write-Warning "[supervisor] blocking pipeline stage stuck stage=$stage age=$([math]::Round($stageAgeSeconds,1))s deadline=$([math]::Round($deadlineSeconds,1))s; requesting Discord bridge shutdown pid=$($proc.Id)"
          Stop-TalkSysBridgeGracefully -Process $proc -Reason "pipeline-stage-stuck:$stage"
          break
        }
      } catch {}
    } elseif ($heartbeatSeen) {
      $ageSeconds = 999
    }

    if (-not $hung -and $null -ne $ageSeconds -and $ageSeconds -gt 20) {
      $hung = $true
      Write-Warning "[supervisor] heartbeat stale $([math]::Round($ageSeconds,1))s; requesting hung Discord bridge shutdown pid=$($proc.Id)"
      Stop-TalkSysBridgeGracefully -Process $proc -Reason "heartbeat-stale"
      break
    }
  }

  $proc.WaitForExit()
  if (Test-Path $shutdownFile) { Remove-Item $shutdownFile -Force -ErrorAction SilentlyContinue }
  $exitCode = if ($hung) { 124 } else { $proc.ExitCode }
  $uptimeSeconds = ((Get-Date) - $startedAt).TotalSeconds

  if ($exitCode -eq 0 -and -not $hung) {
    Write-Host "[supervisor] Discord bridge stopped normally."
    exit 0
  }

  if ($uptimeSeconds -ge 60) { $rapidFailures = 0 }
  $rapidFailures += 1
  $delaySeconds = if ($hung) { 2 } else { [math]::Min(60, [math]::Pow(2, [math]::Min($rapidFailures, 5))) }
  Write-Warning "[supervisor] Discord bridge stopped code=$exitCode hung=$hung uptime=$([math]::Round($uptimeSeconds, 1))s. Restarting in $delaySeconds seconds..."
  if ($rapidFailures -ge 12) {
    throw "Discord bridgeが短時間に12回連続で異常終了しました。上のログを確認してください。"
  }
  Start-Sleep -Seconds $delaySeconds
}

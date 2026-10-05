Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Set-Location $PSScriptRoot
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
  Write-Host "[setup] installing Discord dependencies..."
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "通常のnpm installが失敗したため、peer dependency競合を無視して再試行します。"
    npm install --no-audit --no-fund --legacy-peer-deps
    if ($LASTEXITCODE -ne 0) {
      throw "Discord依存関係のインストールに失敗しました。"
    }
  }
  Set-Content -Path $dependencyStamp -Value $packageHash -NoNewline
} else {
  Write-Host "[ok] Discord dependencies unchanged; skipping npm install"
}

$builder = Join-Path $PSScriptRoot 'src\build-talkman-runtime.mjs'
if (-not (Test-Path $builder)) {
  throw "TalkMan builder が見つかりません: $builder"
}

Write-Host "[build] generating isolated TalkMan runtime..."
& node $builder
if ($LASTEXITCODE -ne 0) {
  throw "TalkMan runtime の生成に失敗しました。現行 index.mjs は変更していません。"
}

$entry = Join-Path $PSScriptRoot 'src\index-talkman.generated.mjs'
if (-not (Test-Path $entry)) {
  throw "TalkMan runtime が生成されませんでした: $entry"
}

# Never run the stable TalkSys bridge and the TalkMan bridge with the same bot
# token at the same time. Refuse rather than killing a known-good process.
$existingNodes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object {
    $_.CommandLine -and (
      $_.CommandLine -match 'discord-voice-smoke[\\/]src[\\/]index\.mjs' -or
      $_.CommandLine -match 'index-talkman\.generated\.mjs'
    )
  })
$stableSupervisorPath = [regex]::Escape((Join-Path $PSScriptRoot 'start.ps1'))
$talkmanSupervisorPath = [regex]::Escape((Join-Path $PSScriptRoot 'start-talkman.ps1'))
$existingSupervisors = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.ProcessId -ne $PID -and
    $_.Name -match '^(?:powershell|pwsh)\.exe$' -and
    $_.CommandLine -and (
      $_.CommandLine -match $stableSupervisorPath -or
      $_.CommandLine -match $talkmanSupervisorPath
    )
  })
if ($existingNodes.Count -gt 0 -or $existingSupervisors.Count -gt 0) {
  throw "既存のTalkSys/TalkMan BotまたはSupervisorが動作中です。二重接続を防ぐため、先に既存のBotウィンドウを終了してください。"
}

$stateDir = Join-Path $env:LOCALAPPDATA 'TalkSys'
$supervisorLogFile = Join-Path $stateDir 'talkman-supervisor.log'
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null

function Write-SupervisorLog {
  param([Parameter(Mandatory=$true)][string]$Message)
  try {
    Add-Content -LiteralPath $supervisorLogFile -Value ("{0} {1}" -f (Get-Date).ToString('o'), $Message) -Encoding UTF8
  } catch {}
}

$heartbeatFile = Join-Path $env:TEMP 'talkman-discord-heartbeat.json'
$shutdownFile = Join-Path $env:TEMP 'talkman-discord-shutdown.txt'
$env:TALKSYS_BRIDGE_HEARTBEAT_FILE = $heartbeatFile
$env:TALKSYS_BRIDGE_SHUTDOWN_FILE = $shutdownFile

Write-Host "[start] TalkMan group runtime"
Write-Host "[start] /talkman = group chat, /talksys = existing 1-on-1 behavior"
Write-Host "[start] TalkMan has no search/wait cue such as '確認してお答えします'"
Write-Host "[start] source index.mjs remains untouched"

$rapidFailures = 0

function Stop-TalkManBridgeGracefully {
  param(
    [Parameter(Mandatory=$true)]$Process,
    [Parameter(Mandatory=$true)][string]$Reason
  )
  try {
    Set-Content -LiteralPath $shutdownFile -Value $Reason -NoNewline -Force
  } catch {}
  $deadline = (Get-Date).AddSeconds(2)
  while (-not $Process.HasExited -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 200
    $Process.Refresh()
  }
  if (-not $Process.HasExited) {
    try { & taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null } catch {}
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
  Write-Host "[supervisor] starting TalkMan bridge..."
  $proc = Start-Process -FilePath 'node.exe' -ArgumentList @($entry) -PassThru -NoNewWindow
  Write-SupervisorLog "START pid=$($proc.Id) entry=$entry"
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
        $deadlineMs = if ($heartbeat.stageDeadlineMs -and [double]$heartbeat.stageDeadlineMs -gt 0) {
          [double]$heartbeat.stageDeadlineMs
        } else { 30000 }
        $stageBlocking = if ($null -ne $heartbeat.stageBlocking) { [bool]$heartbeat.stageBlocking } else { $stage -and $stage -ne 'idle' }
        $deadlineSeconds = [math]::Max(5, ($deadlineMs / 1000.0) + 5)
        if ($stageBlocking -and $stage -and $stage -ne 'idle' -and $stageAgeSeconds -gt $deadlineSeconds) {
          $hung = $true
          Write-Warning "[supervisor] TalkMan stage stuck stage=$stage age=$([math]::Round($stageAgeSeconds,1))s"
          Write-SupervisorLog "STUCK pid=$($proc.Id) stage=$stage age=$([math]::Round($stageAgeSeconds,1))"
          Stop-TalkManBridgeGracefully -Process $proc -Reason "pipeline-stage-stuck:$stage"
          break
        }
      } catch {}
    } elseif ($heartbeatSeen) {
      $ageSeconds = 999
    }

    if (-not $hung -and $null -ne $ageSeconds -and $ageSeconds -gt 20) {
      $hung = $true
      Write-Warning "[supervisor] TalkMan heartbeat stale; restarting"
      Write-SupervisorLog "HEARTBEAT_STALE pid=$($proc.Id) age=$([math]::Round($ageSeconds,1))"
      Stop-TalkManBridgeGracefully -Process $proc -Reason "heartbeat-stale"
      break
    }
  }

  $proc.WaitForExit()
  if (Test-Path $shutdownFile) { Remove-Item $shutdownFile -Force -ErrorAction SilentlyContinue }
  $exitCode = if ($hung) { 124 } else { $proc.ExitCode }
  $uptimeSeconds = ((Get-Date) - $startedAt).TotalSeconds

  if ($exitCode -eq 0 -and -not $hung) {
    Write-Host "[supervisor] TalkMan bridge stopped normally."
    Write-SupervisorLog "STOP_NORMAL pid=$($proc.Id) uptime=$([math]::Round($uptimeSeconds,1))"
    exit 0
  }

  if ($uptimeSeconds -ge 60) { $rapidFailures = 0 }
  $rapidFailures += 1
  $delaySeconds = if ($hung) { 2 } else { [math]::Min(60, [math]::Pow(2, [math]::Min($rapidFailures, 5))) }
  Write-Warning "[supervisor] TalkMan stopped code=$exitCode hung=$hung. Restarting in $delaySeconds seconds..."
  Write-SupervisorLog "RESTART pid=$($proc.Id) code=$exitCode hung=$hung delay=$delaySeconds"
  if ($rapidFailures -ge 12) {
    throw "TalkMan bridgeが短時間に12回連続で異常終了しました。ログを確認してください。"
  }
  Start-Sleep -Seconds $delaySeconds
}

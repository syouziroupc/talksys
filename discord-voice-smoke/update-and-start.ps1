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

# Stop only an older TalkSys Discord bridge process from this checkout.
$entry = Join-Path $PSScriptRoot 'src\index.mjs'
$entryPattern = [regex]::Escape($entry)
$oldBridges = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match $entryPattern })

foreach ($proc in $oldBridges) {
  Write-Host "[restart] stopping old Discord bridge pid=$($proc.ProcessId)..."
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
}

if ($oldBridges.Count -gt 0) {
  Start-Sleep -Milliseconds 600
}

Write-Host "[start] launching Discord voice bridge..."
& powershell -ExecutionPolicy Bypass -File "$PSScriptRoot\start.ps1"
exit $LASTEXITCODE

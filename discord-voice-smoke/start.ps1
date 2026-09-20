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
npm start

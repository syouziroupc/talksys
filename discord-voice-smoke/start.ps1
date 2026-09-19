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
if (-not $env:DISCORD_GUILD_ID) {
  $guildFile = Join-Path $env:LOCALAPPDATA 'TalkSys\discord-guild-id.txt'
  if (Test-Path $guildFile) {
    $env:DISCORD_GUILD_ID = (Get-Content -LiteralPath $guildFile -Raw).Trim()
    Write-Host "[ok] loaded saved Discord Guild ID"
  } else {
    $env:DISCORD_GUILD_ID = Read-Host "Discord Guild (Server) ID"
    Set-Content -LiteralPath $guildFile -Value $env:DISCORD_GUILD_ID -Encoding UTF8 -NoNewline
  }
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

Write-Host "[setup] installing Discord smoke dependencies..."
npm install --no-audit --no-fund

Write-Host "[start] Discord voice smoke"
Write-Host "[start] TalkSys: $env:TALKSYS_BASE_URL"
Write-Host "[start] mode: /talksys joins caller VC; /leave disconnects; TalkSys STT/turn/TTS permanent bridge auth"
npm start

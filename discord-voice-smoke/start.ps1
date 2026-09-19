Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Set-Location $PSScriptRoot

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

function Read-Secret([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}

Require-Node

if (-not $env:DISCORD_TOKEN) {
  $env:DISCORD_TOKEN = Read-Secret "Discord Bot Token"
}
if (-not $env:DISCORD_GUILD_ID) {
  $env:DISCORD_GUILD_ID = Read-Host "Discord Guild (Server) ID"
}
if (-not $env:DISCORD_BRIDGE_TOKEN) {
  $env:DISCORD_BRIDGE_TOKEN = Read-Secret "TalkSys Discord Bridge Token"
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

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Set-Location $PSScriptRoot
. "$PSScriptRoot\secret-store.ps1"
$RepoRoot = Split-Path $PSScriptRoot -Parent

function Require-Node {
  try {
    $versionText = (& node --version).Trim().TrimStart('v')
  } catch {
    throw "Node.js が見つかりません。Node.js 22.12 以上を入れてから再実行してください。"
  }
  if ([version]$versionText -lt [version]'22.12.0') {
    throw "Node.js 22.12 以上が必要です。現在: $versionText"
  }
}

Require-Node
Write-Host "[setup] checking Cloudflare login..."
Push-Location $RepoRoot
try {
  npx wrangler whoami
} finally {
  Pop-Location
}

$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $rng.GetBytes($bytes)
} finally {
  $rng.Dispose()
}
$token = [Convert]::ToBase64String($bytes)

Write-Host "[setup] registering DISCORD_BRIDGE_TOKEN in Cloudflare..."
Push-Location $RepoRoot
try {
  $token | npx wrangler secret put DISCORD_BRIDGE_TOKEN
} finally {
  Pop-Location
}
Save-TalkSysPersistedSecret 'discord-bridge-token' $token

Write-Host "[ok] Cloudflare Secret registered."
Write-Host "[ok] Matching local token saved with Windows DPAPI."
Write-Host "[next] Run .\start.ps1"

$token = $null
[Array]::Clear($bytes, 0, $bytes.Length)

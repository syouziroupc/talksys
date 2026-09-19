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
  if ([version]$versionText -lt [version]'22.12.0') {
    throw "Node.js 22.12 以上が必要です。現在: $versionText"
  }
}

Require-Node
Write-Host "[setup] checking Cloudflare login..."
npx wrangler whoami

$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $rng.GetBytes($bytes)
} finally {
  $rng.Dispose()
}
$token = [Convert]::ToBase64String($bytes)

Write-Host "[setup] registering DISCORD_BRIDGE_TOKEN in Cloudflare..."
$token | npx wrangler secret put DISCORD_BRIDGE_TOKEN
Save-TalkSysPersistedSecret 'discord-bridge-token' $token

Write-Host "[ok] Cloudflare Secret registered."
Write-Host "[ok] Matching local token saved with Windows DPAPI."
Write-Host "[next] Run .\start.ps1"

$token = $null
[Array]::Clear($bytes, 0, $bytes.Length)

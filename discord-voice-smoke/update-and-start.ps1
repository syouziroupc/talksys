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
Write-Host "[start] launching Discord voice bridge..."
& powershell -ExecutionPolicy Bypass -File "$PSScriptRoot\start.ps1"
exit $LASTEXITCODE

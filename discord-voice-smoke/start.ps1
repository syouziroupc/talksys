Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$implementation = Join-Path $PSScriptRoot 'start-utf8.ps1'
$runtimeCopy = Join-Path $PSScriptRoot '.start-runtime.ps1'
if (-not (Test-Path -LiteralPath $implementation)) {
  throw "TalkSys start implementation is missing: $implementation"
}

$utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList $false
$utf8Bom = New-Object System.Text.UTF8Encoding -ArgumentList $true
$source = [System.IO.File]::ReadAllText($implementation, $utf8NoBom)
[System.IO.File]::WriteAllText($runtimeCopy, $source, $utf8Bom)

$exitCode = 1
try {
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $runtimeCopy
  $exitCode = $LASTEXITCODE
} finally {
  Remove-Item -LiteralPath $runtimeCopy -Force -ErrorAction SilentlyContinue
}
exit $exitCode

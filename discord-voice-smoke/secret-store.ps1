Set-StrictMode -Version Latest

$script:TalkSysSecretDir = Join-Path $env:LOCALAPPDATA 'TalkSys'
if (-not (Test-Path $script:TalkSysSecretDir)) {
  New-Item -ItemType Directory -Path $script:TalkSysSecretDir -Force | Out-Null
}

function Convert-SecureToPlainText([Security.SecureString]$Secure) {
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}

function Get-TalkSysSecretPath([string]$Name) {
  return Join-Path $script:TalkSysSecretDir ($Name + '.dpapi')
}

function Get-TalkSysPersistedSecret([string]$Name) {
  $path = Get-TalkSysSecretPath $Name
  if (-not (Test-Path $path)) { return $null }
  try {
    $encrypted = (Get-Content -LiteralPath $path -Raw).Trim()
    if (-not $encrypted) { return $null }
    $secure = ConvertTo-SecureString $encrypted
    return Convert-SecureToPlainText $secure
  } catch {
    Write-Warning "保存済みSecretを復号できませんでした: $Name"
    return $null
  }
}

function Save-TalkSysPersistedSecret([string]$Name, [string]$PlainText) {
  if (-not $PlainText) { throw "Secret is empty: $Name" }
  $secure = ConvertTo-SecureString $PlainText -AsPlainText -Force
  $encrypted = ConvertFrom-SecureString $secure
  Set-Content -LiteralPath (Get-TalkSysSecretPath $Name) -Value $encrypted -Encoding UTF8 -NoNewline
}

function Read-TalkSysSecret([string]$Name, [string]$Prompt) {
  $saved = Get-TalkSysPersistedSecret $Name
  if ($saved) {
    Write-Host "[ok] loaded saved secret: $Name"
    return $saved
  }
  $secure = Read-Host $Prompt -AsSecureString
  $plain = Convert-SecureToPlainText $secure
  Save-TalkSysPersistedSecret $Name $plain
  Write-Host "[ok] saved secret with Windows DPAPI: $Name"
  return $plain
}

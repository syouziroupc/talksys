Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$mutexName = 'Local\TalkSysDiscordSupervisor'
$readyFile = Join-Path $env:TEMP ("talksys-mutex-ready-" + [guid]::NewGuid().ToString('N') + ".txt")
$job = $null

try {
  $job = Start-Job -ScriptBlock {
    param($Name, $ReadyFile)

    $created = $false
    $mutex = [System.Threading.Mutex]::new($true, $Name, [ref]$created)
    if (-not $created) {
      try { $mutex.Dispose() } catch {}
      throw "holder failed to acquire named mutex"
    }

    try {
      Set-Content -LiteralPath $ReadyFile -Value 'ready' -NoNewline -Force
      Start-Sleep -Seconds 10
    } finally {
      try { $mutex.ReleaseMutex() } catch {}
      try { $mutex.Dispose() } catch {}
    }
  } -ArgumentList $mutexName, $readyFile

  $deadline = (Get-Date).AddSeconds(5)
  while (-not (Test-Path $readyFile) -and (Get-Date) -lt $deadline) {
    if ($job.State -eq 'Failed') {
      Receive-Job $job
      throw "mutex holder job failed before readiness"
    }
    Start-Sleep -Milliseconds 50
  }
  if (-not (Test-Path $readyFile)) {
    throw "mutex holder did not become ready"
  }

  $probeCreated = $false
  $probe = [System.Threading.Mutex]::new($true, $mutexName, [ref]$probeCreated)
  try {
    if ($probeCreated) {
      try { $probe.ReleaseMutex() } catch {}
      throw "second process unexpectedly created the supervisor mutex"
    }
  } finally {
    try { $probe.Dispose() } catch {}
  }

  Write-Host "[ok] concurrent process could not acquire supervisor singleton mutex"
} finally {
  if ($job) {
    Stop-Job $job -ErrorAction SilentlyContinue
    Remove-Job $job -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $readyFile -Force -ErrorAction SilentlyContinue
}

# Confirm an abruptly ended owner does not permanently wedge future starts.
$afterCreated = $false
$after = [System.Threading.Mutex]::new($true, $mutexName, [ref]$afterCreated)
try {
  if (-not $afterCreated) {
    throw "supervisor mutex remained unavailable after holder process ended"
  }
  Write-Host "[ok] mutex is acquirable after prior owner termination"
} finally {
  if ($afterCreated) {
    try { $after.ReleaseMutex() } catch {}
  }
  try { $after.Dispose() } catch {}
}

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

if (!(Test-Path ".env") -and (Test-Path ".env.example")) {
  Copy-Item ".env.example" ".env"
  Write-Host "[vidunpack] Created .env from .env.example (edit keys if needed)."
}

$env:DATA_DIR = $env:DATA_DIR ?? "data"
$env:TOOLSERVER_PORT = $env:TOOLSERVER_PORT ?? "6791"
$env:ORCHESTRATOR_PORT = $env:ORCHESTRATOR_PORT ?? "6785"

$toolCandidates = @(
  (Join-Path $root "bin\\vidunpack-toolserver.exe"),
  (Join-Path $root "target\\release\\vidunpack-toolserver.exe"),
  (Join-Path $root "target\\debug\\vidunpack-toolserver.exe")
)
$toolserver = $toolCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $toolserver) {
  throw "toolserver binary not found (expected bin\\vidunpack-toolserver.exe or target\\release\\vidunpack-toolserver.exe)"
}

Write-Host "[vidunpack] Starting toolserver: $toolserver"
$toolProc = Start-Process -FilePath $toolserver -WorkingDirectory $root -PassThru

try {
  Start-Sleep -Milliseconds 300
  Write-Host "[vidunpack] Starting orchestrator…"
  if (!(Test-Path (Join-Path $root "node_modules"))) {
    throw "node_modules not found. Run 'npm ci --omit=dev' in the package root first."
  }
  Push-Location (Join-Path $root "apps\\orchestrator")
  Start-Process "http://127.0.0.1:$env:ORCHESTRATOR_PORT" | Out-Null
  node dist/index.js
} finally {
  Pop-Location -ErrorAction SilentlyContinue
  if ($toolProc -and !$toolProc.HasExited) {
    Write-Host "[vidunpack] Stopping toolserver…"
    Stop-Process -Id $toolProc.Id -Force
  }
}

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Info([string]$msg) {
  Write-Host "[vidunpack:setup] $msg"
}

function Ensure-Dir([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) {
    New-Item -ItemType Directory -Force -Path $path | Out-Null
  }
}

function Download-File([string]$url, [string]$outFile) {
  Write-Info "Downloading: $url"
  Invoke-WebRequest -Uri $url -OutFile $outFile -UseBasicParsing
}

function Install-YtDlp([string]$repoRoot) {
  $destDir = Join-Path $repoRoot "tools\\yt-dlp"
  $exe = Join-Path $destDir "yt-dlp.exe"
  if (Test-Path -LiteralPath $exe) {
    Write-Info "yt-dlp already exists: $exe"
    return
  }

  Ensure-Dir $destDir
  $tmp = Join-Path $env:TEMP ("vidunpack-yt-dlp-" + [guid]::NewGuid().ToString("N"))
  Ensure-Dir $tmp
  try {
    $tmpExe = Join-Path $tmp "yt-dlp.exe"
    Download-File "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" $tmpExe
    Copy-Item -LiteralPath $tmpExe -Destination $exe -Force
    Write-Info "Installed yt-dlp: $exe"
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue | Out-Null
  }
}

function Install-Ffmpeg([string]$repoRoot) {
  $destDir = Join-Path $repoRoot "tools\\ffmpeg"
  $binDir = Join-Path $destDir "bin"
  $ffmpegExe = Join-Path $binDir "ffmpeg.exe"
  $ffprobeExe = Join-Path $binDir "ffprobe.exe"
  if ((Test-Path -LiteralPath $ffmpegExe) -and (Test-Path -LiteralPath $ffprobeExe)) {
    Write-Info "ffmpeg already exists: $ffmpegExe"
    return
  }

  Ensure-Dir $binDir
  $tmp = Join-Path $env:TEMP ("vidunpack-ffmpeg-" + [guid]::NewGuid().ToString("N"))
  Ensure-Dir $tmp
  try {
    $zip = Join-Path $tmp "ffmpeg.zip"
    Download-File "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip" $zip
    Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force

    $found = Get-ChildItem -Path $tmp -Recurse -Filter "ffmpeg.exe" -File | Select-Object -First 1
    if (-not $found) {
      throw "ffmpeg.exe not found after extraction"
    }
    $foundBin = Split-Path -Parent $found.FullName

    Copy-Item -LiteralPath (Join-Path $foundBin "*") -Destination $binDir -Force

    # Best-effort: copy license/readme next to tools\ffmpeg
    $root = Split-Path -Parent (Split-Path -Parent $foundBin)
    foreach ($name in @("LICENSE", "LICENSE.txt", "COPYING", "COPYING.txt", "README.txt")) {
      $p = Join-Path $root $name
      if (Test-Path -LiteralPath $p) {
        Copy-Item -LiteralPath $p -Destination $destDir -Force
      }
    }

    if (-not (Test-Path -LiteralPath $ffmpegExe)) { throw "ffmpeg.exe not found in $binDir after copy" }
    if (-not (Test-Path -LiteralPath $ffprobeExe)) { throw "ffprobe.exe not found in $binDir after copy" }

    Write-Info "Installed ffmpeg: $ffmpegExe"
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue | Out-Null
  }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Write-Info "Repo: $repoRoot"

if ($env:OS -notlike "*Windows*") {
  Write-Info "This script is Windows-focused. On macOS/Linux, install ffmpeg and yt-dlp via your package manager."
  exit 0
}

Install-Ffmpeg $repoRoot
Install-YtDlp $repoRoot

Write-Info "Done."


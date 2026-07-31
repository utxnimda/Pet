param(
  [Parameter(Mandatory = $true)]
  [string]$PythonExe,

  [string]$VideoRoot,

  [string]$OutputRoot,

  [string]$ReportRoot,

  [int]$Fps = 20,

  [int]$MaxFrames = 48,

  [string]$FfmpegExe = 'ffmpeg',

  [switch]$SkipMissing
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$videoScript = Join-Path $PSScriptRoot 'video-to-motion-apng.py'

if (-not $VideoRoot) {
  $VideoRoot = Join-Path $projectRoot 'assets\generated\videos'
}
if (-not $OutputRoot) {
  $OutputRoot = Join-Path $projectRoot 'assets\motion'
}
if (-not $ReportRoot) {
  $ReportRoot = Join-Path $projectRoot 'test-output\video-motion-reports'
}

foreach ($requiredPath in @($PythonExe, $videoScript)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) {
    throw "Required path not found: $requiredPath"
  }
}

if ($Fps -lt 1) {
  throw '-Fps must be positive.'
}
if ($MaxFrames -lt 2) {
  throw '-MaxFrames must be at least 2.'
}

New-Item -ItemType Directory -Force -Path $OutputRoot, $ReportRoot | Out-Null

$actions = @(
  'idle',
  'walk',
  'depressed',
  'argue',
  'run',
  'sleep'
)

foreach ($action in $actions) {
  $videoPath = Join-Path $VideoRoot "duck-$action.mp4"
  if (-not (Test-Path -LiteralPath $videoPath)) {
    if ($SkipMissing) {
      Write-Warning "Skipping missing video: $videoPath"
      continue
    }
    throw "Missing video: $videoPath"
  }

  $outputPath = Join-Path $OutputRoot "duck-$action.png"
  $reportPath = Join-Path $ReportRoot "$action.json"

  & $PythonExe `
    $videoScript `
    --input-video $videoPath `
    --out $outputPath `
    --report $reportPath `
    --fps $Fps `
    --max-frames $MaxFrames `
    --ffmpeg-exe $FfmpegExe `
    --anchor-color '#00ffff' `
    --anchor-search '0,0,160,160' `
    --background-color '#ff00ff' `
    --quiet

  if ($LASTEXITCODE -ne 0) {
    throw "Video motion build failed for $action"
  }
}

Get-ChildItem -LiteralPath $OutputRoot -Filter 'duck-*.png' |
  Sort-Object Name |
  Select-Object Name, Length

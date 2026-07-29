$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$assetRoot = Join-Path $projectRoot 'assets'
$outputRoot = Join-Path $assetRoot 'animations'

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null

function New-PetAnimation {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Source,

    [Parameter(Mandatory = $true)]
    [string]$Output,

    [Parameter(Mandatory = $true)]
    [double]$Duration,

    [Parameter(Mandatory = $true)]
    [double]$Cycle,

    [Parameter(Mandatory = $true)]
    [double]$Angle,

    [Parameter(Mandatory = $true)]
    [int]$Bob
  )

  $filter = "[1:v]scale=474:474:force_original_aspect_ratio=decrease," +
    "pad=474:474:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba," +
    "rotate='$Angle*sin(2*PI*t/$Cycle)':ow=rotw(iw):oh=roth(ih):c=none[pet];" +
    "[0:v][pet]overlay=x='(W-w)/2':y='(H-h)/2-$Bob*sin(2*PI*t/$Cycle)':" +
    "eval=frame:format=auto,format=rgba[v]"

  & ffmpeg `
    -y `
    -hide_banner `
    -loglevel warning `
    -f lavfi `
    -i "color=c=black@0.0:s=512x512:r=30:d=$Duration,format=rgba" `
    -loop 1 `
    -framerate 30 `
    -i $Source `
    -filter_complex $filter `
    -map '[v]' `
    -t $Duration `
    -an `
    -c:v libwebp_anim `
    -q:v 72 `
    -compression_level 4 `
    -loop 0 `
    $Output

  if ($LASTEXITCODE -ne 0) {
    throw "FFmpeg failed while creating $Output"
  }
}

$classicSource = Join-Path $assetRoot 'pet.png'
$duckRoot = Join-Path $assetRoot 'models\duck'

New-PetAnimation `
  -Source $classicSource `
  -Output (Join-Path $outputRoot 'classic-idle.webp') `
  -Duration 3.0 `
  -Cycle 3.0 `
  -Angle 0.010 `
  -Bob 5

New-PetAnimation `
  -Source $classicSource `
  -Output (Join-Path $outputRoot 'classic-wave.webp') `
  -Duration 1.6 `
  -Cycle 0.8 `
  -Angle 0.026 `
  -Bob 8

New-PetAnimation `
  -Source $classicSource `
  -Output (Join-Path $outputRoot 'classic-sleep.webp') `
  -Duration 4.0 `
  -Cycle 4.0 `
  -Angle 0.004 `
  -Bob 3

New-PetAnimation `
  -Source (Join-Path $duckRoot 'idle.png') `
  -Output (Join-Path $outputRoot 'duck-idle.webp') `
  -Duration 3.0 `
  -Cycle 3.0 `
  -Angle 0.010 `
  -Bob 5

New-PetAnimation `
  -Source (Join-Path $duckRoot 'wave.png') `
  -Output (Join-Path $outputRoot 'duck-wave.webp') `
  -Duration 1.6 `
  -Cycle 0.8 `
  -Angle 0.026 `
  -Bob 8

New-PetAnimation `
  -Source (Join-Path $duckRoot 'sleep.png') `
  -Output (Join-Path $outputRoot 'duck-sleep.webp') `
  -Duration 4.0 `
  -Cycle 4.0 `
  -Angle 0.004 `
  -Bob 3

Get-ChildItem -LiteralPath $outputRoot -Filter '*.webp' |
  Sort-Object Name |
  Select-Object Name, Length

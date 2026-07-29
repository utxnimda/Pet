$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$sheetRoot = Join-Path $projectRoot 'assets\sprite-sheets\duck'
$frameRoot = Join-Path $projectRoot 'assets\frames\duck'
$motionRoot = Join-Path $projectRoot 'assets\motion'

New-Item -ItemType Directory -Force -Path $frameRoot, $motionRoot | Out-Null

$animations = @(
  @{
    Name = 'run'
    Source = Join-Path $sheetRoot 'run-sheet.png'
    FramesPerSecond = 12
  },
  @{
    Name = 'walk'
    Source = Join-Path $sheetRoot 'walk-sheet.png'
    FramesPerSecond = 8
  },
  @{
    Name = 'sleep'
    Source = Join-Path $sheetRoot 'sleep-sheet.png'
    FramesPerSecond = 4
  }
)

foreach ($animation in $animations) {
  $bitmap = [System.Drawing.Bitmap]::FromFile($animation.Source)

  try {
    $cellWidth = [Math]::Floor($bitmap.Width / 4)
    $cellHeight = [Math]::Floor($bitmap.Height / 2)
  } finally {
    $bitmap.Dispose()
  }

  $animationFrameRoot = Join-Path $frameRoot $animation.Name
  New-Item -ItemType Directory -Force -Path $animationFrameRoot | Out-Null

  for ($index = 0; $index -lt 8; $index += 1) {
    $column = $index % 4
    $row = [Math]::Floor($index / 4)
    $cropX = ($column * $cellWidth) + 3
    $cropY = ($row * $cellHeight) + 3
    $cropWidth = $cellWidth - 6
    $cropHeight = $cellHeight - 6
    $outputFrame = Join-Path $animationFrameRoot ('frame-{0:D2}.png' -f $index)

    $filter = "crop=$cropWidth`:$cropHeight`:$cropX`:$cropY," +
      "colorkey=0xF303EE:0.22:0.08,format=rgba," +
      "scale=500:500:force_original_aspect_ratio=decrease," +
      "pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba"

    & ffmpeg `
      -y `
      -hide_banner `
      -loglevel error `
      -i $animation.Source `
      -vf $filter `
      -frames:v 1 `
      $outputFrame

    if ($LASTEXITCODE -ne 0) {
      throw "Failed to extract $($animation.Name) frame $index"
    }
  }

  $outputAnimation = Join-Path $motionRoot "duck-$($animation.Name).webp"
  $inputPattern = Join-Path $animationFrameRoot 'frame-%02d.png'

  & ffmpeg `
    -y `
    -hide_banner `
    -loglevel warning `
    -framerate $animation.FramesPerSecond `
    -start_number 0 `
    -i $inputPattern `
    -frames:v 8 `
    -an `
    -c:v libwebp_anim `
    -q:v 84 `
    -compression_level 5 `
    -loop 0 `
    $outputAnimation

  if ($LASTEXITCODE -ne 0) {
    throw "Failed to encode $outputAnimation"
  }
}

$frameChecks = foreach ($animation in $animations) {
  $firstFrame = Join-Path (Join-Path $frameRoot $animation.Name) 'frame-00.png'
  $bitmap = [System.Drawing.Bitmap]::FromFile($firstFrame)

  try {
    $corner = $bitmap.GetPixel(0, 0)
    [PSCustomObject]@{
      Name = $animation.Name
      Width = $bitmap.Width
      Height = $bitmap.Height
      CornerAlpha = $corner.A
    }
  } finally {
    $bitmap.Dispose()
  }
}

$frameChecks | Format-Table -AutoSize
Get-ChildItem -LiteralPath $motionRoot -Filter 'duck-*.webp' |
  Sort-Object Name |
  Select-Object Name, Length

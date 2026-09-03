# Full trailer render: frames -> timeline.json -> silent master mp4.
# Run from the repo root with the static server up (node scripts/perf/server.mjs 8123).
#   powershell -File scripts\trailer\render.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $here '..\..')
Set-Location $root

node scripts/trailer/capture.mjs
if ($LASTEXITCODE -ne 0) { throw "capture failed" }

ffmpeg -y -framerate 30 -i scripts/trailer/frames/f%05d.png -c:v libx264 -pix_fmt yuv420p `
  -crf 18 -preset slow -movflags +faststart nova-trailer-silent.mp4
if ($LASTEXITCODE -ne 0) { throw "encode failed" }

Write-Host "done: nova-trailer-silent.mp4"
Get-Content scripts/trailer/frames/timeline.json | Select-Object -First 40

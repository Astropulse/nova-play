#!/bin/sh
# Previs finish chain: frames -> previs-silent.mp4 -> real game SFX mix (+ narration + music) -> mux -> review proxy.
# Run after `node scripts/trailer/capture.mjs`. (Lives in the repo so it survives session restarts.)
set -e
cd "$(dirname "$0")/../.."
ffmpeg -y -v error -framerate 30 -i scripts/trailer/frames/f%05d.png -c:v libx264 -pix_fmt yuv420p -crf 18 -preset medium -movflags +faststart previs-silent.mp4
python scripts/trailer/mix_gamesfx.py
ffmpeg -y -v error -i previs-silent.mp4 -i previs-audio.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart nova-trailer-previs.mp4
ffmpeg -y -v error -i nova-trailer-previs.mp4 -vf scale=1280:720:flags=lanczos -c:v libx264 -crf 25 -preset medium -c:a copy -movflags +faststart scripts/trailer/review/previs-proxy.mp4
ffprobe -v error -show_entries format=duration -of csv=p=0 nova-trailer-previs.mp4
echo PREVIS DONE

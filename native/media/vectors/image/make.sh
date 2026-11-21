#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Regenerates inputs/ with ImageMagick 7 (`magick`). The files are committed; cases.json
# records what ace-media must answer for each. Run from this directory.
set -eu
cd inputs
magick -size 64x48 xc:'#d02020' -quality 90 red-64x48.jpg
magick -size 40x30 gradient:'#2040ff-#ffffff' -interlace JPEG -quality 85 progressive-40x30.jpg
# 30 x 20 stored, a blue left half; EXIF orientation 6 (turn 90° clockwise to show).
magick -size 15x20 xc:'#0000ff' -size 15x20 xc:'#ffff00' +append -quality 95 exif-plain.jpg
python3 - <<'PY'
import struct
jpeg = open("exif-plain.jpg", "rb").read()
tiff = b"II*\0" + struct.pack("<IH", 8, 1) + struct.pack("<HHIHH", 0x0112, 3, 1, 6, 0) + b"\0\0\0\0"
app1 = b"\xff\xe1" + struct.pack(">H", 2 + 6 + len(tiff)) + b"Exif\0\0" + tiff
open("exif-6.jpg", "wb").write(jpeg[:2] + app1 + jpeg[2:])
PY
rm exif-plain.jpg
head -c 200 red-64x48.jpg > truncated.jpg
# Transparent left half, opaque green right half.
magick -size 16x32 xc:none -size 16x32 xc:'#00c000' +append +repage png32:alpha-32x32.png
magick -size 16x16 gradient:black-white -colorspace Gray -depth 16 gray16-16x16.png
magick -size 8x8 xc:'#ff00ff' -colors 2 png8:palette-8x8.png
head -c 120 alpha-32x32.png > truncated.png
magick -size 24x24 plasma:fractal -seed 7 -define webp:lossless=true lossless-24x24.webp
magick -size 24x24 xc:'#ff8000' -alpha set -channel A -evaluate set 50% +channel -quality 80 alpha-24x24.webp
head -c 60 lossless-24x24.webp > truncated.webp
magick -size 10x10 xc:'#ff0000' -size 10x10 xc:'#0000ff' -delay 10 -loop 0 two-frames-10x10.gif
head -c 30 two-frames-10x10.gif > truncated.gif
magick -size 64x64 xc:'#ffa000' icon-64.png
magick icon-64.png -define icon:auto-resize=16,32,48,64 icon.ico
# A device: a 20 x 40 blue screen, its rounded-corner mask, and 28 x 48 chrome with a hole.
magick -size 20x40 xc:'#0000ff' screen-20x40.png
magick -size 20x40 xc:none -fill white -draw 'roundrectangle 0,0 19,39 6,6' png32:screen-mask-20x40.png
magick -size 28x48 xc:'#303030' -alpha set -channel A -fx '(i>=4&&i<24&&j>=4&&j<44)?0:1' +channel png32:chrome-28x48.png
# chrome-3x5.svg and outside.svg are written by hand (outside.svg: a script, text and two
# images outside the document, none of which may be drawn or read).
printf 'not an image\n' > text.txt
# A 2 x 2 RGBA picture: red, green, blue, transparent.
printf '\377\000\000\377\000\377\000\377\000\000\377\377\000\000\000\000' > square-2x2.rgba

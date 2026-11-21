# Image integrity fixtures

These images were generated locally for ace, with no source photograph or owner screenshot.
All of them contain a 320 by 240 synthetic colour field. A seeded integer sequence fills RGBA
pixels, including varying alpha. PNG and JPEG carry an sRGB ICC profile. JPEG flattens the
field against white before encoding; WebP and GIF use their native encoders. HEIC, TIFF and BMP
were converted from the PNG with macOS `sips`; they are kept as opaque files with a preview.

Tests compare the complete original file hash, sniffed MIME, decoded dimensions and pixels,
and ICC bytes after upload and restart. The PNG exceeds multiple 64 KiB upload chunks.
The previews have a separate bounded decode and never replace these originals.

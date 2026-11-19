// SPDX-License-Identifier: Apache-2.0
//! A deterministic picture shaped like an app screen, for stills tests and benches: a title
//! bar, a side list, rows of text-like strokes and a photo-like panel. Flat test colours
//! compress to nothing, so poster sizes and JPEG timings need content like this.
#![allow(dead_code)]
use media_codec::{CpuPicture, PixelFormat, Plane, Size};

/// A small deterministic hash, so the strokes look irregular without a random source.
fn hash(mut x: u32) -> u32 {
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb_352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846c_a68b);
    x ^ (x >> 16)
}

/// The screen scrolled by `frame` × 6 pixels, as packed RGB.
pub fn screen(size: Size, frame: u32) -> CpuPicture {
    let (w, h) = (size.width as usize, size.height as usize);
    let mut rgb = vec![0u8; w * h * 3];
    let unit = (size.width / 400).max(1) as usize;
    let bar = 44 * unit;
    let side = w / 4;
    let line = 22 * unit;
    let scroll = frame as usize * 6;
    for y in 0..h {
        let row = &mut rgb[y * w * 3..(y + 1) * w * 3];
        for x in 0..w {
            let px: [u8; 3] = if y < bar {
                [32, 88, 196]
            } else if x < side {
                let item = (y + scroll) / (40 * unit);
                if item.is_multiple_of(2) {
                    [238, 240, 244]
                } else {
                    [228, 231, 237]
                }
            } else {
                let yy = y + scroll;
                let panel =
                    yy % (900 * unit) < 260 * unit && x > side + 16 * unit && x < w - 16 * unit;
                if panel {
                    // A photo: smooth gradients with some grain.
                    let g = hash((x as u32) << 16 ^ yy as u32) % 24;
                    [
                        (90 + (x * 120 / w) as u32 + g) as u8,
                        (120 + ((yy % 260) * 80 / 260) as u32 + g) as u8,
                        (160 + g / 2) as u8,
                    ]
                } else {
                    let line_index = yy / line;
                    let in_line = yy % line;
                    let x0 = x - side;
                    // Words: runs of strokes with gaps, a ragged right edge per line.
                    let word = x0 / (7 * unit);
                    let length = 60 + hash(line_index as u32) as usize % 40;
                    let ink = in_line >= 6 * unit
                        && in_line < 16 * unit
                        && word < length
                        && !hash((line_index as u32) << 12 ^ word as u32).is_multiple_of(6)
                        && !hash((x0 as u32) << 8 ^ yy as u32 ^ 0x5bd1).is_multiple_of(3);
                    if ink { [36, 38, 44] } else { [252, 252, 253] }
                }
            };
            row[x * 3..x * 3 + 3].copy_from_slice(&px);
        }
    }
    CpuPicture::new(
        size,
        PixelFormat::Rgb8,
        [Plane {
            data: rgb,
            stride: w * 3,
        }],
        u64::from(frame) * 16_667,
    )
    .unwrap_or_else(|_| unreachable!())
}

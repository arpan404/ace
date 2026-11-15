// SPDX-License-Identifier: Apache-2.0
//! Writes the committed seed corpus: `cargo run --bin seed_corpus` from
//! native/media/fuzz. Each seed is one selector byte followed by a JPEG.
use libjpeg_turbo_rs::{Encoder, PixelFormat, Subsampling};
use std::path::Path;

fn pixels(w: usize, h: usize, bpp: usize) -> Vec<u8> {
    (0..w * h * bpp)
        .map(|i| {
            let (p, c) = (i / bpp, i % bpp);
            ((p % w) * 255 / w.max(1) + (p / w) * 7 + c * 60) as u8
        })
        .collect()
}
fn encode(
    w: usize,
    h: usize,
    format: PixelFormat,
    bpp: usize,
    sub: Subsampling,
    restart: u16,
) -> Vec<u8> {
    Encoder::new(&pixels(w, h, bpp), w, h, format)
        .quality(85)
        .subsampling(sub)
        .restart_blocks(restart)
        .encode()
        .unwrap_or_else(|e| panic!("{e}"))
}
fn rgb(w: usize, h: usize, sub: Subsampling) -> Vec<u8> {
    encode(w, h, PixelFormat::Rgb, 3, sub, 0)
}
/// Offset of the first byte of the segment body for `marker`.
fn body(jpeg: &[u8], marker: u8) -> usize {
    let mut pos = 2;
    loop {
        let len = usize::from(u16::from_be_bytes([jpeg[pos + 2], jpeg[pos + 3]]));
        if jpeg[pos + 1] == marker {
            return pos + 4;
        }
        pos += 2 + len;
    }
}

fn main() -> std::io::Result<()> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("corpus/transcode");
    std::fs::create_dir_all(&dir)?;
    let mut seeds: Vec<(&str, Vec<u8>)> = vec![
        (
            "gray",
            encode(33, 17, PixelFormat::Grayscale, 1, Subsampling::S444, 0),
        ),
        ("444", rgb(33, 17, Subsampling::S444)),
        ("422", rgb(33, 17, Subsampling::S422)),
        ("420", rgb(33, 17, Subsampling::S420)),
        ("440", rgb(33, 17, Subsampling::S440)),
        ("411", rgb(33, 17, Subsampling::S411)),
        ("1x1", rgb(1, 1, Subsampling::S420)),
        ("odd-7x9", rgb(7, 9, Subsampling::S420)),
        ("odd-17x33", rgb(17, 33, Subsampling::S422)),
        (
            "restart-1",
            encode(40, 24, PixelFormat::Rgb, 3, Subsampling::S420, 1),
        ),
        (
            "restart-3",
            encode(40, 24, PixelFormat::Rgb, 3, Subsampling::S444, 3),
        ),
        (
            "progressive",
            libjpeg_turbo_rs::compress_progressive(
                &pixels(33, 17, 3),
                33,
                17,
                PixelFormat::Rgb,
                85,
                Subsampling::S420,
            )
            .unwrap_or_else(|e| panic!("{e}")),
        ),
        (
            "arithmetic",
            libjpeg_turbo_rs::compress_arithmetic(
                &pixels(33, 17, 3),
                33,
                17,
                PixelFormat::Rgb,
                85,
                Subsampling::S420,
            )
            .unwrap_or_else(|e| panic!("{e}")),
        ),
        (
            "cmyk",
            encode(17, 9, PixelFormat::Cmyk, 4, Subsampling::S444, 0),
        ),
    ];
    // Near-maximal coefficients, then every quantiser raised to 255.
    let board: Vec<u8> = (0..32 * 16)
        .flat_map(|i| {
            if (i % 32 + i / 32) % 2 == 0 {
                [0, 255, 0]
            } else {
                [255, 0, 255]
            }
        })
        .collect();
    let mut extreme = Encoder::new(&board, 32, 16, PixelFormat::Rgb)
        .quality(100)
        .subsampling(Subsampling::S444)
        .encode()
        .unwrap_or_else(|e| panic!("{e}"));
    let dqt = body(&extreme, 0xDB);
    let len = usize::from(u16::from_be_bytes([extreme[dqt - 2], extreme[dqt - 1]])) - 2;
    for table in extreme[dqt..dqt + len].chunks_exact_mut(65) {
        table[1..].fill(255);
    }
    seeds.push(("extreme-coefficients", extreme));
    let base = rgb(33, 17, Subsampling::S420);
    let mut bad_dht = base.clone();
    let dht = body(&bad_dht, 0xC4);
    bad_dht[dht + 1..dht + 3].copy_from_slice(&[3, 9]); // oversubscribed lengths
    seeds.push(("malformed-dht", bad_dht));
    let mut bad_dqt = base.clone();
    let dqt = body(&bad_dqt, 0xDB);
    bad_dqt[dqt + 9] = 0;
    seeds.push(("malformed-dqt", bad_dqt));
    let mut bad_sos = base.clone();
    let sos = body(&bad_sos, 0xDA);
    bad_sos[sos + 3] = bad_sos[sos + 1];
    seeds.push(("malformed-sos", bad_sos));
    let scan = body(&base, 0xDA) + 10;
    seeds.push((
        "truncated-scan",
        base[..scan + (base.len() - scan) / 2].to_vec(),
    ));
    for (i, (name, jpeg)) in seeds.into_iter().enumerate() {
        // Alternate selectors so both the pixel-compare and table paths run.
        let mut seed = vec![(i * 37 + 1) as u8];
        seed.extend_from_slice(&jpeg);
        std::fs::write(dir.join(format!("seed-{name}")), seed)?;
    }
    Ok(())
}

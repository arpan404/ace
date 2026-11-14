// SPDX-License-Identifier: Apache-2.0
//! cargo run --release -p media-codec --example still [optional-input.jpg]
//! Measures JPEG decode -> fit to 1568 -> scale -> JPEG encode, quality 80.
use media_codec::*;
use std::{hint::black_box, time::Instant};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut codec = JpegCodec;
    let input = if let Some(path) = std::env::args().nth(1) {
        std::fs::read(path)?
    } else {
        let size = Size {
            width: 1206,
            height: 2622,
        };
        let data = (0..size.height)
            .flat_map(|y| {
                (0..size.width)
                    .flat_map(move |x| [(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8])
            })
            .collect();
        codec.encode(
            &CpuPicture::new(
                size,
                PixelFormat::Rgb8,
                vec![Plane {
                    data,
                    stride: size.width as usize * 3,
                }],
                0,
            )?,
            80,
        )?
    };
    let mut scaler = CpuScaler::default();
    let mut samples = Vec::new();
    let mut decode_ms = 0.0;
    let mut scale_ms = 0.0;
    let mut encode_ms = 0.0;
    for i in 0..55 {
        let start = Instant::now();
        let decoded = codec.decode(&input)?;
        let decode_end = Instant::now();
        let size = fit_size(
            decoded.size(),
            Size {
                width: 1568,
                height: 1568,
            },
        )?;
        let Picture::Cpu(scaled) = scaler.scale(&Picture::Cpu(decoded), size.width, size.height)?
        else {
            return Err("expected CPU output".into());
        };
        let scale_end = Instant::now();
        black_box(codec.encode(&scaled, 80)?);
        if i >= 5 {
            decode_ms += (decode_end - start).as_secs_f64() * 1000.0;
            scale_ms += (scale_end - decode_end).as_secs_f64() * 1000.0;
            encode_ms += scale_end.elapsed().as_secs_f64() * 1000.0;
        }
        if i >= 5 {
            samples.push(start.elapsed().as_secs_f64() * 1000.0);
        }
    }
    samples.sort_by(f64::total_cmp);
    println!(
        "mean decode {:.3}, scale {:.3}, encode {:.3} ms",
        decode_ms / 50.0,
        scale_ms / 50.0,
        encode_ms / 50.0
    );
    println!(
        "decode + scale + encode: median {:.3} ms, p95 {:.3} ms (50 samples; target <= 6 ms)",
        samples[25], samples[47]
    );
    Ok(())
}

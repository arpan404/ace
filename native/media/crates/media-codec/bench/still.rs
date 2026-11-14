// SPDX-License-Identifier: Apache-2.0
//! cargo run --release -p media-codec --example still [optional-input.jpg]
//! Same frozen input as the original M5 benchmark, quality 80, five warmups + 50 samples.
mod allocation;
mod cpu;
use media_codec::*;
use std::{hint::black_box, time::Instant};
fn report(name: &str, mut samples: Vec<f64>, stages: [f64; 3]) {
    samples.sort_by(f64::total_cmp);
    println!(
        "{name}: median {:.3} ms, p95 {:.3} ms; stage means {:.3} / {:.3} / {:.3} ms",
        samples[25],
        samples[47],
        stages[0] / 50.0,
        stages[1] / 50.0,
        stages[2] / 50.0
    );
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let mut input_path = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--path" => {
                if args.next().as_deref() != Some("cpu") {
                    return Err("M5 only benchmarks the CPU path; GPU belongs to F2".into());
                }
            }
            "--input" => input_path = Some(args.next().ok_or("missing input path")?),
            _ => input_path = Some(arg),
        }
    }
    let input = if let Some(path) = input_path {
        std::fs::read(path)?
    } else {
        include_bytes!("data/still-1206x2622.jpg").to_vec()
    };
    let target = fit_size(
        jpeg_size(&input)?,
        Size {
            width: 1568,
            height: 1568,
        },
    )?;
    println!(
        "target {}x{}, q80, 50 samples; CPU target <= 20 ms p95 on macOS, <= 30 ms elsewhere",
        target.width, target.height
    );
    let cpu_result = cpu::run(&input);
    #[cfg(target_os = "macos")]
    {
        let mut codec = MacJpegCodec::default();
        let mut samples = Vec::new();
        let mut stages = [0.0; 3];
        for i in 0..55 {
            let start = Instant::now();
            let decoded = codec.decode_native(&input, target)?;
            let decode_end = Instant::now();
            let scaled = codec.resize_native(decoded, target)?;
            let scale_end = Instant::now();
            black_box(codec.encode_native(&scaled, 80)?);
            let encode_end = Instant::now();
            if i >= 5 {
                stages[0] += (decode_end - start).as_secs_f64() * 1000.0;
                stages[1] += (scale_end - decode_end).as_secs_f64() * 1000.0;
                stages[2] += (encode_end - scale_end).as_secs_f64() * 1000.0;
                samples.push(start.elapsed().as_secs_f64() * 1000.0);
            }
        }
        report("ImageIO decode / resize / encode", samples, stages);
    }
    cpu_result
}

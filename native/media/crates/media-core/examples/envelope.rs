// SPDX-License-Identifier: Apache-2.0
//! bench/envelope, within the M1-owned crate. Run:
//! cargo run --release --locked -p media-core --example envelope
//! Split counts logical bytes represented by scatter/gather pieces, not copied bytes.
//! Copy measures the optional contiguous transport boundary separately. Setup is untimed.
use media_core::envelope::{PIECE_BYTES, Pieces};
use std::{hint::black_box, process::Command, time::Instant};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cores = std::thread::available_parallelism()?.get();
    let load = load_average()?;
    let report_only = std::env::var("ACE_MEDIA_BENCH_REPORT_ONLY").as_deref() == Ok("1")
        || load > 2.0 * cores as f64;
    for size in [33_333, 300_000, 8 * 1024 * 1024 - 100] {
        let meta = [1; 100];
        let payload = vec![7; size];
        let mut out = vec![0; PIECE_BYTES];
        for mode in ["split", "copy"] {
            let start = Instant::now();
            let mut iterations = 0_u64;
            // Check wall time once per batch so timer overhead cannot dominate splitting.
            while start.elapsed().as_secs_f64() < 1.0 {
                for _ in 0..1000 {
                    for piece in Pieces::new(2, 42, black_box(&meta), black_box(&payload))? {
                        if mode == "copy" {
                            let n = piece.write_to(&mut out)?;
                            black_box(&out[..n]);
                        } else {
                            black_box(piece);
                        }
                    }
                }
                iterations += 1000;
            }
            let seconds = start.elapsed().as_secs_f64();
            let bytes = iterations * (size + meta.len()) as u64;
            let gbps = bytes as f64 / seconds / 1e9;
            println!(
                "{{\"path\":\"envelope {mode}\",\"payloadBytes\":{size},\"frames\":{iterations},\"bytes\":{bytes},\"seconds\":{seconds:.6},\"gbps\":{gbps:.3},\"loadAverage\":{load},\"cores\":{cores},\"reportOnly\":{report_only}}}"
            );
            if mode == "split" && !report_only && gbps < 10.0 {
                return Err("piece split below 10 GB/s".into());
            }
        }
    }
    Ok(())
}
fn load_average() -> Result<f64, Box<dyn std::error::Error>> {
    if cfg!(target_os = "macos") {
        let output = Command::new("sysctl").args(["-n", "vm.loadavg"]).output()?;
        let value = String::from_utf8(output.stdout)?;
        Ok(value
            .split_whitespace()
            .nth(1)
            .ok_or("missing load")?
            .parse()?)
    } else if cfg!(target_os = "linux") {
        Ok(std::fs::read_to_string("/proc/loadavg")?
            .split_whitespace()
            .next()
            .ok_or("missing load")?
            .parse()?)
    } else {
        Ok(f64::MAX)
    }
}

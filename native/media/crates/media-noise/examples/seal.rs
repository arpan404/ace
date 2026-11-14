// SPDX-License-Identifier: Apache-2.0
use chacha20poly1305::{ChaCha20Poly1305, KeyInit, aead::AeadInOut};
use std::{hint::black_box, time::Instant};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cores = std::thread::available_parallelism()?.get();
    let load = load_average()?;
    let report_only = std::env::var("ACE_MEDIA_BENCH_REPORT_ONLY").as_deref() == Ok("1")
        || load > 2.0 * cores as f64;
    let rust = ChaCha20Poly1305::new((&[7; 32]).into());
    let ring = ring::aead::LessSafeKey::new(
        ring::aead::UnboundKey::new(&ring::aead::CHACHA20_POLY1305, &[7; 32]).map_err(|_| "key")?,
    );
    let mut selected_mbps = 0.0;
    for size in [64, 1200, 65519] {
        for backend in ["rustcrypto", "ring"] {
            let mut data = vec![7; size];
            let count = (256_000_000 / size).min(300_000);
            let start = Instant::now();
            for n in 0..count {
                let mut nonce = [0; 12];
                nonce[4..].copy_from_slice(&(n as u64).to_le_bytes());
                if backend == "rustcrypto" {
                    black_box(
                        rust.encrypt_inout_detached(
                            (&nonce).into(),
                            &[],
                            data.as_mut_slice().into(),
                        )
                        .map_err(|_| "seal")?,
                    );
                } else {
                    let _ = black_box(
                        ring.seal_in_place_separate_tag(
                            ring::aead::Nonce::assume_unique_for_key(nonce),
                            ring::aead::Aad::empty(),
                            &mut data,
                        )
                        .map_err(|_| "seal")?,
                    );
                }
                black_box(&data);
            }
            let elapsed = start.elapsed().as_secs_f64();
            let mbps = (size * count) as f64 / elapsed / 1e6;
            if size == 65519 && backend == "ring" {
                selected_mbps = mbps;
            }
            println!(
                "{{\"path\":\"seal/{backend}\",\"frameBytes\":{size},\"frames\":{count},\"mbPerSecond\":{mbps:.3},\"nsPerFrame\":{:.3},\"tsMbPerSecond\":240,\"loadAverage\":{load},\"cores\":{cores},\"reportOnly\":{report_only}}}",
                elapsed * 1e9 / count as f64
            );
        }
        let plain = vec![7; size];
        let count = (64_000_000 / size).min(100_000);
        let mut sender = media_noise::CipherState::new(zeroize::Zeroizing::new([7; 32]), 0)?;
        let mut receiver = media_noise::CipherState::new(zeroize::Zeroizing::new([7; 32]), 0)?;
        let mut frames = Vec::with_capacity(count);
        let start = Instant::now();
        for _ in 0..count {
            frames.push(sender.encrypt(black_box(&plain), &[])?);
        }
        let seal_time = start.elapsed().as_secs_f64();
        let start = Instant::now();
        for frame in &frames {
            black_box(receiver.decrypt(black_box(frame), &[])?);
        }
        let open_time = start.elapsed().as_secs_f64();
        for (operation, elapsed) in [("seal/transport", seal_time), ("open/transport", open_time)] {
            let mbps = (size * count) as f64 / elapsed / 1e6;
            if size == 65519 && operation == "seal/transport" {
                selected_mbps = mbps;
            }
            println!(
                "{{\"path\":\"{operation}\",\"frameBytes\":{size},\"frames\":{count},\"mbPerSecond\":{mbps:.3},\"nsPerFrame\":{:.3},\"loadAverage\":{load},\"cores\":{cores},\"reportOnly\":{report_only}}}",
                elapsed * 1e9 / count as f64
            );
        }
    }
    if !report_only && selected_mbps < 1500.0 {
        return Err("seal below 1.5 GB/s".into());
    }
    Ok(())
}
fn load_average() -> Result<f64, Box<dyn std::error::Error>> {
    if cfg!(target_os = "macos") {
        let output = std::process::Command::new("sysctl")
            .args(["-n", "vm.loadavg"])
            .output()?;
        Ok(String::from_utf8(output.stdout)?
            .split_whitespace()
            .nth(1)
            .ok_or("load")?
            .parse()?)
    } else if cfg!(target_os = "linux") {
        Ok(std::fs::read_to_string("/proc/loadavg")?
            .split_whitespace()
            .next()
            .ok_or("load")?
            .parse()?)
    } else {
        Ok(f64::MAX)
    }
}

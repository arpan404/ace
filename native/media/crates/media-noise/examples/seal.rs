// SPDX-License-Identifier: Apache-2.0
//! bench/seal. Each path times only its per-frame work; keys, buffers and reporting
//! are set up outside the timed loops. Median of three runs per path and size.
use chacha20poly1305::{ChaCha20Poly1305, KeyInit, aead::AeadInOut};
use media_noise::{FragmentKind, Fragments, RelayStream};
use media_wire::keys::KeyBlock;
use serde_json::json;
use std::{hint::black_box, time::Instant};
use zeroize::Zeroizing;
type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;
/// A path runs `frames` frames of `size` plaintext bytes and returns the timed part.
type Path = Box<dyn FnMut(usize, usize) -> Result<Timing>>;
const FULL_FRAME: usize = 65519;
const TARGET_MBPS: f64 = 1500.0;

fn main() -> Result {
    if cfg!(debug_assertions) {
        return Err("seal requires cargo run --release".into());
    }
    let cores = std::thread::available_parallelism()?.get();
    let mut paths: Vec<(&str, Path)> = vec![
        ("seal/rustcrypto", rustcrypto()),
        ("seal/ring", ring_raw()?),
        ("seal/transport", transport_seal()?),
        ("open/transport", transport_open()?),
    ];
    let mut failed = false;
    for size in [64, 1200, FULL_FRAME] {
        for (name, path) in &mut paths {
            let meets = report(name, size, cores, path)?;
            // The gate is the public transport encryption path at full frames.
            failed |= *name == "seal/transport" && size == FULL_FRAME && !meets;
        }
    }
    if failed {
        return Err("transport seal below 1.5 GB/s".into());
    }
    Ok(())
}
/// Wall time decides the gate. Thread CPU time is reported beside it so a run on a
/// contended host still shows what the cipher does per second of CPU it was given.
#[derive(Clone, Copy, Default)]
struct Timing {
    wall: f64,
    cpu: f64,
}
impl Timing {
    fn add(self, other: Timing) -> Timing {
        Timing {
            wall: self.wall + other.wall,
            cpu: self.cpu + other.cpu,
        }
    }
}
struct Clock {
    wall: Instant,
    cpu: f64,
}
impl Clock {
    fn start() -> Self {
        Self {
            wall: Instant::now(),
            cpu: thread_cpu_seconds(),
        }
    }
    fn elapsed(&self) -> Timing {
        Timing {
            cpu: thread_cpu_seconds() - self.cpu,
            wall: self.wall.elapsed().as_secs_f64(),
        }
    }
}
#[allow(unsafe_code)]
fn thread_cpu_seconds() -> f64 {
    let mut now = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: `now` is a valid, writable timespec for the duration of the call.
    if unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut now) } != 0 {
        return f64::NAN;
    }
    now.tv_sec as f64 + now.tv_nsec as f64 * 1e-9
}
fn nonce(next: &mut u64) -> [u8; 12] {
    let mut nonce = [0; 12];
    nonce[4..].copy_from_slice(&next.to_le_bytes());
    *next += 1;
    nonce
}
fn rustcrypto() -> Path {
    let cipher = ChaCha20Poly1305::new((&[7; 32]).into());
    let mut next = 0;
    Box::new(move |size, frames| {
        let mut data = vec![7; size];
        let start = Clock::start();
        for _ in 0..frames {
            black_box(
                cipher
                    .encrypt_inout_detached(
                        (&nonce(&mut next)).into(),
                        &[],
                        black_box(&mut data[..]).into(),
                    )
                    .map_err(|_| "seal")?,
            );
        }
        Ok(start.elapsed())
    })
}
fn ring_raw() -> Result<Path> {
    let key = ring::aead::LessSafeKey::new(
        ring::aead::UnboundKey::new(&ring::aead::CHACHA20_POLY1305, &[7; 32]).map_err(|_| "key")?,
    );
    let mut next = 0;
    Ok(Box::new(move |size, frames| {
        let mut data = vec![7; size];
        let start = Clock::start();
        for _ in 0..frames {
            let _ = black_box(
                key.seal_in_place_separate_tag(
                    ring::aead::Nonce::assume_unique_for_key(nonce(&mut next)),
                    ring::aead::Aad::empty(),
                    black_box(&mut data[..]),
                )
                .map_err(|_| "seal")?,
            );
        }
        Ok(start.elapsed())
    }))
}
fn stream() -> Result<RelayStream> {
    let block = KeyBlock {
        send_key: Zeroizing::new([7; 32]),
        receive_key: Zeroizing::new([7; 32]),
        send_nonce: 0,
        receive_nonce: 0,
        frames_sent: 0,
        frames_received: 0,
        flags: 0,
        window: 0,
        unacked: 0,
        owed: 0,
        uncounted: 0,
    };
    // Parsing the key block happens once per stream, never per frame.
    Ok(RelayStream::import(Zeroizing::new(
        block.encode().map_err(|_| "block")?.to_vec(),
    ))?)
}
/// The production send path: fragment into one reused buffer, seal it in place.
fn transport_seal() -> Result<Path> {
    let mut stream = stream()?;
    let mut buffer = Vec::new();
    Ok(Box::new(move |size, frames| {
        // `size` is the sealed plaintext, so the message excludes the fragment header.
        let message = vec![7; size - 1];
        let start = Clock::start();
        for _ in 0..frames {
            let mut fragments = Fragments::new(black_box(&message), FragmentKind::Binary)?;
            while fragments.next_into(&mut buffer) {
                stream.seal_in_place(&mut buffer)?;
                black_box(&buffer);
            }
        }
        Ok(start.elapsed())
    }))
}
/// The production receive path: frame read into one reused buffer, opened in place.
/// Frames are sealed in untimed batches; the timed part copies each in, as a socket
/// read would, and opens it.
fn transport_open() -> Result<Path> {
    let mut sender = stream()?;
    let mut receiver = stream()?;
    let mut buffer = Zeroizing::new(Vec::new());
    Ok(Box::new(move |size, frames| {
        let plain = vec![7; size];
        let batch_size = (64 << 20) / size;
        let mut batch = Vec::with_capacity(batch_size.min(frames));
        let mut timed = Timing::default();
        let mut left = frames;
        while left > 0 {
            batch.clear();
            for _ in 0..batch_size.min(left) {
                batch.push(sender.seal(&plain)?);
            }
            left -= batch.len();
            let start = Clock::start();
            for sealed in &batch {
                buffer.clear();
                buffer.extend_from_slice(black_box(sealed));
                black_box(receiver.open_in_place(&mut buffer)?);
            }
            timed = timed.add(start.elapsed());
        }
        Ok(timed)
    }))
}
fn median(mut values: [f64; 3]) -> f64 {
    values.sort_by(f64::total_cmp);
    values[1]
}
fn report(name: &str, size: usize, cores: usize, path: &mut Path) -> Result<bool> {
    let frames = (1_024_000_000 / size).min(2_000_000);
    let bytes = (size * frames) as f64;
    path(size, 1000)?;
    let mut runs = Vec::new();
    let mut walls = [0.0; 3];
    let mut cpus = [0.0; 3];
    let mut overloaded = false;
    for run in 0..3 {
        let load = load_average()?;
        overloaded |= load[0] > 2.0 * cores as f64;
        let timing = path(size, frames)?;
        walls[run] = timing.wall;
        cpus[run] = timing.cpu;
        runs.push(json!({
            "loadAverage": load, "seconds": timing.wall, "cpuSeconds": timing.cpu,
            "mbPerSecond": bytes / timing.wall / 1e6,
            "mbPerCpuSecond": bytes / timing.cpu / 1e6,
        }));
    }
    let wall = median(walls);
    let mbps = bytes / wall / 1e6;
    let report_only =
        overloaded || std::env::var("ACE_MEDIA_BENCH_REPORT_ONLY").as_deref() == Ok("1");
    let meets_target = mbps >= TARGET_MBPS;
    println!(
        "{}",
        json!({
            "path": name, "frameBytes": size, "framesPerRun": frames,
            "medianMbPerSecond": mbps, "medianNsPerFrame": wall * 1e9 / frames as f64,
            "medianMbPerCpuSecond": bytes / median(cpus) / 1e6,
            "runs": runs, "cores": cores, "reportOnly": report_only,
            "meetsTarget": meets_target, "tsMbPerSecond": 240,
            "targetArch": std::env::consts::ARCH,
        })
    );
    Ok(meets_target || report_only)
}
fn load_average() -> Result<[f64; 3]> {
    let values = if cfg!(target_os = "macos") {
        let output = std::process::Command::new("sysctl")
            .args(["-n", "vm.loadavg"])
            .output()?;
        if !output.status.success() {
            return Err("load probe failed".into());
        }
        String::from_utf8(output.stdout)?
    } else if cfg!(target_os = "linux") {
        std::fs::read_to_string("/proc/loadavg")?
    } else {
        return Ok([f64::MAX; 3]);
    };
    let loads: Vec<f64> = values
        .split_whitespace()
        .filter_map(|s| s.parse().ok())
        .take(3)
        .collect();
    loads.try_into().map_err(|_| "missing load averages".into())
}

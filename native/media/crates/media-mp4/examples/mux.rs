// SPDX-License-Identifier: Apache-2.0
//! bench/mux, kept in the M3-owned crate. Single-threaded busy wall time is a
//! conservative upper bound on CPU time, excluding fixture setup and load probes.
use media_mp4::{Group, Muxer, Sample, VideoCodec, VideoConfig};
use std::{hint::black_box, process::Command, time::Instant};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cores = std::thread::available_parallelism()?.get();
    let load = load_average()?;
    let report_only = std::env::var("ACE_MEDIA_BENCH_REPORT_ONLY").as_deref() == Ok("1")
        || load > 2.0 * cores as f64;
    // 60 fps, 16 Mbit/s, 1 s GOP; frame sizes total exactly 2,000,000 bytes.
    let payloads: Vec<Vec<u8>> = (0..60)
        .map(|i| vec![0x55; if i < 20 { 33334 } else { 33333 }])
        .collect();
    let start = Instant::now();
    let mut bytes = 0_usize;
    let seconds = 1200;
    let mut mux = new_mux()?;
    for second in 0..seconds {
        let base = second * 90000;
        let samples: Vec<Sample<'_>> = payloads
            .iter()
            .enumerate()
            .map(|(i, p)| Sample {
                timestamp: base + i as u64 * 1500,
                data: p,
                keyframe: i == 0,
            })
            .collect();
        let make_group = || Group {
            video: &samples,
            video_end: base + 90000,
            audio: &[],
            audio_end: 0,
        };
        let fragment = match mux.fragment(make_group()) {
            Err(media_mp4::Error::PartFull) => {
                black_box(mux.finish()?);
                mux = new_mux()?;
                mux.fragment(make_group())?
            }
            result => result?,
        };
        bytes += black_box(fragment).len();
    }
    black_box(mux.finish()?);
    let busy = start.elapsed().as_secs_f64();
    let core_percent = busy / seconds as f64 * 100.0;
    println!(
        "{{\"path\":\"mux 1080p60 16 Mbit/s\",\"seconds\":{seconds},\"frames\":{},\"bytes\":{bytes},\"busyMs\":{:.3},\"corePercentUpperBound\":{core_percent:.6},\"loadAverage\":{load},\"cores\":{cores},\"reportOnly\":{report_only}}}",
        seconds * 60,
        busy * 1000.0
    );
    if !report_only && core_percent > 0.5 {
        return Err("mux exceeds 0.5% of a core".into());
    }
    Ok(())
}
fn new_mux() -> Result<Muxer, media_mp4::Error> {
    Muxer::new(
        VideoConfig {
            codec: VideoCodec::H264,
            width: 1920,
            height: 1080,
            timescale: 90000,
            description: vec![
                1, 66, 0, 30, 255, 225, 0, 4, 103, 66, 0, 30, 1, 0, 2, 104, 0,
            ],
        },
        None,
    )
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
        // No portable load-average API on Windows: refuse enforcement.
        Ok(f64::MAX)
    }
}

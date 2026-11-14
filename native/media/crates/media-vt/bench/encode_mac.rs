// SPDX-License-Identifier: Apache-2.0
use crate::common::*;
use media_codec::*;
use media_vt::{VtEncoder, VtTranscoder};
use std::time::{Duration, Instant};

type Fallible<T> = Result<T, Box<dyn std::error::Error>>;

fn spec(codec: Codec, width: u32, height: u32, fps: u32, bits: u32) -> EncodeSpec {
    EncodeSpec {
        codec,
        size: Size { width, height },
        fps,
        rate: RateControl::Bitrate(bits),
    }
}

fn empty_unit() -> EncodedUnit {
    EncodedUnit {
        codec: Codec::H264,
        size: Size {
            width: 2,
            height: 2,
        },
        format: BitstreamFormat::Avcc,
        data: Vec::new(),
        key: false,
        description: None,
        pts_us: 0,
        duration_us: 0,
    }
}

/// Pushes one picture, draining output while the bounded queue is full.
fn push(
    encoder: &mut VtEncoder,
    frames: &Frames,
    index: u64,
    fps: u32,
    unit: &mut EncodedUnit,
) -> Fallible<u64> {
    let pts = index * 1_000_000 / u64::from(fps);
    let mut bytes = 0;
    loop {
        match encoder.encode(frames.picture(index, pts)?, false) {
            Err(CodecError::Backpressure) => {
                while encoder.poll_into(unit)? {
                    bytes += unit.data.len() as u64;
                }
                std::thread::yield_now();
            }
            other => break other?,
        }
    }
    while encoder.poll_into(unit)? {
        bytes += unit.data.len() as u64;
    }
    Ok(bytes)
}

/// Unpaced: frames per second the hardware sustains.
fn throughput(spec: &EncodeSpec, frames: u64) -> Fallible<f64> {
    let source = Frames::new(spec.size, 16)?;
    let mut encoder = VtEncoder::new();
    encoder.configure(spec)?;
    let mut unit = empty_unit();
    for index in 0..60 {
        push(&mut encoder, &source, index, spec.fps, &mut unit)?;
    }
    encoder.flush()?;
    while encoder.poll_into(&mut unit)? {}
    let started = Instant::now();
    for index in 60..60 + frames {
        push(&mut encoder, &source, index, spec.fps, &mut unit)?;
    }
    encoder.flush()?;
    while encoder.poll_into(&mut unit)? {}
    Ok(frames as f64 / started.elapsed().as_secs_f64())
}

struct Paced {
    cpu: f64,
    xpc: f64,
    bitrate: f64,
}

/// Paced at the stream's rate: this process's CPU time as % of one core.
fn paced(
    warmup: Duration,
    measure: Duration,
    fps: u32,
    mut step: impl FnMut(u64) -> Fallible<u64>,
) -> Fallible<Paced> {
    let interval = Duration::from_secs_f64(1.0 / f64::from(fps));
    let started = Instant::now();
    let mut index = 0u64;
    let mut run = |until: Duration, index: &mut u64| -> Fallible<u64> {
        let begin = Instant::now();
        let mut bytes = 0;
        while begin.elapsed() < until {
            bytes += step(*index)?;
            *index += 1;
            let next = started + interval * (*index as u32);
            if let Some(wait) = next.checked_duration_since(Instant::now()) {
                std::thread::sleep(wait);
            }
        }
        Ok(bytes)
    };
    run(warmup, &mut index)?;
    let (cpu0, xpc0, wall0) = (cpu_time(), xpc_cpu_seconds(), Instant::now());
    let bytes = run(measure, &mut index)?;
    let wall = wall0.elapsed().as_secs_f64();
    Ok(Paced {
        cpu: (cpu_time() - cpu0).as_secs_f64() / wall * 100.0,
        xpc: (xpc_cpu_seconds() - xpc0) / wall * 100.0,
        bitrate: bytes as f64 * 8.0 / wall,
    })
}

fn paced_encode(spec: &EncodeSpec, seconds: u64) -> Fallible<Paced> {
    let source = Frames::new(spec.size, 30)?;
    let mut encoder = VtEncoder::new();
    encoder.configure(spec)?;
    let mut unit = empty_unit();
    paced(
        Duration::from_secs(5),
        Duration::from_secs(seconds),
        spec.fps,
        |index| push(&mut encoder, &source, index, spec.fps, &mut unit),
    )
}

fn paced_transcode(seconds: u64) -> Fallible<Paced> {
    let source_spec = spec(Codec::Hevc, 1206, 2622, 60, 12_000_000);
    let source = Frames::new(source_spec.size, 30)?;
    let mut encoder = VtEncoder::new();
    encoder.configure(&source_spec)?;
    let mut units = Vec::new();
    for index in 0..60u64 {
        encoder.encode(source.picture(index, index * 16_667)?, false)?;
        encoder.flush()?;
        while let Some(unit) = encoder.poll_result()? {
            units.push(unit);
        }
    }
    drop(encoder);
    // The plan's box: 1280 px tall, even width at the source aspect.
    let target = spec(Codec::H264, 588, 1280, 60, 6_000_000);
    let mut transcoder = VtTranscoder::new(&target)?;
    let mut unit = empty_unit();
    paced(
        Duration::from_secs(5),
        Duration::from_secs(seconds),
        60,
        |index| {
            // The source loops; key units restart the decoder's references.
            let source = &units[index as usize % units.len()];
            while let Err(CodecError::Backpressure) = transcoder.push(source, false) {
                transcoder.encoder().flush()?;
                while transcoder.encoder().poll_into(&mut unit)? {}
            }
            let mut bytes = 0;
            while transcoder.encoder().poll_into(&mut unit)? {
                bytes += unit.data.len() as u64;
            }
            Ok(bytes)
        },
    )
}

fn three(mut run: impl FnMut() -> Fallible<Paced>) -> Fallible<(f64, f64, f64)> {
    let mut results = Vec::new();
    for _ in 0..3 {
        results.push(run()?);
    }
    let mut cpu: Vec<f64> = results.iter().map(|r| r.cpu).collect();
    let mut xpc: Vec<f64> = results.iter().map(|r| r.xpc).collect();
    let mut bits: Vec<f64> = results.iter().map(|r| r.bitrate).collect();
    Ok((median(&mut cpu), median(&mut xpc), median(&mut bits)))
}

pub fn main() -> Fallible<()> {
    let args: Vec<String> = std::env::args().collect();
    let value = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    if value("--backend").as_deref().is_some_and(|b| b != "vt") {
        return Err("this bench is the vt backend".into());
    }
    let only = value("--case");
    let seconds: u64 = value("--seconds").map_or(Ok(30), |s| s.parse())?;
    let load = load_average();
    let enforced = enforce(load);
    let header = format!(
        "\"bench\":\"encode\",\"backend\":\"vt\",\"machine\":\"{}\",\"os\":\"{}\",\"load\":{load:.1},\"cores\":{},\"enforced\":{enforced}",
        machine(),
        os_build(),
        cores()
    );
    let wants = |case: &str| only.as_deref().is_none_or(|o| o == case);
    let mut failed = false;
    for (case, spec, minimum) in [
        (
            "hevc-2560x1600",
            spec(Codec::Hevc, 2560, 1600, 60, 20_000_000),
            100.0,
        ),
        (
            "h264-1920x1080",
            spec(Codec::H264, 1920, 1080, 60, 12_000_000),
            240.0,
        ),
    ] {
        if !wants(case) {
            continue;
        }
        let fps = throughput(&spec, 600)?;
        let pass = fps >= minimum;
        failed |= enforced && !pass;
        println!(
            "{{{header},\"case\":\"{case}\",\"fps\":{fps:.1},\"minimumFps\":{minimum},\"pass\":{pass}}}"
        );
    }
    let paced_cases: [(&str, f64); 3] = [
        ("h264-1080p60-cpu", 3.0),
        ("hevc-4k30-cpu", 4.0),
        ("transcode-1206x2622-to-1280-cpu", 3.0),
    ];
    for (case, maximum) in paced_cases {
        if !wants(case) {
            continue;
        }
        let (cpu, xpc, bits) = match case {
            "h264-1080p60-cpu" => {
                three(|| paced_encode(&spec(Codec::H264, 1920, 1080, 60, 8_000_000), seconds))?
            }
            "hevc-4k30-cpu" => {
                three(|| paced_encode(&spec(Codec::Hevc, 3840, 2160, 30, 16_000_000), seconds))?
            }
            _ => three(|| paced_transcode(seconds))?,
        };
        let pass = cpu <= maximum;
        failed |= enforced && !pass;
        println!(
            "{{{header},\"case\":\"{case}\",\"seconds\":{seconds},\"runs\":3,\"cpuPercent\":{cpu:.2},\"maximumCpuPercent\":{maximum},\"xpcServicesCpuPercent\":{xpc:.2},\"bitsPerSecond\":{bits:.0},\"pass\":{pass}}}"
        );
    }
    if failed {
        return Err("below acceptance".into());
    }
    Ok(())
}

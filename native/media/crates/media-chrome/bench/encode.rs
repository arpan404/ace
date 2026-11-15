// SPDX-License-Identifier: Apache-2.0
//! `cargo run --release -p media-chrome --example encode -- [--size 1920x1080] [--fps 30]
//! [--seconds 10] [--input jpeg|rgba] [--bitrate 6000000] [--chrome PATH]`
//!
//! Feeds a paced stream of pictures (a real screenshot scrolling, JPEG q80 like a page's
//! screencast, or raw RGBA) to the Chrome encoder and reports frames out, latency, and the CPU
//! the browser's process tree and this process used, as a share of one core (CPU on Unix only).

use media_chrome::{ChromeEncoder, ChromeOptions, ChromeSearch, find_chrome, jpeg_picture};
use media_codec::{
    Codec, CodecError, CpuJpegCodec, CpuPicture, CpuScaler, EncodeSpec, Encoder, Picture,
    PixelFormat, Plane, RateControl, Scaler, Size,
};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::time::{Duration, Instant};

const STILL: &[u8] = include_bytes!("../../media-codec/bench/data/still-1206x2622.jpg");

struct Args {
    size: Size,
    fps: u32,
    seconds: u64,
    jpeg: bool,
    bitrate: u32,
    chrome: Option<PathBuf>,
}

fn args() -> Result<Args, String> {
    let mut out = Args {
        size: Size {
            width: 1920,
            height: 1080,
        },
        fps: 30,
        seconds: 10,
        jpeg: true,
        bitrate: 6_000_000,
        chrome: None,
    };
    let mut iter = std::env::args().skip(1);
    while let Some(flag) = iter.next() {
        let value = iter.next().ok_or(format!("{flag} needs a value"))?;
        let bad = |_| format!("bad {flag}");
        match flag.as_str() {
            "--size" => {
                let (w, h) = value.split_once('x').ok_or("size is WxH")?;
                out.size = Size {
                    width: w.parse().map_err(bad)?,
                    height: h.parse().map_err(bad)?,
                };
            }
            "--fps" => out.fps = value.parse().map_err(bad)?,
            "--seconds" => out.seconds = value.parse().map_err(bad)?,
            "--bitrate" => out.bitrate = value.parse().map_err(bad)?,
            "--input" => out.jpeg = value == "jpeg",
            "--chrome" => out.chrome = Some(value.into()),
            _ => return Err(format!("unknown flag {flag}")),
        }
    }
    Ok(out)
}

/// Pictures of the screenshot scrolling down, at the encode size.
fn frames(size: Size, count: usize) -> Result<Vec<CpuPicture>, CodecError> {
    let mut codec = CpuJpegCodec::default();
    let still = codec.decode(STILL)?;
    let tall = still.size().height * size.width / still.size().width;
    let Picture::Cpu(scaled) =
        CpuScaler::default().scale(&Picture::Cpu(still), size.width, tall.max(size.height))?
    else {
        return Err(CodecError::Unsupported("scaler returned a surface".into()));
    };
    let source = &scaled.planes()[0];
    let bytes = match scaled.format() {
        PixelFormat::Rgb8 => 3,
        _ => 4,
    };
    let spare = (scaled.size().height - size.height) as usize;
    let stride = size.width as usize * 4;
    (0..count)
        .map(|index| {
            let top = (index * 12) % spare.max(1);
            let mut data = Vec::with_capacity(stride * size.height as usize);
            for row in source
                .data
                .chunks(source.stride)
                .skip(top)
                .take(size.height as usize)
            {
                for pixel in row[..size.width as usize * bytes].chunks_exact(bytes) {
                    data.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 255]);
                }
            }
            CpuPicture::new(size, PixelFormat::Rgba8, [Plane { data, stride }], 0)
        })
        .collect()
}

/// CPU seconds used so far by `root` and its descendants, from `ps`.
fn tree_cpu(root: u32) -> f64 {
    let Ok(output) = std::process::Command::new("ps")
        .args(["-A", "-o", "pid=,ppid=,time="])
        .output()
    else {
        return 0.0;
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let rows: Vec<(u32, u32, f64)> = text
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse().ok()?;
            let ppid = fields.next()?.parse().ok()?;
            Some((pid, ppid, cpu_seconds(fields.next()?)))
        })
        .collect();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, ppid, _) in &rows {
        children.entry(*ppid).or_default().push(*pid);
    }
    let times: HashMap<u32, f64> = rows.iter().map(|(pid, _, t)| (*pid, *t)).collect();
    let mut total = 0.0;
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        total += times.get(&pid).copied().unwrap_or(0.0);
        stack.extend(children.get(&pid).into_iter().flatten());
    }
    total
}

/// `[[hh:]mm:]ss.cc` (or `d-hh:mm:ss`) as seconds.
fn cpu_seconds(field: &str) -> f64 {
    let (days, rest) = field.split_once('-').unwrap_or(("0", field));
    let mut seconds = days.parse::<f64>().unwrap_or(0.0) * 86_400.0;
    let parts: Vec<f64> = rest.split(':').map(|p| p.parse().unwrap_or(0.0)).collect();
    for (index, part) in parts.iter().rev().enumerate() {
        seconds += part * 60f64.powi(index as i32);
    }
    seconds
}

fn percentile(sorted: &[Duration], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let index = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[index].as_secs_f64() * 1000.0
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = args()?;
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    let data_dir = home.map(|home| PathBuf::from(home).join(".ace"));
    let chrome = match args.chrome.clone() {
        Some(path) => path,
        None => find_chrome(&ChromeSearch::from_env(data_dir)).ok_or("no Chrome found")?,
    };
    let pictures = frames(args.size, 60)?;
    let mut codec = CpuJpegCodec::default();
    let jpegs: Vec<Vec<u8>> = if args.jpeg {
        pictures
            .iter()
            .map(|p| codec.encode(p, 80))
            .collect::<Result<_, _>>()?
    } else {
        Vec::new()
    };
    let profiles = std::env::temp_dir().join(format!("media-chrome-bench-{}", std::process::id()));
    let mut encoder = ChromeEncoder::new(ChromeOptions::new(chrome.clone(), profiles.clone()));
    let started = Instant::now();
    encoder.configure(&EncodeSpec {
        codec: Codec::H264,
        size: args.size,
        fps: args.fps,
        rate: RateControl::Bitrate(args.bitrate),
    })?;
    let startup = started.elapsed();
    let browser = encoder.browser_pid().ok_or("no browser")?;
    let interval = Duration::from_secs_f64(1.0 / f64::from(args.fps));
    let me = std::process::id();
    let run = |encoder: &mut ChromeEncoder, frames: u64, measure: bool| -> Result<_, CodecError> {
        let (mut sent, mut refused, mut out, mut bytes) = (0u64, 0u64, 0u64, 0u64);
        let mut latencies = Vec::new();
        let mut submitted: VecDeque<(u64, Instant)> = VecDeque::new();
        let begin = Instant::now();
        for index in 0..frames {
            let due = begin + interval * index as u32;
            // Collect units while waiting, so latency is not rounded up to a frame interval.
            loop {
                while let Some(unit) = encoder.poll_result()? {
                    out += 1;
                    bytes += unit.data.len() as u64;
                    while let Some((pts, at)) = submitted.pop_front() {
                        if pts == unit.pts_us {
                            if measure {
                                latencies.push(at.elapsed());
                            }
                            break;
                        }
                    }
                }
                match due.checked_duration_since(Instant::now()) {
                    Some(wait) => std::thread::sleep(wait.min(Duration::from_millis(1))),
                    None => break,
                }
            }
            let pts = index * 1_000_000 / u64::from(args.fps);
            let slot = index as usize % 60;
            let picture = if args.jpeg {
                jpeg_picture(jpegs[slot].clone(), pts)?
            } else {
                let mut picture = pictures[slot].clone();
                picture.pts_us = pts;
                Picture::Cpu(picture)
            };
            match encoder.encode(picture, false) {
                Ok(()) => {
                    sent += 1;
                    submitted.push_back((pts, Instant::now()));
                }
                Err(CodecError::Backpressure) => refused += 1,
                Err(error) => return Err(error),
            }
        }
        encoder.flush()?;
        while let Some(unit) = encoder.poll_result()? {
            out += 1;
            bytes += unit.data.len() as u64;
        }
        Ok((sent, refused, out, bytes, latencies, begin.elapsed()))
    };
    // Warm-up, then the measured run.
    run(&mut encoder, u64::from(args.fps) * 2, false)?;
    let (chrome_before, me_before) = (tree_cpu(browser), tree_cpu(me) - tree_cpu(browser));
    let (sent, refused, out, bytes, mut latencies, wall) =
        run(&mut encoder, u64::from(args.fps) * args.seconds, true)?;
    let (chrome_after, me_after) = (tree_cpu(browser), tree_cpu(me) - tree_cpu(browser));
    latencies.sort();
    let wall = wall.as_secs_f64();
    println!(
        "chrome {}\ninput {} {}x{} @ {} fps, {} s, bitrate {}",
        chrome.display(),
        if args.jpeg { "jpeg q80" } else { "rgba" },
        args.size.width,
        args.size.height,
        args.fps,
        args.seconds,
        args.bitrate
    );
    println!(
        "startup to configured {:.0} ms",
        startup.as_secs_f64() * 1000.0
    );
    println!(
        "sent {sent}, refused (backpressure) {refused}, units out {out}, {:.1} fps out, {:.2} Mbit/s",
        out as f64 / wall,
        bytes as f64 * 8.0 / wall / 1e6
    );
    println!(
        "latency encode->unit p50 {:.1} ms, p95 {:.1} ms",
        percentile(&latencies, 0.5),
        percentile(&latencies, 0.95)
    );
    if cfg!(unix) {
        println!(
            "cpu chrome tree {:.1} % of a core, this process {:.1} %",
            (chrome_after - chrome_before) / wall * 100.0,
            (me_after - me_before) / wall * 100.0
        );
    } else {
        println!("cpu not measured here (the bench reads `ps`)");
    }
    drop(encoder);
    let _ = std::fs::remove_dir_all(profiles);
    Ok(())
}

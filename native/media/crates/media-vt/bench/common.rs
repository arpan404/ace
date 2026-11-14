// SPDX-License-Identifier: Apache-2.0
//! Bench plumbing: load average, process CPU time, frame sources, JSON lines.
#![allow(unsafe_code, dead_code)]
use media_codec::*;
use media_vt::{PixelPool, VtFormat, VtSurface};
use std::time::Duration;

#[repr(C)]
#[derive(Default)]
struct TimeVal {
    sec: i64,
    usec: i32,
}
#[repr(C)]
#[derive(Default)]
struct RUsage {
    user: TimeVal,
    system: TimeVal,
    rest: [i64; 14],
}
unsafe extern "C" {
    fn getrusage(who: i32, usage: *mut RUsage) -> i32;
    fn getloadavg(loads: *mut f64, count: i32) -> i32;
}

/// User + system CPU time of this process, all threads.
pub fn cpu_time() -> Duration {
    let mut usage = RUsage::default();
    // SAFETY: RUSAGE_SELF (0) fills the caller's struct, sized as on Darwin.
    unsafe { getrusage(0, &mut usage) };
    let part = |t: &TimeVal| Duration::new(t.sec as u64, t.usec as u32 * 1_000);
    part(&usage.user) + part(&usage.system)
}

pub fn load_average() -> f64 {
    let mut loads = [0f64; 3];
    // SAFETY: Writes at most three doubles into the array.
    unsafe { getloadavg(loads.as_mut_ptr(), 3) };
    loads[0]
}

pub fn cores() -> usize {
    std::thread::available_parallelism().map_or(1, |n| n.get())
}

/// The plan's rule: report only when asked to, or when load > 2 × cores.
pub fn enforce(load: f64) -> bool {
    std::env::var_os("ACE_MEDIA_BENCH_REPORT_ONLY").is_none() && load <= 2.0 * cores() as f64
}

pub fn os_build() -> String {
    std::process::Command::new("sw_vers")
        .arg("-buildVersion")
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map_or_else(|| "unknown".into(), |s| s.trim().to_owned())
}

pub fn machine() -> String {
    std::process::Command::new("sysctl")
        .args(["-n", "hw.model", "machdep.cpu.brand_string"])
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map_or_else(|| "unknown".into(), |s| s.trim().replace('\n', ", "))
}

/// Summed CPU seconds of every VideoToolbox XPC service process (all clients),
/// since hardware sessions do part of their work there, outside this process.
pub fn xpc_cpu_seconds() -> f64 {
    let Ok(out) = std::process::Command::new("ps")
        .args(["-A", "-o", "time=,comm="])
        .output()
    else {
        return 0.0;
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|line| line.contains("VTEncoderXPCService") || line.contains("VTDecoderXPCService"))
        .filter_map(|line| line.split_whitespace().next().and_then(parse_ps_time))
        .sum()
}

fn parse_ps_time(text: &str) -> Option<f64> {
    let mut seconds = 0.0;
    for part in text.split(':') {
        seconds = seconds * 60.0 + part.parse::<f64>().ok()?;
    }
    Some(seconds)
}

/// `count` distinct NV12 IOSurface frames of a scrolling pattern, filled once.
pub struct Frames {
    _pool: PixelPool,
    surfaces: Vec<VtSurface>,
}
impl Frames {
    pub fn new(size: Size, count: u32) -> Result<Self, CodecError> {
        let pool = PixelPool::new(size, VtFormat::Nv12, count as usize)?;
        let mut surfaces = Vec::new();
        for frame in 0..count {
            let picture = pool.upload(&pattern(size, frame)?)?;
            let surface = VtSurface::of(&picture)
                .ok_or(CodecError::NotConfigured)?
                .share();
            surfaces.push(surface);
        }
        Ok(Self {
            _pool: pool,
            surfaces,
        })
    }
    pub fn picture(&self, index: u64, pts_us: u64) -> Result<Picture, CodecError> {
        self.surfaces[index as usize % self.surfaces.len()]
            .share()
            .into_picture(pts_us)
    }
}

fn pattern(size: Size, frame: u32) -> Result<CpuPicture, CodecError> {
    let (w, h) = (size.width as usize, size.height as usize);
    let shift = frame as usize * 8;
    let mut luma = vec![0u8; w * h];
    for y in 0..h {
        for x in 0..w {
            // Text-like stripes that scroll vertically, over a ramp.
            let line = (y + shift) % 24;
            let glyph = line < 12 && !(x / 6 + (y + shift) / 24).is_multiple_of(5) && x % 6 < 4;
            let ramp = (x + y) * 60 / (w + h);
            luma[y * w + x] = if glyph { 40 } else { (170 + ramp) as u8 };
        }
    }
    let chroma = vec![128u8; w * h / 2];
    CpuPicture::new(
        size,
        PixelFormat::Nv12,
        [
            Plane {
                data: luma,
                stride: w,
            },
            Plane {
                data: chroma,
                stride: w,
            },
        ],
        0,
    )
}

pub fn percentile(samples: &mut [f64], p: f64) -> f64 {
    samples.sort_by(f64::total_cmp);
    let index = ((samples.len() as f64 - 1.0) * p).round() as usize;
    samples.get(index).copied().unwrap_or(0.0)
}

pub fn median(values: &mut [f64]) -> f64 {
    percentile(values, 0.5)
}

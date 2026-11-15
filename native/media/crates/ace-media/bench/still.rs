// SPDX-License-Identifier: Apache-2.0
//! `still --path {gpu,cpu}` (docs/media/plan.md, "Acceleration acceptance"): stills of the
//! current picture of a 1206 × 2622 screen into the 1568 px box, through ace-media's still
//! threads as the binary runs them (job in, JPEG out).
//!
//! - `gpu`: an HEVC stream from VideoToolbox; each still continues the group by one new delta
//!   (the steady state of an agent taking stills of a moving screen), so it decodes one unit,
//!   scales with the decoder and encodes the JPEG. Also reported: the first still of a group
//!   (keyframe, session open). Target: p95 ≤ 8 ms on the Mac.
//! - `cpu`: M5's path from a JPEG source. Target: p95 ≤ 20 ms on the Mac.
//!
//! A warm-up of 20 stills, then 3 runs of 200; the p95 is over all 600. Latency is enforced
//! unless the load average is above 2 × cores or `ACE_MEDIA_BENCH_REPORT_ONLY` is set; a still
//! that took a slower path than its machine's expected one always fails.
// The bench needs unix (load average, the still threads); elsewhere it builds to nothing.
#![cfg_attr(not(unix), allow(unused))]
#[cfg(target_os = "macos")]
#[path = "../tests/support/probed.rs"]
mod probed;
#[path = "screen.rs"]
mod screen;

#[cfg(unix)]
use ace_media::engine::stills::{StillInput, StillJob, StillOutcome};
#[cfg(unix)]
use ace_media::stills::{BackendFactory, StillThreads};
use media_codec::*;
use media_wire::control::Id;
use std::sync::Arc;
use std::sync::mpsc;
use std::time::Instant;

type Fallible<T> = Result<T, Box<dyn std::error::Error>>;

const SOURCE: Size = Size {
    width: 1206,
    height: 2622,
};
const WARM_UP: usize = 20;
const RUNS: usize = 3;
const SAMPLES: usize = 200;

#[cfg(unix)]
fn load_average() -> f64 {
    let mut loads = [0f64; 3];
    // SAFETY: Writes at most three doubles into the array.
    #[allow(unsafe_code)]
    let n = unsafe { libc::getloadavg(loads.as_mut_ptr(), 3) };
    if n < 1 { 0.0 } else { loads[0] }
}

fn cores() -> usize {
    std::thread::available_parallelism().map_or(1, |n| n.get())
}

fn percentile(values: &mut [f64], p: f64) -> f64 {
    values.sort_by(f64::total_cmp);
    let index = ((values.len() as f64 * p).ceil() as usize).clamp(1, values.len()) - 1;
    values[index]
}

#[cfg(unix)]
struct Bench {
    threads: StillThreads,
    results: mpsc::Receiver<StillOutcome>,
    started: Instant,
}

#[cfg(unix)]
impl Bench {
    fn new(factory: BackendFactory) -> Fallible<Self> {
        let (tx, results) = mpsc::channel();
        let started = Instant::now();
        let threads = StillThreads::new(
            1,
            factory,
            Arc::new(move || started.elapsed().as_micros() as u64),
            Arc::new(move |outcome| {
                let _ = tx.send(outcome);
            }),
        )?;
        Ok(Self {
            threads,
            results,
            started,
        })
    }

    /// One still, timed from the job leaving the engine to its JPEG arriving.
    fn still(
        &mut self,
        input: StillInput,
        target: Size,
    ) -> Fallible<(f64, ace_media::engine::stills::Made)> {
        use ace_media::engine::stills::StillMaker;
        let job = StillJob {
            request: Id::new("bench".to_owned())?,
            token: 1,
            stream: 1,
            input,
            target,
            quality: 80,
            deadline_us: self.started.elapsed().as_micros() as u64 + 5_000_000,
        };
        let at = Instant::now();
        self.threads.take(job).map_err(|_| "queue full")?;
        let outcome = self.results.recv()?;
        let ms = at.elapsed().as_secs_f64() * 1e3;
        Ok((ms, outcome.result?))
    }
}

#[cfg(target_os = "macos")]
fn gpu() -> Fallible<(Vec<f64>, Option<f64>, ace_media::engine::stills::Made, bool)> {
    use ace_media::engine::stills::StillUnit;
    use ace_media::stills::vt::{VtOptions, VtStills};
    use media_vt::VtEncoder;
    use media_wire::control::{Step, TrialState};

    let probed = probed::probed();
    let hardware = |step| {
        probed
            .iter()
            .any(|c| c.step == step && c.state == TrialState::Ok && c.hardware)
    };
    let options = VtOptions {
        jpeg_encode: hardware(Step::JpegEncode),
        jpeg_decode: hardware(Step::JpegDecode),
    };
    let expected_hardware = hardware(Step::Decode) && options.jpeg_encode;
    let mut encoder = VtEncoder::new();
    encoder.configure(&EncodeSpec {
        codec: Codec::Hevc,
        size: SOURCE,
        fps: 60,
        rate: RateControl::Bitrate(12_000_000),
    })?;
    let screens: Vec<CpuPicture> = (0..8).map(|f| screen::screen(SOURCE, f)).collect();
    let total = WARM_UP + RUNS * SAMPLES + 1;
    let mut units = Vec::with_capacity(total);
    for frame in 0..total {
        loop {
            let picture = Picture::Cpu(screens[frame % screens.len()].clone());
            match encoder.encode(picture, frame == 0) {
                Err(CodecError::Backpressure) => {
                    while let Some(unit) = encoder.poll_result()? {
                        units.push(unit);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
                other => {
                    other?;
                    break;
                }
            }
        }
        while let Some(unit) = encoder.poll_result()? {
            units.push(unit);
        }
    }
    encoder.flush()?;
    while let Some(unit) = encoder.poll_result()? {
        units.push(unit);
    }
    let units: Vec<StillUnit> = units
        .into_iter()
        .map(|u| StillUnit {
            codec: if u.format == BitstreamFormat::AnnexB {
                3
            } else {
                4
            },
            key: u.key,
            size: SOURCE,
            description: u.description.unwrap_or_default(),
            payload: u.data,
        })
        .collect();
    let target = fit_size(
        SOURCE,
        Size {
            width: 1568,
            height: 1568,
        },
    )?;
    let factory: BackendFactory = Arc::new(move || Box::new(VtStills::new(options)));
    let mut bench = Bench::new(factory)?;
    let mut units = units.into_iter();
    let key = units.next().ok_or("no keyframe")?;
    let keyframe_payload = (key.payload.clone(), key.description.clone());
    let video = |group, units| StillInput::Video {
        group,
        size: SOURCE,
        units,
    };
    let mut made = bench.still(video(1, vec![key]), target)?.1;
    let mut times = Vec::new();
    for (index, unit) in units.enumerate() {
        let (ms, still) = bench.still(video(1, vec![unit]), target)?;
        made = still;
        if index >= WARM_UP {
            times.push(ms);
        }
    }
    // The first still of a group: the keyframe and a new decoder session.
    let mut firsts = Vec::new();
    for group in 2..22 {
        let key = StillUnit {
            codec: 4,
            key: true,
            size: SOURCE,
            description: keyframe_payload.1.clone(),
            payload: keyframe_payload.0.clone(),
        };
        firsts.push(bench.still(video(group, vec![key]), target)?.0);
    }
    let first = Some(percentile(&mut firsts, 0.5));
    Ok((times, first, made, expected_hardware))
}

#[cfg(unix)]
fn cpu() -> Fallible<(Vec<f64>, Option<f64>, ace_media::engine::stills::Made, bool)> {
    use ace_media::stills::cpu::CpuStills;
    let jpeg: Arc<[u8]> = Arc::from(StillCodec::encode(
        &mut CpuJpegCodec::default(),
        &screen::screen(SOURCE, 0),
        90,
    )?);
    let target = fit_size(
        SOURCE,
        Size {
            width: 1568,
            height: 1568,
        },
    )?;
    let factory: BackendFactory = Arc::new(|| Box::<CpuStills>::default());
    let mut bench = Bench::new(factory)?;
    let mut times = Vec::new();
    let mut made = None;
    for index in 0..WARM_UP + RUNS * SAMPLES {
        let input = StillInput::Jpeg {
            data: jpeg.clone(),
            size: SOURCE,
        };
        let (ms, still) = bench.still(input, target)?;
        made = Some(still);
        if index >= WARM_UP {
            times.push(ms);
        }
    }
    Ok((times, None, made.ok_or("no still")?, false))
}

#[cfg(unix)]
fn main() -> Fallible<()> {
    let args: Vec<String> = std::env::args().collect();
    let path = args
        .iter()
        .position(|a| a == "--path")
        .and_then(|i| args.get(i + 1))
        .map_or("gpu", String::as_str);
    let load = load_average();
    let (mut times, first, made, expected_hardware, maximum) = match path {
        #[cfg(target_os = "macos")]
        "gpu" => {
            let (t, f, m, h) = gpu()?;
            (t, f, m, h, 8.0)
        }
        "cpu" => {
            let (t, f, m, h) = cpu()?;
            (t, f, m, h, 20.0)
        }
        other => return Err(format!("no {other} path on this platform").into()),
    };
    let steps: Vec<String> = made
        .steps
        .iter()
        .map(|s| {
            format!(
                "{{\"step\":{},\"backend\":{},\"hardware\":{},\"readbacks\":{},\"uploads\":{}}}",
                serde_json::to_string(&s.step).unwrap_or_default(),
                serde_json::to_string(&s.backend).unwrap_or_default(),
                s.hardware,
                s.readbacks,
                s.uploads
            )
        })
        .collect();
    // The expected path: all hardware with no copies where the probe found hardware decode
    // and JPEG encode; on the CPU path, all CPU with no copies.
    let path_ok = if path == "cpu" {
        made.steps
            .iter()
            .all(|s| !s.hardware && s.readbacks == 0 && s.uploads == 0)
    } else {
        !expected_hardware
            || made
                .steps
                .iter()
                .all(|s| s.hardware && s.readbacks == 0 && s.uploads == 0)
    };
    let samples = times.len();
    let median = percentile(&mut times, 0.5);
    let p95 = percentile(&mut times, 0.95);
    let enforced =
        std::env::var_os("ACE_MEDIA_BENCH_REPORT_ONLY").is_none() && load <= 2.0 * cores() as f64;
    let latency_ok = p95 <= maximum;
    println!(
        "{{\"bench\":\"still\",\"path\":\"{path}\",\"load\":{load:.2},\"cores\":{},\"enforced\":{enforced},\"source\":\"{}x{}\",\"target\":\"{}x{}\",\"samples\":{samples},\"medianMs\":{median:.3},\"p95Ms\":{p95:.3},\"firstOfGroupMedianMs\":{},\"maximumP95Ms\":{maximum},\"bytes\":{},\"steps\":[{}],\"pathOk\":{path_ok},\"pass\":{}}}",
        cores(),
        SOURCE.width,
        SOURCE.height,
        made.size.width,
        made.size.height,
        first.map_or("null".to_owned(), |f| format!("{f:.3}")),
        made.jpeg.len(),
        steps.join(","),
        path_ok && latency_ok,
    );
    if !path_ok && std::env::var_os("ACE_MEDIA_BENCH_REPORT_ONLY").is_none() {
        return Err("the still ran below its expected path or made extra copies".into());
    }
    if enforced && !latency_ok {
        return Err("below acceptance".into());
    }
    Ok(())
}

#[cfg(not(unix))]
fn main() {}

// SPDX-License-Identifier: Apache-2.0
//! The still maker (docs/media/plan.md, F2; ADR 0148 §6): a fixed set of threads, never the
//! tokio threads, each with one [`StillBackend`].
//!
//! - **Order.** A source's jobs always go to the same thread, in order, because each continues
//!   the decoder state the one before left.
//! - **Paths.** On the GPU where the probe found it: VideoToolbox decodes at the still's size
//!   and encodes the JPEG where its session is hardware ([`vt`]). Everything else is M5's CPU
//!   path ([`cpu`]): JPEG decode, SIMD scale and JPEG encode. Every still reports the steps it
//!   ran, with its picture-sized copies.
//! - **Deadlines.** A job's units are always decoded, so the decoder stays in step, but a job
//!   past its deadline is not encoded.
//! - **The poster** ([`poster`]) is a viewport-sized still of 10–20 KB for a subscribe reply.
pub mod cpu;
pub mod poster;
#[cfg(target_os = "macos")]
pub mod vt;

use crate::engine::stills::{Made, StillInput, StillJob, StillMaker, StillOutcome, StillUnit};
use media_codec::{BitstreamFormat, Codec, EncodedUnit, Size};
use media_wire::control::{Backend, Capability, SourceStep, Step, TrialState};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Sender};

/// One thread's way of making stills.
pub trait StillBackend: Send {
    /// Decodes `input` (continuing `stream`'s decoder for video) and scales it to `target`,
    /// keeping the picture for [`encode`](Self::encode). The steps so far.
    fn prepare(
        &mut self,
        stream: u32,
        input: StillInput,
        target: Size,
    ) -> Result<Vec<SourceStep>, String>;
    /// JPEG-encodes the prepared picture into `out`. The encode step.
    fn encode(&mut self, quality: u8, out: &mut Vec<u8>) -> Result<SourceStep, String>;
    /// JPEG-encodes the prepared picture for a poster, whose size is searched by quality. A
    /// backend whose hardware encoder can't reach the poster's sizes overrides this.
    fn encode_poster(&mut self, quality: u8, out: &mut Vec<u8>) -> Result<SourceStep, String> {
        self.encode(quality, out)
    }
    /// The stream closed.
    fn forget(&mut self, stream: u32);
}

pub type BackendFactory = Arc<dyn Fn() -> Box<dyn StillBackend> + Send + Sync>;
/// ace-media's monotonic clock in µs, the one job deadlines are on.
pub type StillClock = Arc<dyn Fn() -> u64 + Send + Sync>;
pub type Deliver = Arc<dyn Fn(StillOutcome) + Send + Sync>;

/// Jobs queued per thread before `take` refuses one.
pub const QUEUE: usize = 4;

enum Work {
    Job(StillJob),
    Forget(u32),
    /// The probe's findings changed the path: replace the backend between jobs. Its decoders
    /// go with it, so a group in progress continues only from its next keyframe.
    Backend(BackendFactory),
}

struct Worker {
    tx: Sender<Work>,
    queued: Arc<AtomicUsize>,
}

pub struct StillThreads {
    workers: Vec<Worker>,
    /// The path chosen from the probe, when the threads follow it.
    choice: Option<Choice>,
}

/// One thread per core but one, at least 1, at most 8.
pub fn thread_count(cores: usize) -> usize {
    cores.saturating_sub(1).clamp(1, 8)
}

impl StillThreads {
    pub fn new(
        threads: usize,
        factory: BackendFactory,
        clock: StillClock,
        deliver: Deliver,
    ) -> std::io::Result<Self> {
        let mut workers = Vec::with_capacity(threads.max(1));
        for index in 0..threads.max(1) {
            let (tx, rx) = mpsc::channel::<Work>();
            let queued = Arc::new(AtomicUsize::new(0));
            let (factory, clock, deliver, count) = (
                factory.clone(),
                clock.clone(),
                deliver.clone(),
                queued.clone(),
            );
            std::thread::Builder::new()
                .name(format!("media-still-{index}"))
                .spawn(move || {
                    let mut backend = factory();
                    while let Ok(work) = rx.recv() {
                        match work {
                            Work::Forget(stream) => backend.forget(stream),
                            Work::Backend(factory) => backend = factory(),
                            Work::Job(job) => {
                                count.fetch_sub(1, Ordering::AcqRel);
                                deliver(make(backend.as_mut(), job, clock.as_ref()));
                            }
                        }
                    }
                })?;
            workers.push(Worker { tx, queued });
        }
        Ok(Self {
            workers,
            choice: None,
        })
    }

    /// Threads on the path the probe's `capabilities` choose, following later changes.
    pub fn probed(
        threads: usize,
        capabilities: &[Capability],
        clock: StillClock,
        deliver: Deliver,
    ) -> std::io::Result<Self> {
        let choice = Choice::of(capabilities);
        let mut made = Self::new(threads, choice.factory(), clock, deliver)?;
        made.choice = Some(choice);
        Ok(made)
    }

    fn worker(&self, stream: u32) -> &Worker {
        &self.workers[stream as usize % self.workers.len()]
    }
}

impl StillMaker for StillThreads {
    fn take(&mut self, job: StillJob) -> Result<(), StillJob> {
        let worker = self.worker(job.stream);
        if worker.queued.fetch_add(1, Ordering::AcqRel) >= QUEUE {
            worker.queued.fetch_sub(1, Ordering::AcqRel);
            return Err(job);
        }
        worker.tx.send(Work::Job(job)).map_err(|e| {
            worker.queued.fetch_sub(1, Ordering::AcqRel);
            match e.0 {
                Work::Job(job) => job,
                Work::Forget(_) | Work::Backend(_) => unreachable!(),
            }
        })
    }

    fn forget(&mut self, stream: u32) {
        let _ = self.worker(stream).tx.send(Work::Forget(stream));
    }

    fn capabilities(&mut self, capabilities: &[Capability]) {
        let Some(current) = self.choice else {
            return;
        };
        let choice = Choice::of(capabilities);
        if choice == current {
            return;
        }
        self.choice = Some(choice);
        for worker in &self.workers {
            let _ = worker.tx.send(Work::Backend(choice.factory()));
        }
    }
}

/// The still path for what the probe found: VideoToolbox where its decode or JPEG trials
/// passed, else the CPU path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Choice {
    Cpu,
    #[cfg(target_os = "macos")]
    Vt(vt::VtOptions),
}

impl Choice {
    pub fn of(capabilities: &[Capability]) -> Self {
        let found = |step: Step, backend: Backend, hardware: bool| {
            capabilities.iter().any(|c| {
                c.step == step
                    && c.backend == backend
                    && c.state == TrialState::Ok
                    && (c.hardware || !hardware)
            })
        };
        #[cfg(target_os = "macos")]
        {
            let options = vt::VtOptions {
                jpeg_encode: found(Step::JpegEncode, Backend::Vt, true),
                jpeg_decode: found(Step::JpegDecode, Backend::Vt, true),
            };
            if found(Step::Decode, Backend::Vt, false) || options.jpeg_encode || options.jpeg_decode
            {
                return Self::Vt(options);
            }
        }
        let _ = found;
        Self::Cpu
    }

    pub fn factory(self) -> BackendFactory {
        match self {
            Self::Cpu => Arc::new(|| Box::<cpu::CpuStills>::default()),
            #[cfg(target_os = "macos")]
            Self::Vt(options) => Arc::new(move || Box::new(vt::VtStills::new(options))),
        }
    }
}

/// One job, start to end.
pub fn make(
    backend: &mut dyn StillBackend,
    job: StillJob,
    now_us: &dyn Fn() -> u64,
) -> StillOutcome {
    let StillJob {
        request,
        stream,
        input,
        target,
        quality,
        deadline_us,
    } = job;
    let result = backend
        .prepare(stream, input, target)
        .and_then(|mut steps| {
            if now_us() >= deadline_us {
                return Err("deadline".to_owned());
            }
            let mut jpeg = Vec::new();
            steps.push(backend.encode(quality, &mut jpeg)?);
            Ok(Made {
                jpeg,
                size: target,
                steps,
            })
        });
    StillOutcome { request, result }
}

/// A unit as a decoder takes it: length-prefixed, with its configuration record on keyframes.
pub fn encoded_unit(unit: &StillUnit, pts_us: u64) -> Result<EncodedUnit, String> {
    let made = crate::record::video::encoded(unit.codec, &unit.payload, &unit.description)
        .map_err(|_| "unsupported-codec".to_owned())?;
    let (codec, format) = match made.codec {
        media_mp4::VideoCodec::H264 => (Codec::H264, BitstreamFormat::Avcc),
        media_mp4::VideoCodec::Hevc => (Codec::Hevc, BitstreamFormat::Hvcc),
    };
    Ok(EncodedUnit {
        codec,
        size: unit.size,
        format,
        data: made.data,
        key: unit.key,
        description: made.description,
        pts_us,
        duration_us: 0,
    })
}

// SPDX-License-Identifier: Apache-2.0
//! Bounded availability trials at start (docs/media/plan.md, "Probe at start"). Each backend
//! gives one [`Trial`]; trials run in parallel on threads of their own, each under
//! [`TRIAL_DEADLINE`], and `ready` comes within [`READY_DEADLINE`]. A trial publishes what it
//! has found so far as often as it learns more: the last list published by the deadline goes
//! into `ready` (a trial that published nothing is reported `timed-out`), and every later one
//! replaces its entries in `capabilities.changed` as soon as it is published. A trial still
//! running at the deadline is abandoned: nothing waits for it, and it closes its sessions when
//! it returns, or at its next step once [`Cancel`] is set (ace-media stopping). An entry whose
//! trial didn't succeed is never hardware, whatever the backend listed. The probe never ranks;
//! that is `rank`'s.
use media_codec::{CpuJpegCodec, CpuPicture, PixelFormat, Plane, Size, StillCodec};
use media_wire::capability::{Backend, Capability, Step, TrialState};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// How long one trial has, covering a cold driver start (CUDA or NVENC initialisation).
pub const TRIAL_DEADLINE: Duration = Duration::from_secs(2);
/// The most `ready` waits for the probe.
pub const READY_DEADLINE: Duration = Duration::from_secs(3);

/// Stops every trial still running at its next step.
#[derive(Clone, Debug, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
    /// The flag itself, for backends that take one (`media-chrome`).
    pub fn flag(&self) -> Arc<AtomicBool> {
        self.0.clone()
    }
}

/// One backend's availability trial.
pub trait Trial: Send + 'static {
    /// The steps it covers, as `(step, codec, backend)`: what to report when it times out.
    fn steps(&self) -> Vec<(Step, Option<String>, Backend)>;
    /// Opens a session and pushes one frame through each step, calling `publish` with every
    /// entry it covers each time it learns more. Returns, closing what it opened, once `stop`
    /// says so.
    fn run(self: Box<Self>, publish: &mut dyn FnMut(Vec<Capability>), stop: &dyn Fn() -> bool);
}

pub(crate) fn entries(
    steps: &[(Step, Option<String>, Backend)],
    state: TrialState,
) -> Vec<Capability> {
    steps
        .iter()
        .map(|(step, codec, backend)| Capability {
            step: *step,
            codec: codec.clone(),
            backend: *backend,
            hardware: false,
            zero_copy: false,
            state,
            max_width: 0,
            max_height: 0,
        })
        .collect()
}

/// A trial that didn't succeed found no hardware, and no size: a backend that lists a codec but
/// fails its trial frame is not a hardware path.
fn observed(found: Vec<Capability>) -> Vec<Capability> {
    found
        .into_iter()
        .map(|c| match c.state {
            TrialState::Ok => c,
            TrialState::Failed | TrialState::TimedOut => Capability {
                hardware: false,
                zero_copy: false,
                max_width: 0,
                max_height: 0,
                ..c
            },
        })
        .collect()
}

/// The capability list, slot by slot: one slot per trial, in trial order.
pub struct Capabilities {
    slots: Vec<Vec<Capability>>,
}

impl Capabilities {
    pub fn list(&self) -> Vec<Capability> {
        self.slots.iter().flatten().cloned().collect()
    }
    /// A slot for a trial started after `ready` (the last-resort encoder's): its index.
    pub fn add_slot(&mut self) -> usize {
        self.slots.push(Vec::new());
        self.slots.len() - 1
    }
    /// A late result replaces its trial's slot.
    pub fn update(&mut self, trial: usize, found: Vec<Capability>) {
        if let Some(slot) = self.slots.get_mut(trial) {
            *slot = observed(found);
        }
    }
}

enum Message {
    Published(usize, Vec<Capability>),
    Done,
}

/// Runs every trial, waiting at most `deadline` (at most [`READY_DEADLINE`]). Returns the list
/// for `ready` and a receiver of what trials publish after it, `(trial, entries)`, as they
/// publish it. `cancel` stops the trials still running.
pub fn probe(
    trials: Vec<Box<dyn Trial>>,
    deadline: Duration,
    cancel: &Cancel,
) -> (Capabilities, mpsc::Receiver<(usize, Vec<Capability>)>) {
    let (tx, rx) = mpsc::channel();
    let mut slots = Vec::with_capacity(trials.len());
    let mut running = 0;
    for (index, trial) in trials.into_iter().enumerate() {
        slots.push(entries(&trial.steps(), TrialState::TimedOut));
        let tx = tx.clone();
        let cancel = cancel.clone();
        let spawned = std::thread::Builder::new()
            .name(format!("probe-{index}"))
            .spawn(move || {
                let stop = || cancel.is_cancelled();
                trial.run(
                    &mut |found| {
                        let _ = tx.send(Message::Published(index, found));
                    },
                    &stop,
                );
                let _ = tx.send(Message::Done);
            });
        match spawned {
            Ok(_) => running += 1,
            Err(_) => slots[index] = Vec::new(),
        }
    }
    drop(tx);
    let end = Instant::now() + deadline.min(READY_DEADLINE);
    while running > 0 && !cancel.is_cancelled() {
        let left = end.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(Message::Published(index, found)) => slots[index] = observed(found),
            Ok(Message::Done) => running -= 1,
            Err(_) => break,
        }
    }
    let (late_tx, late) = mpsc::channel();
    if running > 0 {
        std::thread::spawn(move || {
            while let Ok(message) = rx.recv() {
                if let Message::Published(index, found) = message
                    && late_tx.send((index, found)).is_err()
                {
                    return;
                }
            }
        });
    }
    (Capabilities { slots }, late)
}

/// M5's CPU path: JPEG decode, scale and JPEG encode, available everywhere.
pub struct CpuTrial;

impl Trial for CpuTrial {
    fn steps(&self) -> Vec<(Step, Option<String>, Backend)> {
        vec![
            (Step::JpegDecode, Some("jpeg".into()), Backend::Cpu),
            (Step::JpegEncode, Some("jpeg".into()), Backend::Cpu),
            (Step::Scale, None, Backend::Cpu),
        ]
    }

    fn run(self: Box<Self>, publish: &mut dyn FnMut(Vec<Capability>), _stop: &dyn Fn() -> bool) {
        publish(self.trial());
    }
}

impl CpuTrial {
    fn trial(&self) -> Vec<Capability> {
        let steps = self.steps();
        let side = 16;
        let picture = CpuPicture::new(
            Size {
                width: side,
                height: side,
            },
            PixelFormat::Rgb8,
            [Plane {
                data: vec![128; (side * side * 3) as usize],
                stride: (side * 3) as usize,
            }],
            0,
        );
        let mut codec = CpuJpegCodec::default();
        let trial = picture.and_then(|picture| {
            let jpeg = StillCodec::encode(&mut codec, &picture, 80)?;
            let half = Size {
                width: side / 2,
                height: side / 2,
            };
            let scaled = StillCodec::transcode(&mut codec, &jpeg, half, 80)?;
            StillCodec::decode(&mut codec, &scaled).map(|p| p.size() == half)
        });
        let Ok(true) = trial else {
            return entries(&steps, TrialState::Failed);
        };
        let max = media_codec::MAX_DIMENSION;
        entries(&steps, TrialState::Ok)
            .into_iter()
            .map(|c| Capability {
                max_width: max,
                max_height: max,
                ..c
            })
            .collect()
    }
}

/// B1's VideoToolbox trial (its own deadline, cancellation and single shared worker). It
/// publishes what it found by its deadline, inside ace-media's, then the whole list again each
/// time VideoToolbox finishes another step.
#[cfg(target_os = "macos")]
pub struct VtTrial;

#[cfg(target_os = "macos")]
impl Trial for VtTrial {
    fn steps(&self) -> Vec<(Step, Option<String>, Backend)> {
        let codec = |c: &str| Some(c.to_owned());
        vec![
            (Step::Encode, codec("avc1"), Backend::Vt),
            (Step::Encode, codec("hvc1"), Backend::Vt),
            (Step::Decode, codec("avc1"), Backend::Vt),
            (Step::Decode, codec("hvc1"), Backend::Vt),
            (Step::JpegEncode, codec("jpeg"), Backend::Vt),
            (Step::JpegDecode, codec("jpeg"), Backend::Vt),
            (Step::Scale, None, Backend::Vt),
        ]
    }

    fn run(self: Box<Self>, publish: &mut dyn FnMut(Vec<Capability>), stop: &dyn Fn() -> bool) {
        let options = media_vt::ProbeOptions {
            deadline: TRIAL_DEADLINE.saturating_sub(Duration::from_millis(200)),
            ..Default::default()
        };
        if stop() {
            return;
        }
        let report = media_vt::probe(&options);
        let mut found = report.capabilities;
        publish(found.clone());
        let family = |c: &Capability| {
            let codec = c.codec.as_deref().unwrap_or("");
            (c.step, codec.get(..4).unwrap_or(codec).to_owned())
        };
        loop {
            if stop() {
                options.cancel.cancel();
                return;
            }
            let late = match report.late.recv_timeout(Duration::from_millis(100)) {
                Ok(late) => late,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            };
            let key = family(&late);
            match found.iter_mut().find(|c| family(c) == key) {
                Some(entry) => *entry = late,
                None => found.push(late),
            }
            publish(found.clone());
        }
    }
}

/// The trials this build runs: the platform's hardware backends first, then the CPU path.
pub fn trials() -> Vec<Box<dyn Trial>> {
    vec![
        #[cfg(target_os = "macos")]
        Box::new(VtTrial),
        #[cfg(target_os = "linux")]
        Box::new(linux::VaapiTrial),
        #[cfg(target_os = "linux")]
        Box::new(linux::NvTrial),
        Box::new(CpuTrial),
    ]
}

#[cfg(target_os = "linux")]
#[path = "probe_linux.rs"]
mod linux;

#[cfg(test)]
#[path = "probe_tests.rs"]
mod tests;

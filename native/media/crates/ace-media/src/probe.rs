// SPDX-License-Identifier: Apache-2.0
//! Bounded availability trials at start (docs/media/plan.md, "Probe at start"). Each backend
//! gives one [`Trial`]; trials run in parallel on threads of their own. `ready` waits for them
//! up to the trial deadline; a trial still running then is reported `timed-out`, its thread is
//! abandoned, and a late result replaces its entries in `capabilities.changed`. The probe
//! never ranks. Hardware backends (B1–B5) add their trials here; this binary has the CPU one.
use media_codec::{CpuJpegCodec, CpuPicture, PixelFormat, Plane, Size, StillCodec};
use media_wire::capability::{Backend, Capability, Step, TrialState};
use std::sync::mpsc;
use std::time::{Duration, Instant};

pub const TRIAL_DEADLINE: Duration = Duration::from_secs(2);

/// One backend's availability trial.
pub trait Trial: Send + 'static {
    /// The steps it covers, as `(step, codec, backend)`: what to report when it times out.
    fn steps(&self) -> Vec<(Step, Option<String>, Backend)>;
    /// Opens a session and pushes one frame through each step. The entries it found.
    fn run(self: Box<Self>) -> Vec<Capability>;
}

fn entries(steps: &[(Step, Option<String>, Backend)], state: TrialState) -> Vec<Capability> {
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

/// The capability list, slot by slot: one slot per trial, in trial order.
pub struct Capabilities {
    slots: Vec<Vec<Capability>>,
}

impl Capabilities {
    pub fn list(&self) -> Vec<Capability> {
        self.slots.iter().flatten().cloned().collect()
    }
    /// A late result replaces its trial's slot.
    pub fn update(&mut self, trial: usize, found: Vec<Capability>) {
        if let Some(slot) = self.slots.get_mut(trial) {
            *slot = found;
        }
    }
}

/// Runs every trial, waiting at most `deadline`. Returns the list for `ready` and a receiver
/// of late results `(trial, entries)`.
pub fn probe(
    trials: Vec<Box<dyn Trial>>,
    deadline: Duration,
) -> (Capabilities, mpsc::Receiver<(usize, Vec<Capability>)>) {
    let (tx, rx) = mpsc::channel();
    let mut slots = Vec::with_capacity(trials.len());
    for (index, trial) in trials.into_iter().enumerate() {
        slots.push(Some(entries(&trial.steps(), TrialState::TimedOut)));
        let tx = tx.clone();
        let spawned = std::thread::Builder::new()
            .name(format!("probe-{index}"))
            .spawn(move || {
                let _ = tx.send((index, trial.run()));
            });
        if spawned.is_err() {
            slots[index] = None;
        }
    }
    drop(tx);
    let mut pending = slots.iter().filter(|s| s.is_some()).count();
    let mut done: Vec<Option<Vec<Capability>>> = vec![None; slots.len()];
    let end = Instant::now() + deadline;
    while pending > 0 {
        let left = end.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok((index, found)) => {
                done[index] = Some(found);
                pending -= 1;
            }
            Err(_) => break,
        }
    }
    let slots = slots
        .into_iter()
        .zip(done)
        .map(|(timed_out, found)| found.or(timed_out).unwrap_or_default())
        .collect();
    (Capabilities { slots }, rx)
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

    fn run(self: Box<Self>) -> Vec<Capability> {
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

#[cfg(test)]
mod tests {
    use super::*;

    struct Scripted {
        delay: Duration,
        state: TrialState,
    }

    impl Trial for Scripted {
        fn steps(&self) -> Vec<(Step, Option<String>, Backend)> {
            vec![(Step::Encode, Some("avc1.640028".into()), Backend::Vt)]
        }
        fn run(self: Box<Self>) -> Vec<Capability> {
            std::thread::sleep(self.delay);
            entries(&self.steps(), self.state)
        }
    }

    fn scripted(ms: u64, state: TrialState) -> Box<dyn Trial> {
        Box::new(Scripted {
            delay: Duration::from_millis(ms),
            state,
        })
    }

    #[test]
    fn the_cpu_path_is_reported_available_without_claiming_hardware() {
        let (capabilities, _) = probe(vec![Box::new(CpuTrial)], TRIAL_DEADLINE);
        let list = capabilities.list();
        assert_eq!(list.len(), 3);
        for entry in list {
            assert_eq!(entry.state, TrialState::Ok);
            assert_eq!(entry.backend, Backend::Cpu);
            assert!(!entry.hardware && !entry.zero_copy);
            assert!(entry.max_width > 0);
            assert_eq!(entry.codec.is_none(), entry.step == Step::Scale);
        }
    }

    #[test]
    fn a_hung_trial_is_timed_out_at_the_deadline_and_its_late_result_replaces_it() {
        let started = Instant::now();
        let (mut capabilities, late) = probe(
            vec![
                scripted(0, TrialState::Failed),
                scripted(300, TrialState::Ok),
            ],
            Duration::from_millis(100),
        );
        assert!(started.elapsed() < Duration::from_millis(280));
        let states: Vec<_> = capabilities.list().iter().map(|c| c.state).collect();
        assert_eq!(states, [TrialState::Failed, TrialState::TimedOut]);
        let Ok((trial, found)) = late.recv_timeout(Duration::from_secs(2)) else {
            panic!("no late result");
        };
        capabilities.update(trial, found);
        let states: Vec<_> = capabilities.list().iter().map(|c| c.state).collect();
        assert_eq!(states, [TrialState::Failed, TrialState::Ok]);
    }
}

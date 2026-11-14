// SPDX-License-Identifier: Apache-2.0
//! Bounded availability trials at start (docs/media/plan.md, "Probe at start"). Each backend
//! gives one [`Trial`]; trials run in parallel on threads of their own. `ready` waits for them
//! up to the trial deadline. A trial publishes what it has found so far as often as it learns
//! more: the last list published by the deadline goes into `ready` (a trial that published
//! nothing is reported `timed-out`), and every later one replaces its entries in
//! `capabilities.changed` as soon as it is published. A trial still running at the deadline
//! is abandoned. The probe never ranks. Hardware backends (B1–B5) add their trials here.
use media_codec::{CpuJpegCodec, CpuPicture, PixelFormat, Plane, Size, StillCodec};
use media_wire::capability::{Backend, Capability, Step, TrialState};
use std::sync::mpsc;
use std::time::{Duration, Instant};

pub const TRIAL_DEADLINE: Duration = Duration::from_secs(2);

/// One backend's availability trial.
pub trait Trial: Send + 'static {
    /// The steps it covers, as `(step, codec, backend)`: what to report when it times out.
    fn steps(&self) -> Vec<(Step, Option<String>, Backend)>;
    /// Opens a session and pushes one frame through each step, calling `publish` with every
    /// entry it covers each time it learns more.
    fn run(self: Box<Self>, publish: &mut dyn FnMut(Vec<Capability>));
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
    /// A slot for a trial started after `ready` (the last-resort encoder's): its index.
    pub fn add_slot(&mut self) -> usize {
        self.slots.push(Vec::new());
        self.slots.len() - 1
    }
    /// A late result replaces its trial's slot.
    pub fn update(&mut self, trial: usize, found: Vec<Capability>) {
        if let Some(slot) = self.slots.get_mut(trial) {
            *slot = found;
        }
    }
}

enum Message {
    Published(usize, Vec<Capability>),
    Done,
}

/// Runs every trial, waiting at most `deadline`. Returns the list for `ready` and a receiver
/// of what trials publish after it, `(trial, entries)`, as they publish it.
pub fn probe(
    trials: Vec<Box<dyn Trial>>,
    deadline: Duration,
) -> (Capabilities, mpsc::Receiver<(usize, Vec<Capability>)>) {
    let (tx, rx) = mpsc::channel();
    let mut slots = Vec::with_capacity(trials.len());
    let mut running = 0;
    for (index, trial) in trials.into_iter().enumerate() {
        slots.push(entries(&trial.steps(), TrialState::TimedOut));
        let tx = tx.clone();
        let spawned = std::thread::Builder::new()
            .name(format!("probe-{index}"))
            .spawn(move || {
                trial.run(&mut |found| {
                    let _ = tx.send(Message::Published(index, found));
                });
                let _ = tx.send(Message::Done);
            });
        match spawned {
            Ok(_) => running += 1,
            Err(_) => slots[index] = Vec::new(),
        }
    }
    drop(tx);
    let end = Instant::now() + deadline;
    while running > 0 {
        let left = end.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(Message::Published(index, found)) => slots[index] = found,
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

    fn run(self: Box<Self>, publish: &mut dyn FnMut(Vec<Capability>)) {
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

    fn run(self: Box<Self>, publish: &mut dyn FnMut(Vec<Capability>)) {
        let options = media_vt::ProbeOptions {
            deadline: TRIAL_DEADLINE.saturating_sub(Duration::from_millis(200)),
            ..Default::default()
        };
        let report = media_vt::probe(&options);
        let mut found = report.capabilities;
        publish(found.clone());
        let family = |c: &Capability| {
            let codec = c.codec.as_deref().unwrap_or("");
            (c.step, codec.get(..4).unwrap_or(codec).to_owned())
        };
        while let Ok(late) = report.late.recv() {
            let key = family(&late);
            match found.iter_mut().find(|c| family(c) == key) {
                Some(entry) => *entry = late,
                None => found.push(late),
            }
            publish(found.clone());
        }
    }
}

/// The trials this build runs: the platform's hardware backend first, then the CPU path.
pub fn trials() -> Vec<Box<dyn Trial>> {
    vec![
        #[cfg(target_os = "macos")]
        Box::new(VtTrial),
        Box::new(CpuTrial),
    ]
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
        fn run(self: Box<Self>, publish: &mut dyn FnMut(Vec<Capability>)) {
            std::thread::sleep(self.delay);
            publish(entries(&self.steps(), self.state));
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

    /// Publishes a first answer at once, then more after `later`, then keeps running.
    struct Staged {
        later: Duration,
        release: mpsc::Receiver<()>,
    }

    impl Trial for Staged {
        fn steps(&self) -> Vec<(Step, Option<String>, Backend)> {
            vec![(Step::Decode, Some("hvc1".into()), Backend::Vt)]
        }
        fn run(self: Box<Self>, publish: &mut dyn FnMut(Vec<Capability>)) {
            publish(entries(&self.steps(), TrialState::TimedOut));
            std::thread::sleep(self.later);
            publish(entries(&self.steps(), TrialState::Ok));
            // Still running: the update must not wait for the trial to end.
            let _ = self.release.recv_timeout(Duration::from_secs(5));
        }
    }

    #[test]
    fn what_a_trial_publishes_after_the_deadline_arrives_while_it_is_still_running() {
        let (release, wait) = mpsc::channel();
        let staged = Staged {
            later: Duration::from_millis(150),
            release: wait,
        };
        let (mut capabilities, late) = probe(vec![Box::new(staged)], Duration::from_millis(50));
        let states: Vec<_> = capabilities.list().iter().map(|c| c.state).collect();
        assert_eq!(
            states,
            [TrialState::TimedOut],
            "the first answer is in ready"
        );
        let Ok((trial, found)) = late.recv_timeout(Duration::from_secs(2)) else {
            panic!("the later answer did not arrive while the trial ran");
        };
        capabilities.update(trial, found);
        let states: Vec<_> = capabilities.list().iter().map(|c| c.state).collect();
        assert_eq!(states, [TrialState::Ok]);
        let _ = release.send(());
    }
}

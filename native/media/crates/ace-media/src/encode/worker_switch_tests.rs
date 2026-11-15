// SPDX-License-Identifier: Apache-2.0
//! The move from the fallback onto a late hardware encoder is make-before-break: the hardware
//! encoder runs beside the fallback until its first keyframe, and the source never loses a
//! picture or ends because the hardware one didn't start.
use super::*;
use media_codec::EncoderCaps;
use std::sync::{Arc, Mutex};

const FALLBACK: u8 = 0xF0;
const HARDWARE: u8 = 0xA0;

#[derive(Default)]
struct Knobs {
    /// Units stay inside until `hold` is cleared.
    hold: bool,
    flush_fails: bool,
    fail_first_encode: bool,
    fail_first_poll: bool,
    /// The encoder produces nothing at all (slow to its first keyframe).
    silent: bool,
    encodes: usize,
}

type Shared = Arc<Mutex<Knobs>>;

/// FakeEncoder, with its payload tagged by who made it and the knobs above.
struct Scripted {
    inner: FakeEncoder,
    tag: u8,
    knobs: Shared,
    held: VecDeque<EncodedUnit>,
    polled: bool,
}

impl Scripted {
    fn knobs(&self) -> std::sync::MutexGuard<'_, Knobs> {
        match self.knobs.lock() {
            Ok(knobs) => knobs,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

impl Encoder for Scripted {
    fn configure(&mut self, spec: &Spec) -> Result<(), CodecError> {
        self.inner.configure(spec)
    }
    fn encode(&mut self, picture: Picture, force_key: bool) -> Result<(), CodecError> {
        let first = {
            let mut knobs = self.knobs();
            knobs.encodes += 1;
            knobs.encodes == 1 && knobs.fail_first_encode
        };
        if first {
            return Err(CodecError::Backend("the first submission failed".into()));
        }
        self.inner.encode(picture, force_key)?;
        while let Some(mut unit) = self.inner.poll() {
            unit.data.insert(0, self.tag);
            self.held.push_back(unit);
        }
        Ok(())
    }
    fn poll(&mut self) -> Option<EncodedUnit> {
        None
    }
    fn poll_result(&mut self) -> Result<Option<EncodedUnit>, CodecError> {
        let (hold, silent, fail) = {
            let knobs = self.knobs();
            (knobs.hold, knobs.silent, knobs.fail_first_poll)
        };
        if fail && !self.polled && !self.held.is_empty() {
            self.polled = true;
            return Err(CodecError::Backend("the first callback failed".into()));
        }
        if hold || silent {
            return Ok(None);
        }
        let unit = self.held.pop_front();
        self.polled |= unit.is_some();
        Ok(unit)
    }
    fn caps(&self) -> EncoderCaps {
        self.inner.caps()
    }
    fn flush(&mut self) -> Result<(), CodecError> {
        if self.knobs().flush_fails {
            return Err(CodecError::DeadlineExceeded);
        }
        self.knobs().hold = false;
        Ok(())
    }
}

/// The fallback (Chrome) until `found`, then VideoToolbox's hardware encoder.
struct Pair {
    found: bool,
    fallback: Shared,
    hardware: Shared,
}

impl Backends for Pair {
    fn encoder(&mut self, _codec: Codec) -> Result<Chosen, CodecError> {
        let (tag, knobs, backend) = if self.found {
            (HARDWARE, self.hardware.clone(), Backend::Vt)
        } else {
            (FALLBACK, self.fallback.clone(), Backend::Chrome)
        };
        Ok(Chosen {
            encoder: Box::new(Scripted {
                inner: FakeEncoder::new(Vec::new()),
                tag,
                knobs,
                held: VecDeque::new(),
                polled: false,
            }),
            backend,
            hardware: self.found,
            takes_jpeg: None,
        })
    }
    fn decode(&mut self, jpeg: &[u8], size: Size, _: Backend) -> Result<Decoded, CodecError> {
        let picture =
            JpegCodec::decode(&mut CpuJpegCodec::default(), jpeg, size.width, size.height)?;
        Ok(Decoded {
            picture,
            backend: Backend::Cpu,
            hardware: false,
            uploads: 0,
        })
    }
    fn probed(&self) -> Vec<media_wire::capability::Capability> {
        Vec::new()
    }
    fn choice(&self, _codec: Codec) -> Option<(Backend, bool)> {
        Some(if self.found {
            (Backend::Vt, true)
        } else {
            (Backend::Chrome, false)
        })
    }
}

struct Rig {
    worker: Worker<Pair>,
    fallback: Shared,
    hardware: Shared,
    out: Vec<Output>,
    now: u64,
}

impl Rig {
    fn new(hardware: Knobs) -> Self {
        let (fallback, hardware) = (Shared::default(), Arc::new(Mutex::new(hardware)));
        let worker = Worker::new(Pair {
            found: false,
            fallback: fallback.clone(),
            hardware: hardware.clone(),
        });
        let mut rig = Self {
            worker,
            fallback,
            hardware,
            out: Vec::new(),
            now: 0,
        };
        rig.run(Command::Configure(vec![spec(1, 1_000_000)]));
        rig
    }
    fn run(&mut self, command: Command) {
        self.now += 33_000;
        self.worker.command(command, self.now, &mut self.out);
    }
    fn pictures(&mut self, n: usize) {
        for _ in 0..n {
            self.run(picture(1));
        }
    }
    /// The probe's late result: hardware now.
    fn found(&mut self) {
        self.worker.backends.found = true;
        self.run(Command::Capabilities);
    }
    /// Who made each unit out so far, and whether it was a keyframe.
    fn units(&self) -> Vec<(u8, bool)> {
        units(&self.out)
            .iter()
            .map(|u| (u.payload[0], u.flags & 1 == 1))
            .collect()
    }
    fn last_report(&self) -> Option<&Acceleration> {
        self.out.iter().rev().find_map(|o| match o {
            Output::Report(a) => Some(a),
            _ => None,
        })
    }
    fn ended(&self) -> bool {
        self.out.iter().any(|o| matches!(o, Output::Failed(_)))
    }
}

fn knob(shared: &Shared, change: impl FnOnce(&mut Knobs)) {
    if let Ok(mut knobs) = shared.lock() {
        change(&mut knobs);
    }
}

#[test]
fn the_output_is_fallback_units_then_the_hardware_keyframe_then_hardware_units() {
    let mut rig = Rig::new(Knobs::default());
    rig.pictures(3);
    rig.found();
    rig.pictures(3);
    let units = rig.units();
    let first_hardware = units.iter().position(|u| u.0 == HARDWARE);
    let Some(at) = first_hardware else {
        panic!("never moved to hardware: {units:?}");
    };
    assert!(units[..at].iter().all(|u| u.0 == FALLBACK), "{units:?}");
    assert!(units[at].1, "hardware starts at a keyframe: {units:?}");
    assert!(units[at..].iter().all(|u| u.0 == HARDWARE), "{units:?}");
    assert_eq!(units.len(), 6, "one unit per picture: {units:?}");
    assert!(rig.last_report().is_some_and(|a| !a.degraded));
}

#[test]
fn a_fallback_whose_flush_fails_with_units_held_loses_none_of_them() {
    let mut rig = Rig::new(Knobs::default());
    knob(&rig.fallback, |k| {
        k.hold = true;
        k.flush_fails = true;
    });
    rig.pictures(3);
    assert!(rig.units().is_empty(), "the fallback is holding its units");
    rig.found();
    rig.pictures(1);
    // The flush failed, but the fallback's units still arrive; only then does hardware start.
    assert!(
        rig.units().is_empty(),
        "nothing out before the fallback's own units"
    );
    knob(&rig.fallback, |k| k.hold = false);
    rig.pictures(1);
    let units = rig.units();
    assert_eq!(
        units,
        [
            (FALLBACK, true),
            (FALLBACK, false),
            (FALLBACK, false),
            (HARDWARE, true),
            (HARDWARE, false)
        ]
    );
    assert!(!rig.ended());
}

#[test]
fn hardware_failing_its_first_submission_leaves_the_source_on_the_fallback_degraded() {
    let mut rig = Rig::new(Knobs {
        fail_first_encode: true,
        ..Knobs::default()
    });
    rig.pictures(2);
    rig.found();
    rig.pictures(3);
    assert!(!rig.ended(), "the source keeps going");
    assert!(rig.units().iter().all(|u| u.0 == FALLBACK));
    assert_eq!(rig.units().len(), 5);
    assert!(rig.last_report().is_some_and(|a| a.degraded));
}

#[test]
fn hardware_failing_its_first_callback_leaves_the_source_on_the_fallback_degraded() {
    let mut rig = Rig::new(Knobs {
        fail_first_poll: true,
        ..Knobs::default()
    });
    rig.pictures(2);
    rig.found();
    rig.pictures(3);
    assert!(!rig.ended());
    assert!(rig.units().iter().all(|u| u.0 == FALLBACK));
    assert_eq!(rig.units().len(), 5);
    assert!(rig.last_report().is_some_and(|a| a.degraded));
    // Not tried again for this source until the next capabilities.changed.
    let encodes = rig.hardware.lock().map(|k| k.encodes).unwrap_or(0);
    rig.pictures(2);
    assert_eq!(rig.hardware.lock().map(|k| k.encodes).unwrap_or(0), encodes);
}

#[test]
fn a_hardware_encoder_slow_to_its_keyframe_runs_beside_the_fallback_then_is_given_up() {
    let mut rig = Rig::new(Knobs {
        silent: true,
        ..Knobs::default()
    });
    rig.pictures(1);
    rig.found();
    // 33 ms a picture: 2 s is about 60 pictures. The fallback delivers every one meanwhile.
    rig.pictures(30);
    assert_eq!(rig.units().len(), 31);
    assert!(rig.units().iter().all(|u| u.0 == FALLBACK));
    rig.pictures(40);
    let fed = rig.hardware.lock().map(|k| k.encodes).unwrap_or(0);
    rig.pictures(5);
    assert_eq!(
        rig.hardware.lock().map(|k| k.encodes).unwrap_or(0),
        fed,
        "given up past 2 s without a keyframe"
    );
    assert_eq!(rig.units().len(), 76);
    assert!(!rig.ended());
    assert!(rig.last_report().is_some_and(|a| a.degraded));
}

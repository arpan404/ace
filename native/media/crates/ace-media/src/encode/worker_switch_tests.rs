// SPDX-License-Identifier: Apache-2.0
//! The move from the fallback onto a hardware encoder that a late probe result brought is one
//! cut-over at one picture: the fallback finishes everything before it, the hardware encoder
//! starts at it with a keyframe, and a hardware encoder that fails sends the source back to
//! the fallback at a keyframe, never ending it.
use super::*;
use media_codec::EncoderCaps;
use std::sync::{Arc, Mutex};

const FALLBACK: u8 = 0xF0;
const HARDWARE: u8 = 0xA0;

#[derive(Default)]
struct Knobs {
    /// Units stay inside until a flush (or `hold` is cleared).
    hold: bool,
    flush_fails: bool,
    fail_configure: bool,
    fail_first_encode: bool,
    fail_first_poll: bool,
    /// Results fail once this many units have come out.
    fail_after: Option<usize>,
    /// The encoder produces nothing at all.
    silent: bool,
    /// The encoder never makes a keyframe, even one it is asked for.
    ignore_keys: bool,
    /// Results fail once it has been flushed.
    broken_after_flush: bool,
    flushed: bool,
    encodes: usize,
    out: usize,
}

type Shared = Arc<Mutex<Knobs>>;

fn knobs(shared: &Shared) -> std::sync::MutexGuard<'_, Knobs> {
    match shared.lock() {
        Ok(knobs) => knobs,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// FakeEncoder, each unit's payload naming who made it and its picture: `[tag, pts…]`.
struct Scripted {
    inner: FakeEncoder,
    tag: u8,
    knobs: Shared,
    held: VecDeque<EncodedUnit>,
    polled: bool,
}

impl Encoder for Scripted {
    fn configure(&mut self, spec: &Spec) -> Result<(), CodecError> {
        if knobs(&self.knobs).fail_configure {
            return Err(CodecError::Backend("configure failed".into()));
        }
        self.inner.configure(spec)
    }
    fn encode(&mut self, picture: Picture, force_key: bool) -> Result<(), CodecError> {
        let fail = {
            let mut knobs = knobs(&self.knobs);
            knobs.encodes += 1;
            knobs.encodes == 1 && knobs.fail_first_encode
        };
        if fail {
            return Err(CodecError::Backend("the first submission failed".into()));
        }
        self.inner.encode(picture, force_key)?;
        let ignore_keys = knobs(&self.knobs).ignore_keys;
        while let Some(mut unit) = self.inner.poll() {
            unit.key &= !ignore_keys;
            unit.data = [vec![self.tag], unit.pts_us.to_be_bytes().to_vec()].concat();
            self.held.push_back(unit);
        }
        Ok(())
    }
    fn poll(&mut self) -> Option<EncodedUnit> {
        None
    }
    fn poll_result(&mut self) -> Result<Option<EncodedUnit>, CodecError> {
        let mut k = knobs(&self.knobs);
        if k.fail_first_poll && !self.polled && !self.held.is_empty() {
            self.polled = true;
            return Err(CodecError::Backend("the first callback failed".into()));
        }
        let broken = k.broken_after_flush && k.flushed;
        if (broken || k.fail_after.is_some_and(|n| k.out >= n)) && !self.held.is_empty() {
            return Err(CodecError::Backend("the encoder broke".into()));
        }
        if k.hold || k.silent {
            return Ok(None);
        }
        let unit = self.held.pop_front();
        self.polled |= unit.is_some();
        k.out += usize::from(unit.is_some());
        Ok(unit)
    }
    fn caps(&self) -> EncoderCaps {
        self.inner.caps()
    }
    fn flush(&mut self) -> Result<(), CodecError> {
        let mut k = knobs(&self.knobs);
        if k.flush_fails {
            return Err(CodecError::DeadlineExceeded);
        }
        k.hold = false;
        k.flushed = true;
        Ok(())
    }
}

/// The fallback (Chrome) until `found`, then VideoToolbox's hardware encoder.
struct Pair {
    found: bool,
    fallback: Shared,
    hardware: Shared,
    built: Vec<u8>,
    /// No fallback encoder can be built.
    fallback_fails: bool,
}

impl Pair {
    fn scripted(&mut self, hardware: bool) -> Chosen {
        let (tag, knobs, backend) = if hardware {
            (HARDWARE, self.hardware.clone(), Backend::Vt)
        } else {
            (FALLBACK, self.fallback.clone(), Backend::Chrome)
        };
        self.built.push(tag);
        Chosen {
            encoder: Box::new(Scripted {
                inner: FakeEncoder::new(Vec::new()),
                tag,
                knobs,
                held: VecDeque::new(),
                polled: false,
            }),
            backend,
            hardware,
            takes_jpeg: None,
        }
    }
}

impl Backends for Pair {
    fn encoder(&mut self, _codec: Codec) -> Result<Chosen, CodecError> {
        Ok(self.scripted(self.found))
    }
    fn fallback(&mut self, _codec: Codec) -> Result<Chosen, CodecError> {
        if self.fallback_fails {
            return Err(CodecError::Unsupported("no Chrome to encode with".into()));
        }
        Ok(self.scripted(false))
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

/// One unit as the tests read it: who made it, which picture (its pts), and if it's a keyframe.
type Seen = (u8, u64, bool);

struct Rig {
    worker: Worker<Pair>,
    fallback: Shared,
    hardware: Shared,
    out: Vec<Output>,
    now: u64,
    /// Each picture's pts, in the order sent.
    sent: Vec<u64>,
}

impl Rig {
    fn new(hardware: Knobs) -> Self {
        let (fallback, hardware) = (Shared::default(), Arc::new(Mutex::new(hardware)));
        let worker = Worker::new(Pair {
            found: false,
            fallback: fallback.clone(),
            hardware: hardware.clone(),
            built: Vec::new(),
            fallback_fails: false,
        });
        let mut rig = Self {
            worker,
            fallback,
            hardware,
            out: Vec::new(),
            now: 0,
            sent: Vec::new(),
        };
        rig.run(Command::Configure(vec![spec(1, 1_000_000)]));
        rig
    }
    fn run(&mut self, command: Command) {
        self.now += 33_000;
        self.worker.command(command, self.now, &mut self.out);
    }
    /// Sends `n` pictures; returns their pts.
    fn pictures(&mut self, n: usize) -> Vec<u64> {
        (0..n)
            .map(|_| {
                self.run(picture(1));
                // `picture` is 2 ms old when sent; pts is its capture time.
                let pts = self.now - 2_000;
                self.sent.push(pts);
                pts
            })
            .collect()
    }
    /// The probe's late result: hardware now.
    fn found(&mut self) {
        self.worker.backends.found = true;
        self.run(Command::Capabilities);
    }
    fn seen(&self) -> Vec<Seen> {
        units(&self.out)
            .iter()
            .map(|u| {
                let mut pts = [0u8; 8];
                pts.copy_from_slice(&u.payload[1..9]);
                (u.payload[0], u64::from_be_bytes(pts), u.flags & 1 == 1)
            })
            .collect()
    }
    fn degraded(&self) -> Option<bool> {
        self.out.iter().rev().find_map(|o| match o {
            Output::Report(a) => Some(a.degraded),
            _ => None,
        })
    }
    fn ended(&self) -> bool {
        self.out.iter().any(|o| matches!(o, Output::Failed(_)))
    }
    /// No picture out twice or out of order, whoever encoded it.
    fn in_order(&self) {
        let seen = self.seen();
        assert!(
            seen.windows(2).all(|w| w[0].1 < w[1].1),
            "pictures out of order or twice: {seen:?}"
        );
    }
}

#[test]
fn the_fallback_sends_every_picture_before_the_boundary_then_hardware_starts_at_it_with_a_keyframe()
{
    let mut rig = Rig::new(Knobs::default());
    let before = rig.pictures(3);
    rig.found();
    let after = rig.pictures(3);
    assert_eq!(
        rig.seen(),
        [
            (FALLBACK, before[0], true),
            (FALLBACK, before[1], false),
            (FALLBACK, before[2], false),
            (HARDWARE, after[0], true),
            (HARDWARE, after[1], false),
            (HARDWARE, after[2], false),
        ]
    );
    assert_eq!(rig.degraded(), Some(false));
}

#[test]
fn the_fallbacks_held_output_is_flushed_out_before_the_boundary() {
    let mut rig = Rig::new(Knobs::default());
    knobs(&rig.fallback).hold = true;
    let before = rig.pictures(3);
    assert!(rig.seen().is_empty());
    rig.found();
    let after = rig.pictures(1);
    assert_eq!(
        rig.seen(),
        [
            (FALLBACK, before[0], true),
            (FALLBACK, before[1], false),
            (FALLBACK, before[2], false),
            (HARDWARE, after[0], true),
        ]
    );
}

#[test]
fn a_failed_fallback_flush_keeps_what_was_out_and_the_keyframe_still_follows() {
    let mut rig = Rig::new(Knobs::default());
    let out = rig.pictures(2);
    {
        let mut k = knobs(&rig.fallback);
        k.hold = true;
        k.flush_fails = true;
    }
    rig.pictures(1); // held inside the fallback when its flush fails: dropped
    rig.found();
    let after = rig.pictures(2);
    assert_eq!(
        rig.seen(),
        [
            (FALLBACK, out[0], true),
            (FALLBACK, out[1], false),
            (HARDWARE, after[0], true),
            (HARDWARE, after[1], false),
        ]
    );
    rig.in_order();
    assert!(!rig.ended());
}

/// After hardware failed: the next unit is a fallback keyframe, the source is degraded again,
/// it never ended, and nothing came out of order.
fn back_on_the_fallback(rig: &Rig, keyframe_for: u64) {
    let seen = rig.seen();
    let Some(at) = seen.iter().position(|s| s.1 == keyframe_for) else {
        panic!("no unit for {keyframe_for}: {seen:?}");
    };
    assert_eq!(seen[at], (FALLBACK, keyframe_for, true), "{seen:?}");
    assert!(seen[at..].iter().all(|s| s.0 == FALLBACK), "{seen:?}");
    assert_eq!(rig.degraded(), Some(true));
    assert!(!rig.ended());
    rig.in_order();
}

#[test]
fn hardware_failing_to_configure_keeps_the_fallback_with_a_keyframe() {
    let mut rig = Rig::new(Knobs {
        fail_configure: true,
        ..Knobs::default()
    });
    rig.pictures(2);
    rig.found();
    let after = rig.pictures(2);
    back_on_the_fallback(&rig, after[0]);
}

#[test]
fn hardware_failing_its_first_submission_goes_back_to_the_fallback_at_that_picture() {
    let mut rig = Rig::new(Knobs {
        fail_first_encode: true,
        ..Knobs::default()
    });
    rig.pictures(2);
    rig.found();
    let after = rig.pictures(2);
    back_on_the_fallback(&rig, after[0]);
}

#[test]
fn hardware_failing_its_first_callback_goes_back_to_the_fallback_at_the_next_picture() {
    let mut rig = Rig::new(Knobs {
        fail_first_poll: true,
        ..Knobs::default()
    });
    rig.pictures(2);
    rig.found();
    let after = rig.pictures(3);
    back_on_the_fallback(&rig, after[1]);
    // Not tried again for this source until the next capabilities.changed.
    let encodes = knobs(&rig.hardware).encodes;
    rig.pictures(2);
    assert_eq!(knobs(&rig.hardware).encodes, encodes);
}

#[test]
fn hardware_failing_after_its_output_goes_back_to_a_rebuilt_fallback_with_a_keyframe() {
    let mut rig = Rig::new(Knobs {
        fail_after: Some(2),
        ..Knobs::default()
    });
    rig.pictures(2);
    rig.found();
    let after = rig.pictures(5);
    let seen = rig.seen();
    assert_eq!(seen[2], (HARDWARE, after[0], true), "{seen:?}");
    assert_eq!(seen[3], (HARDWARE, after[1], false), "{seen:?}");
    // The third hardware result fails; that picture is gone, and the next is a fallback keyframe.
    back_on_the_fallback(&rig, after[3]);
    assert_eq!(
        rig.worker.backends.built,
        [FALLBACK, HARDWARE, FALLBACK],
        "rebuilt"
    );
}

#[test]
fn hardware_without_a_keyframe_within_two_seconds_goes_back_to_the_fallback() {
    let mut rig = Rig::new(Knobs {
        silent: true,
        ..Knobs::default()
    });
    rig.pictures(1);
    rig.found();
    // 33 ms a picture: about 60 make 2 s.
    rig.pictures(70);
    let seen = rig.seen();
    let Some(first) = seen.iter().position(|s| s.1 > rig.sent[0]) else {
        panic!("nothing after the cut-over: {seen:?}");
    };
    assert_eq!(seen[first].0, FALLBACK);
    assert!(seen[first].2, "back on the fallback at a keyframe");
    assert_eq!(rig.degraded(), Some(true));
    assert!(!rig.ended());
    rig.in_order();
}

#[test]
fn a_drain_mid_cut_over_flushes_the_hardware_encoder_and_says_drained_after_its_units() {
    let mut rig = Rig::new(Knobs {
        hold: true,
        ..Knobs::default()
    });
    rig.pictures(2);
    rig.found();
    let after = rig.pictures(2);
    rig.run(Command::Drain);
    let seen = rig.seen();
    assert_eq!(
        &seen[2..],
        [(HARDWARE, after[0], true), (HARDWARE, after[1], false)]
    );
    let drained = rig.out.iter().position(|o| matches!(o, Output::Drained));
    let last_unit = rig.out.iter().rposition(|o| matches!(o, Output::Unit(_)));
    assert!(
        drained.is_some() && drained > last_unit,
        "Drained after the units"
    );
}

#[test]
fn a_rate_change_mid_cut_over_reaches_the_hardware_encoder() {
    let mut rig = Rig::new(Knobs {
        hold: true,
        ..Knobs::default()
    });
    rig.pictures(1);
    rig.found();
    rig.run(Command::Configure(vec![spec(1, 500_000)]));
    let after = rig.pictures(2);
    knobs(&rig.hardware).hold = false;
    rig.pictures(1);
    let seen = rig.seen();
    assert_eq!(seen[1], (HARDWARE, after[0], true), "{seen:?}");
    assert!(!rig.ended());
}

#[path = "worker_cutover_edge_tests.rs"]
mod edges;

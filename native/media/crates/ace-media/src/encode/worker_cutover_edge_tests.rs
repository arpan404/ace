// SPDX-License-Identifier: Apache-2.0
//! The cut-over's edges: no fallback to go back to, and a drain while the hardware encoder is
//! still on probation or broken. Never undecodable output, never a clean end that isn't.
use super::*;

fn failed_reason(rig: &Rig) -> Option<&str> {
    rig.out.iter().find_map(|o| match o {
        Output::Failed(reason) => Some(reason.as_str()),
        _ => None,
    })
}

fn drained(rig: &Rig) -> bool {
    rig.out.iter().any(|o| matches!(o, Output::Drained))
}

#[test]
fn a_fallback_whose_flush_failed_is_removed_even_when_nothing_can_replace_it() {
    let mut rig = Rig::new(Knobs {
        fail_configure: true,
        ..Knobs::default()
    });
    let out = rig.pictures(1);
    {
        let mut k = knobs(&rig.fallback);
        k.hold = true;
        k.flush_fails = true;
    }
    rig.pictures(2); // held inside the unsafe fallback
    rig.worker.backends.fallback_fails = true;
    rig.found();
    assert!(failed_reason(&rig).is_some(), "the source ends, saying why");
    // The unsafe fallback is gone: what it held never comes out, whatever follows.
    knobs(&rig.fallback).hold = false;
    rig.pictures(3);
    assert_eq!(rig.seen(), [(FALLBACK, out[0], true)]);
}

#[test]
fn a_drain_drops_hardware_output_that_never_began_at_a_keyframe_and_ends_unclean() {
    let mut rig = Rig::new(Knobs {
        hold: true,
        ignore_keys: true,
        ..Knobs::default()
    });
    let before = rig.pictures(2);
    rig.found();
    rig.pictures(2); // held in the hardware encoder, which ignored the forced keyframe
    rig.run(Command::Drain);
    assert_eq!(
        rig.seen(),
        [(FALLBACK, before[0], true), (FALLBACK, before[1], false)],
        "no delta without its keyframe"
    );
    assert!(
        !drained(&rig),
        "accepted pictures were never delivered: not a clean end"
    );
    assert_eq!(failed_reason(&rig), Some("encoder-undrainable"));
}

#[test]
fn a_hardware_result_failing_during_a_drain_ends_it_unclean_without_recovering() {
    let mut rig = Rig::new(Knobs {
        hold: true,
        broken_after_flush: true,
        ..Knobs::default()
    });
    rig.pictures(2);
    rig.found();
    rig.pictures(2);
    rig.run(Command::Drain);
    assert!(!drained(&rig));
    assert_eq!(failed_reason(&rig), Some("encoder-undrainable"));
    assert_eq!(
        rig.worker.backends.built,
        [FALLBACK, HARDWARE],
        "no encoder made for a source that takes no more pictures"
    );
}

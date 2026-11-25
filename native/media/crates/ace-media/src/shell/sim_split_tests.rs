// SPDX-License-Identifier: Apache-2.0
//! The two-session split, driven directly with injected time.
use super::*;

fn split() -> Split {
    Split::new(5_600_000.0, 60.0)
}

#[test]
fn motion_units_always_go_to_the_bitrate_session() {
    let mut split = split();
    // The stream's first unit: motion, forced to a key.
    assert_eq!(split.input(60_000, true, 0.0), (Session::Motion, true));
    split.motion_reached();
    split.observe(60_000, true);
    // Later units, key or delta: still the motion session, never the refresh one.
    assert_eq!(split.input(40_000, false, 100.0), (Session::Motion, false));
    assert_eq!(split.input(60_000, true, 200.0), (Session::Motion, false));
}

#[test]
fn the_first_motion_unit_after_a_refresh_is_a_forced_key() {
    let mut split = split();
    assert_eq!(split.input(60_000, true, 0.0), (Session::Motion, true));
    split.motion_reached();
    split.observe(60_000, true);
    // Still 300 ms: the refresh goes to the refresh session.
    assert!(split.tick(299.0).is_none());
    let Some((session, _)) = split.tick(300.0) else {
        panic!("still 300 ms: refresh is due");
    };
    assert_eq!(session, Session::Refresh);
    split.did_refresh();
    // Motion resumes on the motion session, re-keyed before any delta goes out.
    assert_eq!(split.input(2_000, false, 350.0), (Session::Motion, true));
    split.motion_reached();
    // …and the motion session's deltas wait for that IDR.
    assert!(
        !split.motion_out(false),
        "a pre-refresh delta never interleaves"
    );
    assert!(split.motion_out(true), "the motion IDR goes out");
    // Afterwards deltas flow again, unforced.
    assert_eq!(split.input(2_000, false, 400.0), (Session::Motion, false));
    assert!(split.motion_out(false));
}

#[test]
fn a_viewer_keyframe_request_forces_the_next_motion_encode() {
    let mut split = split();
    assert_eq!(split.input(60_000, true, 0.0), (Session::Motion, true));
    split.motion_reached();
    assert_eq!(split.input(2_000, false, 100.0), (Session::Motion, false));
    split.request_key();
    assert_eq!(split.input(2_000, false, 200.0), (Session::Motion, true));
}

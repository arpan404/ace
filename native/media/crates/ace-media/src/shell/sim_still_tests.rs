// SPDX-License-Identifier: Apache-2.0
//! The still-refresh decision, driven directly with injected time.
use super::*;

fn control() -> StillControl {
    StillControl::new(5_600_000.0, 60.0)
}

#[test]
fn a_still_picture_is_refreshed_once_after_300_ms() {
    let mut still = control();
    // The first keyframe is a visible change.
    still.note_input(60_000, true, 0.0);
    let _ = still.next_qp(true);
    still.observe(60_000, true);
    assert_eq!(still.should_refresh(299.0), None, "not yet 300 ms still");
    let qp = still.should_refresh(300.0);
    assert!(qp.is_some(), "still 300 ms: one sharp refresh");
}

#[test]
fn motion_means_no_refresh() {
    let mut still = control();
    still.note_input(60_000, true, 0.0);
    let _ = still.next_qp(true);
    still.observe(60_000, true);
    // Large deltas keep coming: the picture is changing.
    still.note_input(40_000, false, 100.0);
    still.note_input(40_000, false, 200.0);
    still.note_input(40_000, false, 300.0);
    assert_eq!(still.should_refresh(400.0), None, "frames are changing");
}

#[test]
fn a_refresh_is_not_repeated_until_something_changes_again() {
    let mut still = control();
    still.note_input(60_000, true, 0.0);
    let _ = still.next_qp(true);
    still.observe(60_000, true);
    let first = still.should_refresh(350.0);
    assert!(first.is_some(), "first still spell refreshes");
    // The refreshed keyframe comes out and is observed, like the real transcode does.
    still.observe(80_000, true);
    assert_eq!(
        still.should_refresh(700.0),
        None,
        "no second refresh without a new change"
    );
    // Something changes, then goes still again: one more refresh.
    still.note_input(40_000, false, 800.0);
    let _ = still.next_qp(false);
    still.observe(20_000, false);
    assert_eq!(still.should_refresh(900.0), None, "changing again");
    assert!(
        still.should_refresh(1_100.0).is_some(),
        "still again: one more refresh"
    );
    assert_eq!(still.should_refresh(1_500.0), None, "and only one");
}

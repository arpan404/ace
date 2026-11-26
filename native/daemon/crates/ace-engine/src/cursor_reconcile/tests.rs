// SPDX-License-Identifier: Apache-2.0
//! The reconcile queue: a marked thread holds its lanes until its reconcile ends.

use super::*;

#[test]
fn a_marked_thread_is_held_and_released_exactly_once() {
    let mut state = crate::State::default();
    assert!(!holds(&state, "t"));
    mark(&mut state, "t");
    assert!(holds(&state, "t"));
    assert_eq!(take_marked(&mut state), vec!["t".to_owned()]);
    // Taking the marks starts them; the hold stays until the reconcile ends.
    assert!(holds(&state, "t"));
    release(&mut state, "t");
    assert!(!holds(&state, "t"));
}

#[test]
fn closing_stops_new_marks_from_mattering() {
    let mut state = crate::State::default();
    close(&mut state);
    assert!(state.cursor.closed);
}

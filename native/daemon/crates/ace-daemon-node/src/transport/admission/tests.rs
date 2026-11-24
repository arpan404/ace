// SPDX-License-Identifier: Apache-2.0
//! The admission state machine's transitions, proven alone: one release per
//! reservation, `opened` only after `Writing`, a deadline that cannot touch a
//! writing or released one, and a late acceptance that is released, never
//! opened.

use std::sync::Arc;
use std::thread;

use super::Admission;

/// An upgrade TypeScript accepted, through the checks and up to its `101`.
fn writing(admission: &Admission, reservation: u64) -> u64 {
    let id = admission.begin();
    assert!(admission.accepted(id, reservation));
    assert!(admission.writing(reservation));
    id
}

#[test]
fn a_decision_racing_the_deadline_leaves_exactly_one_owner() {
    for _ in 0..64 {
        let admission = Arc::new(Admission::new());
        let id = admission.begin();
        let deciding = Arc::clone(&admission);
        let timing_out = Arc::clone(&admission);
        let (accepted, timed_out) = thread::scope(|scope| {
            let accepted = scope.spawn(move || deciding.accepted(id, 4));
            let timed_out = scope.spawn(move || timing_out.timed_out(id));
            (accepted.join().unwrap(), timed_out.join().unwrap())
        });
        assert_ne!(accepted, timed_out, "exactly one transition wins the race");
        if accepted {
            assert!(
                !admission.released_late(id),
                "a held upgrade is no late one"
            );
            assert!(admission.writing(4), "the checks pass and the 101 begins");
            assert!(admission.released(4), "the holder releases its reservation");
            assert!(!admission.released(4), "once");
        } else {
            assert!(!admission.released(4), "nothing was held");
            assert!(
                admission.released_late(id),
                "the late acceptance is released"
            );
            assert!(!admission.released_late(id), "once");
        }
    }
}

#[test]
fn only_one_of_many_threads_releases_a_held_reservation() {
    let admission = Arc::new(Admission::new());
    writing(&admission, 21);
    let releases = thread::scope(|scope| {
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let admission = Arc::clone(&admission);
                scope.spawn(move || admission.released(21))
            })
            .collect();
        threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .filter(|released| *released)
            .count()
    });
    assert_eq!(releases, 1, "release happens exactly once across threads");
    assert!(!admission.opened(21), "and the reservation never opens");
}

#[test]
fn a_timeout_takes_an_upgrade_nobody_holds_and_nothing_else_can() {
    let admission = Admission::new();
    let id = admission.begin();
    assert!(admission.timed_out(id), "the deadline answers 503 once");
    assert!(
        !admission.timed_out(id),
        "a second deadline changes nothing"
    );
    assert!(
        !admission.accepted(id, 7),
        "an acceptance after the deadline never becomes a held reservation"
    );
    assert!(
        !admission.abandoned(id),
        "a timed-out upgrade is no longer pending"
    );
    assert!(
        admission.released_late(id),
        "the late acceptance is released"
    );
    assert!(
        !admission.released_late(id),
        "and released exactly once, however often it is reported"
    );
}

#[test]
fn a_held_reservation_is_released_exactly_once() {
    let admission = Admission::new();
    let id = admission.begin();
    assert!(admission.accepted(id, 11));
    assert!(
        admission.released(11),
        "the connection's release is the one"
    );
    assert!(!admission.released(11), "and a repeat releases nothing");
    assert!(
        !admission.writing(11),
        "a released reservation never starts writing"
    );
    assert!(!admission.opened(11), "and never opens");
    assert!(
        !admission.accepted(id, 12),
        "the upgrade was handed over already"
    );
}

#[test]
fn a_reservation_accepted_but_not_yet_writing_is_released_when_its_connection_goes() {
    // What a connection dropped while `ws`'s checks run does: it releases
    // the reservation its accepted decision holds.
    let admission = Admission::new();
    let id = admission.begin();
    assert!(admission.accepted(id, 9));
    assert!(
        admission.released(9),
        "the dropped connection releases once"
    );
    assert!(!admission.released(9));
    assert!(!admission.writing(9), "and nothing is written for it");
    assert!(!admission.opened(9), "and nothing is opened");
}

#[test]
fn an_opened_socket_is_never_released_afterwards() {
    let admission = Admission::new();
    writing(&admission, 3);
    assert!(admission.opened(3), "the flushed 101 registers one socket");
    assert!(!admission.opened(3), "and a repeated opened registers none");
    assert!(
        !admission.released(3),
        "a release would double-release an open socket"
    );
}

#[test]
fn a_deadline_cannot_abandon_or_time_out_a_held_reservation() {
    let admission = Admission::new();
    let id = admission.begin();
    assert!(admission.accepted(id, 5));
    assert!(admission.writing(5));
    assert!(
        !admission.abandoned(id),
        "writing is past the close deadline"
    );
    assert!(!admission.timed_out(id), "and past admission's deadline");
    assert!(admission.opened(5), "only the connection moves it on");
}

#[test]
fn a_connection_lost_while_pending_releases_a_late_acceptance_once() {
    let admission = Admission::new();
    let id = admission.begin();
    assert!(admission.abandoned(id), "the connection went away");
    assert!(
        !admission.accepted(id, 9),
        "the acceptance arrives after nobody is listening"
    );
    assert!(
        admission.released_late(id),
        "so its reservation is released"
    );
    assert!(!admission.released_late(id));
    assert!(!admission.opened(9), "and nothing is ever opened");
}

#[test]
fn a_refusal_holds_no_reservation_and_no_reservation_of_its_own_can_move() {
    let admission = Admission::new();
    let id = admission.begin();
    admission.settled(id);
    assert!(
        !admission.released(1),
        "a refused upgrade's reservation was never TypeScript's"
    );
    assert!(!admission.opened(1));
    assert!(!admission.released_late(id), "nothing is held to release");
    assert!(
        !admission.accepted(id, 1),
        "a settled upgrade stays settled"
    );
}

// SPDX-License-Identifier: Apache-2.0
//! The admission lock (`admission.ts`): one holder, a FIFO queue of at most 64,
//! and a waiter its caller's signal can take out.

use super::{Acquire, Admission, AdmissionError, MAX_WAITERS};

#[test]
fn a_free_lock_is_granted_and_held_until_it_is_released() {
    let mut admission = Admission::new();
    assert_eq!(admission.acquire(false), Ok(Acquire::Granted));
    assert!(admission.active());
    assert_eq!(admission.acquire(false), Ok(Acquire::Queued(0)));
    assert_eq!(admission.release(), Some(0));
    assert!(admission.active(), "the next waiter holds it");
    assert_eq!(admission.release(), None);
    assert!(!admission.active());
    assert_eq!(admission.acquire(false), Ok(Acquire::Granted));
}

#[test]
fn waiters_are_granted_in_the_order_they_asked() {
    let mut admission = Admission::new();
    assert_eq!(admission.acquire(false), Ok(Acquire::Granted));
    for id in 0..3 {
        assert_eq!(admission.acquire(false), Ok(Acquire::Queued(id)));
    }
    assert_eq!(admission.waiting(), 3);
    assert_eq!(admission.release(), Some(0));
    assert_eq!(admission.release(), Some(1));
    assert_eq!(admission.release(), Some(2));
    assert_eq!(admission.release(), None);
}

#[test]
fn a_waiter_its_signal_takes_out_leaves_the_queue() {
    let mut admission = Admission::new();
    admission.acquire(false).expect("granted");
    assert_eq!(admission.acquire(false), Ok(Acquire::Queued(0)));
    assert_eq!(admission.acquire(false), Ok(Acquire::Queued(1)));
    assert!(admission.abort(0));
    assert!(!admission.abort(0), "only once");
    assert!(!admission.abort(9), "never waiting");
    assert_eq!(admission.waiting(), 1);
    // The freed slot is not reused: ids only move forward.
    assert_eq!(admission.acquire(false), Ok(Acquire::Queued(2)));
    assert_eq!(admission.release(), Some(1));
    assert_eq!(admission.release(), Some(2));
    assert_eq!(admission.release(), None);
}

#[test]
fn the_queue_is_bounded_at_sixty_four_waiters() {
    let mut admission = Admission::new();
    admission.acquire(false).expect("granted");
    for id in 0..MAX_WAITERS {
        assert_eq!(admission.acquire(false), Ok(Acquire::Queued(id as u64)));
    }
    assert_eq!(admission.acquire(false), Err(AdmissionError::Full));
    assert_eq!(admission.waiting(), MAX_WAITERS);
}

#[test]
fn a_caller_whose_signal_fired_never_takes_the_lock_or_a_place() {
    let mut admission = Admission::new();
    // Free lock: the aborted caller does not hold it, and the next one does.
    assert_eq!(admission.acquire(true), Err(AdmissionError::Cancelled));
    assert!(!admission.active());
    assert_eq!(admission.waiting(), 0);
    assert_eq!(admission.acquire(false), Ok(Acquire::Granted));
    // Held lock: the aborted caller is not queued either.
    assert_eq!(admission.acquire(true), Err(AdmissionError::Cancelled));
    assert_eq!(admission.waiting(), 0);
}

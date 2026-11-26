//! Ports `apps/daemon/src/relay-nk/admission.test.ts`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::{Arc, Mutex};

use super::{Held, NK_LIMITS, NkAdmission, NkLimits, NkSession, Suppressive};

use crate::nk::tests_support::ManualClock;

fn admission(limits: NkLimits) -> (Arc<ManualClock>, NkAdmission) {
    let clock = ManualClock::new();
    let admission = NkAdmission::new(clock.clone(), limits);
    (clock, admission)
}

fn with(apply: impl FnOnce(&mut NkLimits)) -> NkLimits {
    let mut limits = NK_LIMITS;
    apply(&mut limits);
    limits
}

fn key(n: u32) -> Vec<u8> {
    let mut bytes = vec![(n % 256) as u8; 32];
    bytes[0] = (n >> 8) as u8;
    bytes
}

#[test]
fn the_daemon_decrypts_at_most_forty_first_messages_at_once_and_twenty_a_second_after_that() {
    let (clock, admission) = admission(NK_LIMITS);
    let mut taken = 0;
    for _ in 0..100 {
        if admission.arrive() {
            taken += 1;
        }
    }
    assert_eq!(taken, 40);
    clock.advance(1_000);
    taken = 0;
    for _ in 0..100 {
        if admission.arrive() {
            taken += 1;
        }
    }
    assert_eq!(taken, 20);
}

#[test]
fn one_claimed_device_gets_four_at_once_and_two_a_second_without_using_anothers_room() {
    let (clock, admission) = admission(NK_LIMITS);
    let results: Vec<bool> = (0..10).map(|_| admission.claim("phone")).collect();
    assert_eq!(results.iter().filter(|taken| **taken).count(), 4);
    assert!(admission.claim("tablet"));
    clock.advance(1_000);
    assert_eq!(
        [
            admission.claim("phone"),
            admission.claim("phone"),
            admission.claim("phone")
        ],
        [true, true, false]
    );
}

#[test]
fn a_flood_of_made_up_device_ids_cannot_grow_the_table_and_idle_ids_make_room() {
    let limits = with(|limits| limits.tracked_devices = 8);
    let (clock, admission) = admission(limits);
    for n in 0..8 {
        assert!(admission.claim(&format!("fake-{n}")));
    }
    assert!(!admission.claim("real"));
    // Once their buckets refill they are forgotten, and a new id is tracked.
    clock.advance(2_000);
    assert!(admission.claim("real"));
}

#[test]
fn an_identical_first_message_is_refused_for_five_minutes_and_a_refused_key_is_given_back() {
    let limits = with(|limits| limits.suppress_entries = 3);
    let (clock, admission) = admission(limits);
    let first = admission.suppress(&key(1));
    assert!(matches!(first, Suppressive::Claimed(_)));
    assert!(matches!(admission.suppress(&key(1)), Suppressive::Seen));
    let Suppressive::Claimed(mut refused) = admission.suppress(&key(2)) else {
        panic!("expected a claim");
    };
    refused.release();
    assert!(matches!(
        admission.suppress(&key(2)),
        Suppressive::Claimed(_)
    ));
    assert!(matches!(
        admission.suppress(&key(3)),
        Suppressive::Claimed(_)
    ));
    // Full: refused, nothing forgotten early.
    assert!(matches!(admission.suppress(&key(4)), Suppressive::Full));
    assert!(matches!(admission.suppress(&key(1)), Suppressive::Seen));
    clock.advance(NK_LIMITS.suppress_ms);
    assert!(matches!(
        admission.suppress(&key(1)),
        Suppressive::Claimed(_)
    ));
    let held: Held = admission.held();
    assert_eq!(held.suppressed, 1);
}

#[test]
fn a_device_holds_two_unconfirmed_sessions_and_the_daemon_thirty_two() {
    let (_clock, admission) = admission(NK_LIMITS);
    let first = admission.admit("phone", || {}).unwrap();
    let second = admission.admit("phone", || {}).unwrap();
    assert!(admission.admit("phone", || {}).is_none());
    first.confirm();
    // Confirmed sessions keep working with no limits, and no longer count.
    assert!(first.output(10 * 1024 * 1024));
    assert!(admission.admit("phone", || {}).is_some());
    let others: Vec<Option<NkSession>> = (0..40)
        .map(|n| admission.admit(&format!("device-{n}"), || {}))
        .collect();
    assert_eq!(others.iter().filter(|each| each.is_some()).count(), 30);
    for session in others.into_iter().flatten() {
        session.close();
    }
    assert!(admission.admit("device-x", || {}).is_some());
    let _ = second;
}

#[test]
fn a_device_gets_at_most_six_nk_attempts_a_minute() {
    let (clock, admission) = admission(NK_LIMITS);
    for _ in 0..6 {
        admission.admit("phone", || {}).unwrap().confirm();
    }
    assert!(admission.admit("phone", || {}).is_none());
    clock.advance(60_001);
    assert!(admission.admit("phone", || {}).is_some());
}

#[test]
fn an_unconfirmed_session_holds_at_most_eight_mib_and_all_of_them_sixty_four() {
    let (_clock, admission) = admission(NK_LIMITS);
    let mib = 1024 * 1024;
    let sessions: Vec<NkSession> = (0..9)
        .map(|n| admission.admit(&format!("d{n}"), || {}).unwrap())
        .collect();
    let first = &sessions[0];
    assert!(first.reserve_bytes(8 * mib));
    assert!(!first.reserve_bytes(1));
    for session in &sessions[1..8] {
        assert!(session.reserve_bytes(8 * mib));
    }
    assert_eq!(admission.held().bytes, 64 * mib);
    // The ninth has its own room but the daemon has none.
    assert!(!sessions[8].reserve_bytes(1));
    first.confirm();
    assert!(sessions[8].reserve_bytes(8 * mib));
    for session in &sessions {
        session.close();
    }
    assert_eq!(
        admission.held(),
        Held {
            sessions: 0,
            bytes: 0,
            suppressed: 0
        }
    );
}

#[test]
fn an_unconfirmed_session_replays_at_most_two_thousand_events_and_sends_256_kib() {
    let (_clock, admission) = admission(NK_LIMITS);
    let session = admission.admit("phone", || {}).unwrap();
    assert!(session.reserve_events(1_500));
    assert!(!session.reserve_events(501));
    assert!(session.reserve_events(500));
    assert!(session.output(200 * 1024));
    assert!(!session.output(57 * 1024));
    assert!(session.output(56 * 1024));
    session.confirm();
    assert!(session.reserve_events(1_000_000));
    assert!(session.output(64 * 1024 * 1024));
}

#[test]
fn a_session_that_does_not_confirm_in_five_seconds_is_closed_and_gives_everything_back() {
    let (clock, admission) = admission(NK_LIMITS);
    let expired = Arc::new(Mutex::new(Vec::new()));
    let late_expiry = Arc::clone(&expired);
    let late = admission
        .admit("phone", move || late_expiry.lock().unwrap().push("phone"))
        .unwrap();
    let prompt_expiry = Arc::clone(&expired);
    let prompt = admission
        .admit("tablet", move || {
            prompt_expiry.lock().unwrap().push("tablet")
        })
        .unwrap();
    late.reserve_bytes(1024);
    prompt.reserve_bytes(1024);
    clock.advance(4_000);
    prompt.confirm();
    clock.advance(1_000);
    assert_eq!(*expired.lock().unwrap(), vec!["phone"]);
    assert!(!late.reserve_bytes(1));
    assert!(prompt.output(1024 * 1024));
    assert_eq!(
        admission.held(),
        Held {
            sessions: 0,
            bytes: 0,
            suppressed: 0
        }
    );
    assert_eq!(clock.pending(), 0);
}

#[test]
fn a_vanished_session_does_not_keep_the_daemons_bytes() {
    let (_clock, admission) = admission(NK_LIMITS);
    {
        let session = admission.admit("phone", || {}).unwrap();
        assert!(session.reserve_bytes(1024));
        session.close();
    }
    assert_eq!(admission.held().bytes, 0);
    assert_eq!(admission.held().sessions, 0);
}

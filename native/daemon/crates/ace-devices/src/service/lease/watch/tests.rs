// SPDX-License-Identifier: Apache-2.0
//! The lease watch (`lease-expiry.ts`): a held pointer is released when the
//! lease runs out, without any command having to read it.

use super::super::{Actor, ControllerLease, LEASE_MS};
use super::{LeaseWatch, MAX_WAIT_MS, WatchStep};

fn agent() -> Actor {
    Actor::agent("agent-1", "t1", "a1")
}

#[test]
fn a_watch_on_a_free_device_never_arms() {
    let mut lease = ControllerLease::new();
    let (watch, steps) = LeaseWatch::start(&mut lease, 0.0);
    assert!(!watch.active());
    assert!(steps.is_empty());
}

#[test]
fn a_held_lease_arms_the_next_read_and_reports_its_first_control() {
    let mut lease = ControllerLease::new();
    lease.claim(agent(), 0.0);
    let (watch, steps) = LeaseWatch::start(&mut lease, 0.0);
    assert!(watch.active());
    // The deadline was set by the claim, so the first read sees no move.
    assert_eq!(steps, vec![WatchStep::Arm(MAX_WAIT_MS)]);
}

#[test]
fn a_moved_deadline_is_a_new_control_and_a_short_lease_waits_less() {
    let mut lease = ControllerLease::new();
    lease.claim(agent(), 0.0);
    let (mut watch, _) = LeaseWatch::start(&mut lease, 0.0);

    // A fresh claim moves the deadline: the held pointer belongs to the old one.
    lease.claim(agent(), 1_000.0);
    assert_eq!(
        watch.due(&mut lease, 1_000.0),
        vec![WatchStep::Renewed, WatchStep::Arm(MAX_WAIT_MS)]
    );

    // Near the end, the wait is only what is left.
    assert_eq!(
        watch.due(&mut lease, 30_000.0),
        vec![WatchStep::Arm(1_000.0)]
    );
}

#[test]
fn the_watch_reports_the_expiry_once_and_stops() {
    let mut lease = ControllerLease::new();
    lease.claim(agent(), 0.0);
    let (mut watch, _) = LeaseWatch::start(&mut lease, 0.0);
    assert_eq!(watch.due(&mut lease, LEASE_MS), vec![WatchStep::Expired]);
    assert!(!watch.active());
    assert!(watch.due(&mut lease, LEASE_MS + 1.0).is_empty());
}

#[test]
fn a_retained_ticket_keeps_the_watch_arming() {
    let mut lease = ControllerLease::new();
    lease.claim(agent(), 0.0);
    let ticket = lease.retain(&agent(), 1, 0.0).expect("held");
    let (mut watch, _) = LeaseWatch::start(&mut lease, 0.0);

    // At the original deadline the ticket renews it, so the watch renews.
    assert_eq!(
        watch.due(&mut lease, LEASE_MS),
        vec![WatchStep::Renewed, WatchStep::Arm(MAX_WAIT_MS)]
    );

    lease.release_retained(ticket);
    assert_eq!(
        watch.due(&mut lease, LEASE_MS * 2.0),
        vec![WatchStep::Expired]
    );
}

#[test]
fn a_cancelled_watch_does_nothing_more() {
    let mut lease = ControllerLease::new();
    lease.claim(agent(), 0.0);
    let (mut watch, _) = LeaseWatch::start(&mut lease, 0.0);
    watch.cancel();
    assert!(watch.due(&mut lease, LEASE_MS).is_empty());
    assert!(!watch.active());
}

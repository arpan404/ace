//! Ports `apps/daemon/src/ticket-allocation.server.process.test.ts` at the pool the daemon's
//! `/v1/tickets` route and welcome handover call, with the same times, caps and refusals.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::{IssueError, TicketLimits, TicketPool, default_ticket_limits};

fn limits(global: usize, per_device: usize, per_minute: u32) -> TicketLimits {
    TicketLimits {
        global,
        per_device,
        per_minute,
    }
}

#[test]
fn limits_one_devices_pending_tickets_without_starving_another_device() {
    let mut pool = TicketPool::new(default_ticket_limits());
    for index in 0..32 {
        pool.issue(&format!("noisy-{index}"), "noisy", "g1", 1_000, "")
            .expect("inside the per-device quota");
    }
    assert_eq!(
        pool.issue("noisy-extra", "noisy", "g1", 1_000, ""),
        Err(IssueError::DeviceQuotaExceeded)
    );
    // Another device still gets one, and it is usable.
    pool.issue("other-1", "other", "g2", 1_000, "")
        .expect("another device is unaffected");
}

#[test]
fn a_revoked_devices_pending_tickets_are_reclaimed_at_once_under_the_global_cap() {
    let mut pool = TicketPool::new(limits(64, 32, 120));
    for index in 0..32 {
        pool.issue(&format!("first-{index}"), "first", "g1", 1_000, "")
            .expect("first device's quota");
        pool.issue(&format!("second-{index}"), "second", "g2", 1_000, "")
            .expect("second device's quota");
    }
    assert_eq!(
        pool.issue("waiting-1", "waiting", "g3", 1_000, ""),
        Err(IssueError::TooManyPending)
    );
    pool.revoke("first");
    assert_eq!(pool.len(), 32);
    pool.issue("waiting-1", "waiting", "g3", 1_000, "")
        .expect("the revoked device's capacity is released");
    // The revoked device's own outstanding tickets are gone, not merely disowned.
    assert_eq!(pool.consume("first-0", 1_000, None), None);
}

#[test]
fn rate_limits_issuance_even_when_every_ticket_is_consumed_and_resets_at_sixty_seconds() {
    let mut pool = TicketPool::new(limits(10_000, 32, 3));
    for index in 0..3 {
        let ticket = format!("busy-{index}");
        pool.issue(&ticket, "busy", "g1", 1_000, "")
            .expect("inside the rate");
        assert_eq!(
            pool.consume(&ticket, 1_000, None)
                .expect("a fresh ticket is spent")
                .device_id,
            "busy"
        );
    }
    assert_eq!(
        pool.issue("busy-3", "busy", "g1", 1_000, ""),
        Err(IssueError::RateLimitExceeded)
    );
    pool.issue("other-1", "other", "g2", 1_000, "")
        .expect("another device is unaffected");
    pool.issue("busy-4", "busy", "g1", 61_000, "")
        .expect("the window resets after sixty seconds");
}

#[test]
fn expiration_releases_capacity_without_evicting_a_later_unexpired_ticket() {
    let mut pool = TicketPool::new(limits(2, 2, 120));
    let old = pool
        .issue("old", "paired", "g1", 1_000, "")
        .expect("first ticket");
    let later = pool
        .issue("later", "paired", "g1", 11_000, "")
        .expect("second ticket");
    assert_eq!(
        pool.issue("third", "paired", "g1", 11_000, ""),
        Err(IssueError::TooManyPending)
    );
    pool.issue("third", "paired", "g1", 61_000, "")
        .expect("the first ticket expired");
    assert_eq!(pool.consume("old", 70_000, None), None);
    assert!(pool.consume("later", 70_000, None).is_some());
    assert_eq!(old.expires_at, 61_000);
    assert_eq!(later.expires_at, 71_000);
}

#[test]
fn consuming_an_old_ticket_never_makes_a_different_expired_ticket_usable() {
    let mut pool = TicketPool::new(limits(4, 4, 120));
    pool.issue("a", "paired", "g1", 1_000, "").unwrap();
    pool.issue("b", "paired", "g1", 11_000, "").unwrap();
    pool.issue("c", "paired", "g1", 21_000, "").unwrap();
    pool.issue("d", "paired", "g1", 31_000, "").unwrap();
    assert!(pool.consume("a", 31_000, None).is_some());
    // b expires at 71 s; c and d do not.
    assert_eq!(pool.consume("b", 71_000, None), None);
    assert!(pool.consume("c", 71_000, None).is_some());
    assert!(pool.consume("d", 71_000, None).is_some());
}

#[test]
fn consumption_and_expiry_release_all_pending_capacity_while_preserving_later_tickets() {
    let mut pool = TicketPool::new(limits(4, 4, 120));
    pool.issue("a", "paired", "g1", 1_000, "").unwrap();
    pool.issue("b", "paired", "g1", 11_000, "").unwrap();
    pool.issue("c", "paired", "g1", 21_000, "").unwrap();
    pool.issue("d", "paired", "g1", 31_000, "").unwrap();
    assert!(pool.consume("a", 31_000, None).is_some());
    assert!(pool.issue("first", "paired", "g1", 71_000, "").is_ok());
    assert!(pool.issue("second", "paired", "g1", 71_000, "").is_ok());
    // 71 s: a held (c, d, first, second) is four, the cap.
    assert_eq!(
        pool.issue("third", "paired", "g1", 71_000, ""),
        Err(IssueError::TooManyPending)
    );
    for valid in ["c", "d", "first", "second"] {
        assert!(pool.consume(valid, 71_000, None).is_some(), "{valid}");
    }
}

#[test]
fn many_devices_holding_rate_windows_do_not_refuse_a_new_devices_first_ticket() {
    // Ten thousand devices may each hold a 60-second rate window while only a handful of
    // tickets are outstanding; the documented cap is on outstanding tickets, so the next
    // device's first redemption must be allowed. The same case at a test's scale: three
    // devices used their windows, no ticket is live, and a fourth device asks.
    let mut pool = TicketPool::new(limits(3, 3, 5));
    for device in ["a", "b", "c"] {
        let key = format!("{device}-1");
        pool.issue(&key, device, "g", 1_000, "")
            .expect("inside the caps");
        pool.consume(&key, 1_000, None).expect("spent");
    }
    assert_eq!(pool.len(), 0);
    assert_eq!(pool.rate_windows(1_000), 3);
    pool.issue("d-1", "d", "g", 1_000, "")
        .expect("a first redemption is not the rate map's size limit");
}

#[test]
fn an_expired_rate_window_does_not_count_and_the_map_forgets_it() {
    let mut pool = TicketPool::new(limits(10, 10, 2));
    let first = pool.issue("a-1", "a", "g", 1_000, "").unwrap();
    pool.consume("a-1", 1_000, None).expect("spent");
    pool.issue("a-2", "a", "g", 1_000, "").unwrap();
    assert_eq!(
        pool.issue("a-3", "a", "g", 1_000, ""),
        Err(IssueError::RateLimitExceeded)
    );
    // Sixty seconds later the window is gone, and asking about it drops it rather than
    // leaving it to count against the next minute.
    assert_eq!(pool.rate_windows(61_000), 0);
    pool.issue("a-3", "a", "g", 61_000, "")
        .expect("a fresh minute starts a fresh window");
    assert_eq!(first.expires_at, 61_000);
}

#[test]
fn a_ticket_bound_to_another_epoch_or_device_is_left_as_it_was() {
    let mut pool = TicketPool::new(default_ticket_limits());
    pool.issue("key", "device", "g1", 1_000, "relay-a").unwrap();
    assert_eq!(
        pool.consume(
            "key",
            1_000,
            Some(super::TicketBinding {
                epoch: "relay-b",
                device_id: "device",
            })
        ),
        None
    );
    assert_eq!(
        pool.consume(
            "key",
            1_000,
            Some(super::TicketBinding {
                epoch: "relay-a",
                device_id: "another-device",
            })
        ),
        None
    );
    assert_eq!(pool.len(), 1);
    let spent = pool
        .consume(
            "key",
            1_000,
            Some(super::TicketBinding {
                epoch: "relay-a",
                device_id: "device",
            }),
        )
        .expect("the matching binding spends it");
    assert_eq!(spent.epoch, "relay-a");
    assert_eq!(pool.len(), 0);
}

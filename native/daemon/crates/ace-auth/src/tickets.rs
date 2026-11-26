// SPDX-License-Identifier: Apache-2.0
//! Ticket allocation policy, ported from `apps/daemon/src/ticket-pool.ts`: one use each, at most
//! `global` outstanding in all, `perDevice` per device and `perMinute` issued per device, each
//! valid 60 s, bound to the device, the credential generation that asked and the host key epoch
//! that handed it (ADR 0155). Time comes in as an argument, and the pool lives in memory, so a
//! restart voids every outstanding ticket.

use std::collections::{HashMap, HashSet};

/// The three caps (`ticket-pool.ts:3`–`:12`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TicketLimits {
    pub global: usize,
    pub per_device: usize,
    pub per_minute: u32,
}

/// 10,000 outstanding in all, 32 per device, 120 issued per device per minute.
pub const fn default_ticket_limits() -> TicketLimits {
    TicketLimits {
        global: 10_000,
        per_device: 32,
        per_minute: 120,
    }
}

impl Default for TicketLimits {
    fn default() -> Self {
        default_ticket_limits()
    }
}

/// A ticket's lifetime (`ticket-pool.ts:48`): 60 s.
pub const TICKET_TTL_MS: i64 = 60_000;

/// Why allocation was refused; each is answered `429` with these words.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssueError {
    TooManyPending,
    DeviceQuotaExceeded,
    RateLimitExceeded,
}

impl IssueError {
    pub fn message(self) -> &'static str {
        match self {
            Self::TooManyPending => "Too many pending tickets",
            Self::DeviceQuotaExceeded => "Device ticket quota exceeded",
            Self::RateLimitExceeded => "Device ticket rate limit exceeded",
        }
    }
}

/// An allocation's answer: when it expires.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Issued {
    pub expires_at: i64,
}

/// What a spent ticket says: its device, the credential generation that asked, and its epoch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TicketRef {
    pub device_id: String,
    pub generation: String,
    pub epoch: String,
}

/// What a presented ticket must match to be taken (`remote-auth.ts:226`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TicketBinding<'a> {
    pub epoch: &'a str,
    pub device_id: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Ticket {
    device_id: String,
    generation: String,
    expires_at: i64,
    epoch: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Rate {
    count: u32,
    resets_at: i64,
}

/// The pool (`ticket-pool.ts:15`–`:88`). Keys are SHA-256 hashes; the plain ticket never enters.
#[derive(Debug, Clone)]
pub struct TicketPool {
    limits: TicketLimits,
    tickets: HashMap<String, Ticket>,
    owned: HashMap<String, HashSet<String>>,
    rates: HashMap<String, Rate>,
}

impl TicketPool {
    pub fn new(limits: TicketLimits) -> Self {
        Self {
            limits,
            tickets: HashMap::new(),
            owned: HashMap::new(),
            rates: HashMap::new(),
        }
    }

    pub fn limits(&self) -> TicketLimits {
        self.limits
    }

    /// Allocate `key` to `device_id`, or refuse with one of the three caps.
    pub fn issue(
        &mut self,
        key: &str,
        device_id: &str,
        generation: &str,
        now: i64,
        epoch: &str,
    ) -> Result<Issued, IssueError> {
        self.evict(now);
        if self.tickets.len() >= self.limits.global {
            return Err(IssueError::TooManyPending);
        }
        if self.owned.get(device_id).map_or(0, HashSet::len) >= self.limits.per_device {
            return Err(IssueError::DeviceQuotaExceeded);
        }
        let existing = self.rates.get(device_id).copied();
        let mut rate = existing.unwrap_or(Rate {
            count: 0,
            resets_at: now + TICKET_TTL_MS,
        });
        if rate.count >= self.limits.per_minute
            || (existing.is_none() && self.rates.len() >= self.limits.global)
        {
            return Err(IssueError::RateLimitExceeded);
        }
        rate.count += 1;
        self.rates.insert(device_id.to_owned(), rate);
        let expires_at = now + TICKET_TTL_MS;
        self.tickets.insert(
            key.to_owned(),
            Ticket {
                device_id: device_id.to_owned(),
                generation: generation.to_owned(),
                expires_at,
                epoch: epoch.to_owned(),
            },
        );
        self.owned
            .entry(device_id.to_owned())
            .or_default()
            .insert(key.to_owned());
        Ok(Issued { expires_at })
    }

    /// Take `key` once. With `bound`, a ticket whose epoch or device differs is left as it was:
    /// a message that would be refused spends nothing (`remote-auth.ts:224`–`:231`).
    pub fn consume(
        &mut self,
        key: &str,
        now: i64,
        bound: Option<TicketBinding<'_>>,
    ) -> Option<TicketRef> {
        self.evict(now);
        if let Some(bound) = bound {
            let held = self.tickets.get(key);
            let matches = held.is_some_and(|ticket| {
                ticket.epoch == bound.epoch && ticket.device_id == bound.device_id
            });
            if !matches {
                return None;
            }
        }
        let ticket = self.tickets.remove(key)?;
        self.disown(&ticket.device_id, key);
        Some(TicketRef {
            device_id: ticket.device_id,
            generation: ticket.generation,
            epoch: ticket.epoch,
        })
    }

    /// Drop every outstanding ticket and rate window of a device (`revoke`).
    pub fn revoke(&mut self, device_id: &str) {
        if let Some(keys) = self.owned.remove(device_id) {
            for key in keys {
                self.tickets.remove(&key);
            }
        }
        self.rates.remove(device_id);
    }

    /// How many tickets are outstanding now, for a cap check and for tests.
    pub fn len(&self) -> usize {
        self.tickets.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tickets.is_empty()
    }

    fn evict(&mut self, now: i64) {
        let expired: Vec<String> = self
            .tickets
            .iter()
            .filter(|(_, ticket)| ticket.expires_at <= now)
            .map(|(key, _)| key.clone())
            .collect();
        for key in expired {
            if let Some(ticket) = self.tickets.remove(&key) {
                self.disown(&ticket.device_id, &key);
            }
        }
        self.rates.retain(|_, rate| rate.resets_at > now);
    }

    fn disown(&mut self, device_id: &str, key: &str) {
        if let Some(keys) = self.owned.get_mut(device_id) {
            keys.remove(key);
            if keys.is_empty() {
                self.owned.remove(device_id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
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
}

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
        // The three caps are the documented ones (`ticket-pool.ts:8`-`:12`, behaviour.md §6):
        // outstanding tickets in all (checked above), outstanding per device, and issued per
        // device per minute. This check is the minute's, and only the minute's: the TypeScript
        // also refused a device's *first* ticket once `rates.size` reached `global`, which is
        // the rate map's size rather than the cap on outstanding tickets, so a minute in which
        // enough other devices had asked refused a fresh device. Live tickets are the cap
        // (review P1), and the map is bounded by the devices that asked in the last minute.
        self.evict_rates(now);
        let mut rate = self.rates.get(device_id).copied().unwrap_or(Rate {
            count: 0,
            resets_at: now + TICKET_TTL_MS,
        });
        if rate.count >= self.limits.per_minute {
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

    /// The live per-minute windows at `now`. An expired window is dropped as it is asked about,
    /// so it never counts against a later minute.
    pub fn rate_windows(&mut self, now: i64) -> usize {
        self.evict_rates(now);
        self.rates.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tickets.is_empty()
    }

    /// Drop the per-minute windows that ran out. Called before every rate check as well as by
    /// `evict`, so a window is never counted in a minute it did not issue in.
    fn evict_rates(&mut self, now: i64) {
        self.rates.retain(|_, rate| rate.resets_at > now);
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
mod tests;

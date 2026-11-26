// SPDX-License-Identifier: Apache-2.0
//! Ticket allocation policy, ported from `apps/daemon/src/ticket-pool.ts`: one use each, at most
//! `global` outstanding in all, `perDevice` per device and `perMinute` issued per device, each
//! valid 60 s, bound to the device, the credential generation that asked and the host key epoch
//! that handed it (ADR 0155). Time comes in as an argument, and the pool lives in memory, so a
//! restart voids every outstanding ticket.

use std::collections::{HashMap, HashSet};

use ace_core::expiry_map::ExpiryMap;

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
    epoch: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Rate {
    count: u32,
    resets_at: i64,
}

/// The pool (`ticket-pool.ts:15`–`:88`). Keys are SHA-256 hashes; the plain ticket never enters.
/// Tickets and rate windows live in the expiry heap `ticket-pool.ts` uses, so a lookup evicts only
/// entries that are due: a miss with `n` live entries costs `log n`, never a walk of every one
/// (`expiry-map.ts:40`–`:42`).
pub struct TicketPool {
    limits: TicketLimits,
    tickets: ExpiryMap<Ticket>,
    owned: HashMap<String, HashSet<String>>,
    rates: ExpiryMap<Rate>,
}

impl std::fmt::Debug for TicketPool {
    /// Outstanding counts only; no hash of a ticket is a credential, but a pool's size is what a
    /// test or a diagnostic wants, and the entries stay private.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TicketPool")
            .field("limits", &self.limits)
            .field("tickets", &self.tickets.len())
            .field("rates", &self.rates.len())
            .field("devices", &self.owned.len())
            .finish()
    }
}

impl TicketPool {
    pub fn new(limits: TicketLimits) -> Self {
        Self {
            limits,
            tickets: ExpiryMap::new(),
            owned: HashMap::new(),
            rates: ExpiryMap::new(),
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
        // The three caps, exactly as `ticket-pool.ts:37`-`:45` applies them: outstanding tickets
        // in all, per device, and this device's minute. The last clause is the TypeScript's own:
        // a device's first ticket in a minute is refused once the rate map itself has reached
        // `global` windows, so the map can't grow past that cap.
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
        self.rates.set(device_id.to_owned(), rate, rate.resets_at);
        let expires_at = now + TICKET_TTL_MS;
        self.tickets.set(
            key.to_owned(),
            Ticket {
                device_id: device_id.to_owned(),
                generation: generation.to_owned(),
                epoch: epoch.to_owned(),
            },
            expires_at,
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
        let ticket = self.tickets.delete(key)?;
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
                self.tickets.delete(&key);
            }
        }
        self.rates.delete(device_id);
    }

    /// How many tickets are outstanding now, for a cap check and for tests.
    pub fn len(&self) -> usize {
        self.tickets.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tickets.is_empty()
    }

    /// Drop what is due at `now`. The heaps stop at the first unexpired entry, so this visits only
    /// entries that actually ended (`expiry-map.ts:40`–`:42`).
    fn evict(&mut self, now: i64) {
        for (key, ticket) in self.tickets.expire(now) {
            self.disown(&ticket.device_id, &key);
        }
        self.rates.expire(now);
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

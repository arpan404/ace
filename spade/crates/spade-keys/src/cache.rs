//! Secrets Spade has already read, kept in this process's memory for its life (ADR 0119
//! amendment 1), so the keychain is asked for each one once: a read the keychain's access list
//! doesn't cover puts up a prompt, and a prompt on every model call is what this stops.
//!
//! Only Spade's own API changes an entry, so only Spade's own changes invalidate one. A read that
//! was out while Spade changed the same entry is dropped, since its answer may be from before the
//! change. Missing entries are not remembered: looking one up never prompts, and a key another
//! tool added is then still found.

use std::collections::HashMap;
use std::sync::Mutex;

use zeroize::Zeroizing;

#[derive(Default)]
pub(crate) struct Cache {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    values: HashMap<String, Zeroizing<String>>,
    /// How many times Spade has changed each entry in this process.
    changes: HashMap<String, u64>,
}

/// Where an entry stood when a read of it started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Ticket(u64);

impl Cache {
    /// The remembered secret of `account`, or a ticket to remember what the keychain says.
    pub(crate) fn lookup(&self, account: &str) -> Result<String, Ticket> {
        let state = self.lock();
        match state.values.get(account) {
            Some(value) => Ok(value.as_str().to_owned()),
            None => Err(Ticket(state.changes.get(account).copied().unwrap_or(0))),
        }
    }

    /// Remembers what a read started with `ticket` found, unless Spade changed the entry since.
    /// Returns whether it did: if not, the read's answer may be stale.
    pub(crate) fn fill(&self, account: &str, ticket: Ticket, value: &str) -> bool {
        let mut state = self.lock();
        let current = state.changes.get(account).copied().unwrap_or(0) == ticket.0;
        if current {
            state
                .values
                .insert(account.to_owned(), Zeroizing::new(value.to_owned()));
        }
        current
    }

    /// Whether Spade has left `account` alone since `ticket` was taken.
    pub(crate) fn unchanged(&self, account: &str, ticket: Ticket) -> bool {
        self.lock().changes.get(account).copied().unwrap_or(0) == ticket.0
    }

    /// Spade stored `value` for `account`.
    pub(crate) fn put(&self, account: &str, value: &str) {
        let mut state = self.lock();
        *state.changes.entry(account.to_owned()).or_default() += 1;
        state
            .values
            .insert(account.to_owned(), Zeroizing::new(value.to_owned()));
    }

    /// Spade removed `account`, or changed it and doesn't know what the keychain now holds.
    pub(crate) fn forget(&self, account: &str) {
        let mut state = self.lock();
        *state.changes.entry(account.to_owned()).or_default() += 1;
        state.values.remove(account);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }
}

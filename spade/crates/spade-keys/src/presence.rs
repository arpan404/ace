//! Whether each endpoint has a key, as the keychain last said, for screens that must answer at
//! once. A keychain read can wait on a prompt for as long as the person leaves it open; a list of
//! endpoints never waits with it.

use std::collections::{HashMap, HashSet};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
pub(crate) struct Presence {
    state: Mutex<State>,
    answered: Condvar,
}

#[derive(Default)]
struct State {
    /// What the last read of each endpoint's key said.
    known: HashMap<String, bool>,
    /// Endpoints a read is out for.
    reading: HashSet<String>,
    /// Endpoints whose key Spade changed while a read was out: that read's answer may be from
    /// before the change, so it is dropped.
    changed: HashSet<String>,
}

impl Presence {
    /// Records what a read (or a change Spade made) says about `endpoint`'s key.
    pub(crate) fn note(&self, endpoint: &str, present: bool) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.known.insert(endpoint.to_owned(), present);
        if state.reading.contains(endpoint) {
            state.changed.insert(endpoint.to_owned());
        }
        drop(state);
        self.answered.notify_all();
    }

    /// Claims the read of `endpoint`, unless one is already out.
    pub(crate) fn claim(&self, endpoint: &str) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.reading.insert(endpoint.to_owned())
    }

    /// Gives up the claim on `endpoint` without an answer.
    pub(crate) fn release(&self, endpoint: &str) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.reading.remove(endpoint);
        state.changed.remove(endpoint);
    }

    /// The claimed read of `endpoint` ended: with an answer, or without one (an error, which
    /// reads as no key, as every key lookup treats it).
    pub(crate) fn done(&self, endpoint: &str, present: bool) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.reading.remove(endpoint);
        if !state.changed.remove(endpoint) {
            state.known.insert(endpoint.to_owned(), present);
        }
        drop(state);
        self.answered.notify_all();
    }

    /// What is known of each of `endpoints`, waiting until `deadline` for those not known yet.
    pub(crate) fn known_by(&self, endpoints: &[&str], deadline: Instant) -> Vec<Option<bool>> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        loop {
            let all = endpoints.iter().all(|e| state.known.contains_key(*e));
            let left = deadline.saturating_duration_since(Instant::now());
            if all || left == Duration::ZERO {
                return endpoints
                    .iter()
                    .map(|e| state.known.get(*e).copied())
                    .collect();
            }
            state = match self.answered.wait_timeout(state, left) {
                Ok((state, _)) => state,
                Err(poisoned) => poisoned.into_inner().0,
            };
        }
    }
}

// SPDX-License-Identifier: Apache-2.0
//! One ordered queue per instance for the work that changes its stored choices
//! (`catalog.ts` `#sessionTails`).
//!
//! A place is taken when the work is accepted, before any await, so the work is built on
//! what the place before it left: session writes, a discovery's commit, and an account
//! revocation's deletion all take their place in the same queue. A place belongs to the
//! catalog rather than to the caller that asked for it, so nothing behind it is stranded
//! when that caller goes away.

use std::collections::VecDeque;

use crate::catalog::Catalog;
use crate::signals::Gate;

/// The places taken for one instance, oldest first.
#[derive(Default)]
pub(crate) struct Turns {
    places: VecDeque<Place>,
    next: u64,
}

struct Place {
    token: u64,
    gate: Gate,
    settled: bool,
}

impl Turns {
    /// The gate the last accepted place opens, which close drains.
    pub(crate) fn tail(&self) -> Option<Gate> {
        self.places.back().map(|place| place.gate.clone())
    }

    pub(crate) fn accept(&mut self) -> (u64, Gate, Option<Gate>) {
        let previous = self.places.back().map(|place| place.gate.clone());
        self.next += 1;
        let token = self.next;
        let gate = Gate::new();
        self.places.push_back(Place {
            token,
            gate: gate.clone(),
            settled: false,
        });
        (token, gate, previous)
    }

    /// Settles one place and reports whether the queue is empty afterwards.
    pub(crate) fn settle(&mut self, token: u64) -> bool {
        if let Some(place) = self.places.iter_mut().find(|place| place.token == token) {
            place.settled = true;
        }
        self.advance();
        self.places.is_empty()
    }

    /// Opens a finished place once every place before it finished, in order. A place whose
    /// caller went away keeps its gate shut until then, so later work never passes the
    /// write the place before it is still running.
    fn advance(&mut self) {
        while self.places.front().is_some_and(|place| place.settled) {
            if let Some(place) = self.places.pop_front() {
                place.gate.open();
            }
        }
    }
}

/// One accepted place in an instance's queue: waited for its turn, then settled by its drop.
pub(crate) struct Turn {
    catalog: Catalog,
    id: String,
    token: u64,
    previous: Option<Gate>,
    waited: bool,
}

impl Turn {
    pub(crate) fn new(catalog: Catalog, id: String, token: u64, previous: Option<Gate>) -> Self {
        Self {
            catalog,
            id,
            token,
            previous,
            waited: false,
        }
    }

    /// Waits for every place before this one, once however often it is polled.
    pub(crate) async fn wait(&mut self) {
        if self.waited {
            return;
        }
        self.waited = true;
        if let Some(previous) = self.previous.take() {
            previous.wait().await;
        }
    }
}

impl Drop for Turn {
    fn drop(&mut self) {
        self.catalog.settle_turn(&self.id, self.token);
    }
}

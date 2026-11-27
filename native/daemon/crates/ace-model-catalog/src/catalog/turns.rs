// SPDX-License-Identifier: Apache-2.0
//! One ordered queue per instance for the work that changes its stored choices
//! (`catalog.ts` `#sessionTails`).
//!
//! A place is taken when the work is accepted. The actor alone decides when a place is
//! front and ready: an external hold waits for its grant, a queued write runs, and a
//! deletion runs after the flight it drains. A caller that goes away settles its hold;
//! catalog-owned work keeps its place until the actor finishes it.

use std::collections::VecDeque;

use crate::catalog::{Catalog, PendingOp};
use crate::signals::Gate;

/// One step the actor takes on an instance's queue.
pub(crate) enum Step {
    /// Run this place's catalog-owned work.
    Run(u64, PendingOp),
    /// Grant this external holder its turn.
    Grant(futures::channel::oneshot::Sender<()>),
    /// The front place waits for a later message.
    Idle,
    /// The queue is empty.
    Empty,
}

/// The places taken for one instance, oldest first.
#[derive(Default)]
pub(crate) struct Turns {
    places: VecDeque<Place>,
    next: u64,
}

pub(crate) struct Place {
    pub(crate) token: u64,
    /// Opened once this place is done, so a removal can wait out the tail it captured.
    pub(crate) done: Gate,
    /// The external holder's grant, if this place belongs to `hold_turn`.
    pub(crate) grant: Option<futures::channel::oneshot::Sender<()>>,
    /// The catalog-owned work this place runs, if any.
    pub(crate) op: Option<PendingOp>,
    /// Whether the op may run once it reaches the front.
    pub(crate) ready: bool,
    pub(crate) settled: bool,
}

impl Turns {
    pub(crate) fn tail(&self) -> Option<Gate> {
        self.places.back().map(|place| place.done.clone())
    }

    /// Takes a place for an external holder, which the actor grants once it is front.
    pub(crate) fn hold(&mut self) -> (u64, futures::channel::oneshot::Receiver<()>) {
        let (grant, receiver) = futures::channel::oneshot::channel();
        let (token, _gate) = self.push(None, false);
        if let Some(place) = self.places.back_mut() {
            place.grant = Some(grant);
        }
        (token, receiver)
    }

    /// Takes a place with no grant and no work: `reserve_turn` only reserves order.
    pub(crate) fn reserve(&mut self) -> u64 {
        let (token, _gate) = self.push(None, false);
        token
    }

    /// Takes a place for catalog-owned work that is ready as soon as it is accepted.
    pub(crate) fn accept(&mut self, op: PendingOp) -> u64 {
        let (token, _gate) = self.push(Some(op), true);
        token
    }

    /// Takes a place for catalog-owned work that becomes ready on a later message.
    pub(crate) fn accept_when_ready(&mut self, op: PendingOp) -> u64 {
        let (token, _gate) = self.push(Some(op), false);
        token
    }

    fn push(&mut self, op: Option<PendingOp>, ready: bool) -> (u64, Gate) {
        self.next += 1;
        let token = self.next;
        let gate = Gate::new();
        self.places.push_back(Place {
            token,
            done: gate.clone(),
            grant: None,
            op,
            ready,
            settled: false,
        });
        (token, gate)
    }

    /// Marks a place ready (a deletion's flight settled) without changing its order.
    pub(crate) fn mark_ready(&mut self, token: u64) {
        if let Some(place) = self.places.iter_mut().find(|place| place.token == token) {
            place.ready = true;
        }
    }

    /// Settles one place. The caller then pumps the instance.
    pub(crate) fn settle(&mut self, token: u64) {
        if let Some(place) = self.places.iter_mut().find(|place| place.token == token) {
            place.settled = true;
        }
    }

    /// The front place, when it is still waiting for its op to become ready.
    /// Removes a finished front place, opening its gate.
    pub(crate) fn pop_settled(&mut self) {
        while self.places.front().is_some_and(|place| place.settled) {
            if let Some(place) = self.places.pop_front() {
                place.done.open();
            }
        }
    }

    /// Takes every queued discovery commit out of the queue without running it. Close uses
    /// this so a result that has not taken its place yet can never write after shutdown.
    pub(crate) fn discard_flight_commits(&mut self) -> Vec<(String, u64)> {
        let mut discarded = Vec::new();
        for place in &mut self.places {
            if !matches!(place.op, Some(PendingOp::FlightCommit(_))) {
                continue;
            }
            if let Some(PendingOp::FlightCommit(commit)) = place.op.take() {
                place.settled = true;
                discarded.push((commit.id.clone(), commit.token));
            }
        }
        discarded
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.places.is_empty()
    }

    /// The next thing the actor should do for this queue.
    pub(crate) fn step(&mut self) -> Step {
        self.pop_settled();
        let Some(front) = self.places.front_mut() else {
            return Step::Empty;
        };
        if front.op.is_some() && front.ready {
            front.ready = false;
            let Some(op) = front.op.take() else {
                return Step::Idle;
            };
            return Step::Run(front.token, op);
        }
        if front.op.is_none()
            && let Some(grant) = front.grant.take()
        {
            return Step::Grant(grant);
        }
        Step::Idle
    }
}

/// One accepted place in an instance's queue: waited for its turn, then settled by its drop.
pub(crate) struct Turn {
    catalog: Catalog,
    id: String,
    token: u64,
    armed: bool,
}

impl Turn {
    pub(crate) fn new(catalog: Catalog, id: String, token: u64) -> Self {
        Self {
            catalog,
            id,
            token,
            armed: true,
        }
    }

    /// A place that could not be taken because the actor is gone.
    pub(crate) fn detached(catalog: Catalog, id: String) -> Self {
        Self {
            catalog,
            id,
            token: 0,
            armed: false,
        }
    }
}

impl Drop for Turn {
    fn drop(&mut self) {
        if self.armed {
            self.catalog.settle_turn(&self.id, self.token);
        }
    }
}

/// A hold that has not been granted yet. Dropped while waiting, it settles its place so
/// nothing behind it is stranded.
pub(crate) struct PendingTurn {
    pub(crate) catalog: Catalog,
    pub(crate) id: String,
    pub(crate) token: u64,
    pub(crate) armed: bool,
}

impl Drop for PendingTurn {
    fn drop(&mut self) {
        if self.armed {
            self.catalog.settle_turn(&self.id, self.token);
        }
    }
}

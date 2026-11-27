// SPDX-License-Identifier: Apache-2.0
//! Shutdown (`catalog.ts` `close`), the counted bounds admission tracks, and the guards
//! that keep both owned by the catalog when a caller goes away.

use crate::catalog::{Cancel, Catalog, CatalogError, turns};

/// A counted bound: the places the catalog admits for one kind of work, held for as long
/// as that work exists and released whichever way its caller leaves.
pub(crate) struct CapacitySlot {
    catalog: Catalog,
    kind: Capacity,
    count: usize,
}

/// The counted bounds admission tracks.
#[derive(Clone, Copy)]
pub(crate) enum Capacity {
    SessionWrites,
    Invalidations,
}

impl CapacitySlot {
    /// Takes one place, which the work itself has not counted yet.
    pub(crate) fn take(catalog: &Catalog, kind: Capacity) -> Self {
        catalog.with_inner(|inner| match kind {
            Capacity::SessionWrites => inner.session_writes += 1,
            Capacity::Invalidations => inner.invalidations += 1,
        });
        Self::claim(catalog, kind, 1)
    }

    /// Gives back places admission already counted, once the work holding them settles.
    pub(crate) fn claim(catalog: &Catalog, kind: Capacity, count: usize) -> Self {
        Self {
            catalog: catalog.clone(),
            kind,
            count,
        }
    }

    /// Moves some of this guard's places to a guard that settles with its own work.
    pub(crate) fn share(&mut self, count: usize) -> Self {
        self.count = self.count.saturating_sub(count);
        Self::claim(&self.catalog, self.kind, count)
    }
}

impl Drop for CapacitySlot {
    fn drop(&mut self) {
        self.catalog.with_inner(|inner| match self.kind {
            Capacity::SessionWrites => {
                inner.session_writes = inner.session_writes.saturating_sub(self.count);
            }
            Capacity::Invalidations => {
                inner.invalidations = inner.invalidations.saturating_sub(self.count);
            }
        });
    }
}

/// The gates of the places every instance's queue still holds, which close drains.
fn turn_tails(catalog: &Catalog) -> Vec<crate::signals::Gate> {
    catalog.with_inner(|inner| {
        inner
            .turns
            .values()
            .filter_map(turns::Turns::tail)
            .collect()
    })
}

impl Catalog {
    /// Shuts the catalog down: abort flights, drain every owned unit of work, flush
    /// deletions, close storage. Concurrent callers share one attempt and its result.
    pub async fn close(&self) -> Result<(), CatalogError> {
        enum Plan {
            Done(Result<(), CatalogError>),
            Wait(crate::signals::Gate),
            Drain(CloseDrain),
        }
        let plan = self.with_inner(|inner| {
            if let Some(result) = &inner.close_result {
                if result.is_ok() {
                    return Plan::Done(Ok(()));
                }
                // Storage was never closed: a later close retries the deletions.
                inner.close_result = None;
            }
            if let Some(gate) = &inner.close_gate {
                return Plan::Wait(gate.clone());
            }
            inner.closed = true;
            inner.listeners.clear();
            // Every probe is aborted before anything is awaited, so a probe waiting on
            // its own signal returns and its gate opens.
            for signal in inner.probe_signals.drain(..) {
                signal.abort();
            }
            let observed = inner.observed_check.take();
            for state in inner.states.values() {
                if let Some(abort) = &state.abort {
                    abort.abort();
                }
            }
            // The work registry, not the rows: a removal or flush that outlived its row
            // still holds close until it settles.
            let mut work = inner.owned.clone();
            work.extend(inner.turns.values().filter_map(turns::Turns::tail));
            work.append(&mut inner.accepted_writes);
            inner.close_gate = Some(crate::signals::Gate::new());
            Plan::Drain(CloseDrain {
                catalog: self.clone(),
                work,
                observed,
                done: false,
                handed: false,
            })
        });
        match plan {
            Plan::Done(result) => result,
            Plan::Wait(gate) => {
                gate.wait().await;
                self.with_inner(|inner| inner.close_result.clone().unwrap_or(Ok(())))
            }
            Plan::Drain(drain) => drain.run().await,
        }
    }

    /// Publishes a close's result and settles every later close with it.
    fn conclude_close(&self, result: &Result<(), CatalogError>) {
        self.with_inner(|inner| {
            inner.close_result = Some(result.clone());
            if let Some(gate) = inner.close_gate.take() {
                gate.open();
            }
        });
    }

    /// The last steps of a close, once every unit of work settled.
    fn finish_close(&self) -> Result<(), CatalogError> {
        let deletions = self.with_inner(|inner| inner.deletions.flush());
        deletions?;
        let mut storage = self.storage.clone();
        storage.close().map_err(CatalogError::Cache)?;
        Ok(())
    }
}

/// One close attempt's drain. The work was collected when the close began; a caller that
/// goes away hands the rest to the spawner, so storage still closes only after that work
/// settled.
struct CloseDrain {
    catalog: Catalog,
    work: Vec<crate::signals::Gate>,
    observed: Option<Cancel>,
    done: bool,
    handed: bool,
}

impl CloseDrain {
    async fn run(mut self) -> Result<(), CatalogError> {
        self.drain().await;
        self.done = true;
        let result = self.catalog.finish_close();
        self.catalog.conclude_close(&result);
        result
    }

    async fn drain(&mut self) {
        if let Some(cancel) = self.observed.take() {
            cancel();
        }
        for unit in std::mem::take(&mut self.work) {
            unit.wait().await;
        }
        // Accepted session writes are drained before storage closes.
        for tail in turn_tails(&self.catalog) {
            tail.wait().await;
        }
    }
}

impl Drop for CloseDrain {
    fn drop(&mut self) {
        if self.done || self.handed {
            return;
        }
        let catalog = self.catalog.clone();
        let spawn = self.catalog.options.spawn.clone();
        let work = std::mem::take(&mut self.work);
        let observed = self.observed.take();
        spawn.spawn(Box::pin(async move {
            let drain = CloseDrain {
                catalog,
                work,
                observed,
                done: false,
                handed: true,
            };
            let _ = drain.run().await;
        }));
    }
}

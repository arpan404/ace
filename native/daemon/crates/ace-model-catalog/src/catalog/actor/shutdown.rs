// SPDX-License-Identifier: Apache-2.0
//! Shuts command ingress before handling operation owners and storage.

use super::{Actor, TaskKind};
use crate::catalog::{CatalogError, Reply};
use crate::signals::Signal;

impl Actor {
    pub(super) fn close(&mut self, reply: Reply<Result<(), CatalogError>>) {
        let recorded = self
            .close_result
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if let Some(result) = recorded {
            if result.is_ok() {
                let _ = reply.send(Ok(()));
                return;
            }
            // Storage was never closed: a later close retries the deletions.
            *self
                .close_result
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        }
        self.close_waiters.retain(|waiter| !waiter.is_canceled());
        if self.close_waiters.len() >= crate::catalog::WAITER_LIMIT {
            let _ = reply.send(Err(CatalogError::Busy));
            return;
        }
        self.close_waiters.push(reply);
        if self.closing {
            return;
        }
        if let Some(ingress) = self.commands.upgrade() {
            ingress.close();
        }
        self.inner.closed = true;
        self.inner.listeners.clear();
        let probes: Vec<(String, u64)> = self
            .probe_rows
            .iter()
            .map(|(token, id)| (id.clone(), *token))
            .collect();
        for (id, token) in probes {
            self.abort_probe(&id, token);
        }
        let aborts: Vec<Signal> = self
            .inner
            .states
            .values()
            .filter_map(|state| state.abort.clone())
            .collect();
        for abort in aborts {
            abort.abort();
        }
        let ids: Vec<_> = self.inner.turns.keys().cloned().collect();
        for id in &ids {
            self.cancel_replace(id);
            if let Some(turns) = self.inner.turns.get_mut(id) {
                let (sessions, permissions) = turns.cancel_queued_writes();
                self.inner.session_writes -= permissions + sessions.len();
                for session in sessions {
                    let _ = session.reply.send(Err(CatalogError::Closed));
                }
            }
        }
        let queued: Vec<_> = self
            .inner
            .row_flights
            .iter()
            .flat_map(|(id, flights)| {
                flights
                    .iter()
                    .filter(|flight| self.commit_tokens.contains(&flight.token))
                    .map(|flight| (id.clone(), flight.token))
            })
            .collect();
        for (id, token) in queued {
            self.cancel_commit(&id, token);
        }
        for id in ids {
            self.pump(&id);
        }
        self.cancel_unsubmitted_tasks();
        self.closing = true;
        self.finish_close_if_ready();
    }

    fn cancel_unsubmitted_tasks(&mut self) {
        let cancelled: Vec<_> = self
            .in_flight
            .iter()
            .filter(|(_, (kind, control))| {
                matches!(kind, TaskKind::Reconcile) || control.cancel_unsubmitted()
            })
            .map(|(task, (kind, _))| (*task, kind.clone()))
            .collect();
        for (task, kind) in cancelled {
            if let TaskKind::Removal { id, token } = kind {
                self.removal_ready(&id, token);
            }
            self.task_settled(task);
        }
    }
}

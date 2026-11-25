// SPDX-License-Identifier: Apache-2.0
//! The host's ordered publication: every effect an input decides waits in one
//! queue, and one caller at a time hands it to the shell. Two inputs never
//! swap the effects they decided, so a settlement a timer decided is never
//! published after the exit a pipe close decided later (`bridge.rs`'s ordered
//! publication, ADR 0223 §7 rule 3).

use super::*;

/// The effects one host decided, waiting for the shell in decision order.
///
/// An input's effects join the queue while the host still holds its lock, so
/// the queue's order is the order in which the host decided them. Exactly one
/// caller drains it at a time, and a decision made while the drain runs (a
/// write acknowledged, a stop answered) joins the queue and follows the
/// effects already decided.
#[derive(Default)]
pub(super) struct Publication {
    queue: VecDeque<HostEffect>,
    /// Set once the shell has given the host its sink.
    sink: Option<Arc<dyn HostSink>>,
    publishing: bool,
}

/// What a shell does with the effects the host decides: it applies one effect
/// at a time, in the order `effect` is called, and it may run another input
/// from inside a call (acknowledging a write, reporting a failed stop), whose
/// effects follow.
pub trait HostSink: Send + Sync {
    fn effect(&self, host: &Host, effect: HostEffect);
}

impl Host {
    /// The shell takes its effects from now on. Everything the host decided
    /// before this is published first, in the order it decided it.
    pub fn set_sink(&self, sink: Arc<dyn HostSink>) {
        let publish = {
            let mut publication = self.publication();
            publication.sink = Some(sink);
            self.claim(&mut publication)
        };
        if publish {
            self.publish();
        }
    }

    pub(super) fn publication(&self) -> MutexGuard<'_, Publication> {
        self.publication
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    /// Runs one input under the host's lock, then publishes what it decided in
    /// the order the host decided it. Another input that decides meanwhile
    /// joins the same queue, so the two never swap their effects.
    pub(super) fn input<T>(&self, run: impl FnOnce(&mut Inner) -> T) -> T {
        let (result, publish) = {
            let mut inner = self.lock();
            let result = run(&mut inner);
            let mut publication = self.publication();
            publication.queue.extend(inner.out.drain(..));
            (result, self.claim(&mut publication))
        };
        if publish {
            self.publish();
        }
        result
    }

    /// Takes the publication turn when nobody holds it and there is something
    /// to hand over, and a sink to hand it to.
    fn claim(&self, publication: &mut Publication) -> bool {
        if publication.publishing || publication.sink.is_none() || publication.queue.is_empty() {
            return false;
        }
        publication.publishing = true;
        true
    }

    /// Hands the queued effects to the sink, one at a time, in order, until
    /// the queue is empty. A decision made from inside an effect joins this
    /// same queue and follows the effects already decided.
    fn publish(&self) {
        loop {
            let next = {
                let mut publication = self.publication();
                let Some(sink) = publication.sink.clone() else {
                    publication.publishing = false;
                    return;
                };
                match publication.queue.pop_front() {
                    Some(effect) => (sink, effect),
                    None => {
                        publication.publishing = false;
                        return;
                    }
                }
            };
            next.0.effect(self, next.1);
        }
    }
}

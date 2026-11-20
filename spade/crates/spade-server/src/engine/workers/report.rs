//! Workers' reports and their queue (ADR 0161). When a worker bot settles (nothing of it runs,
//! its task won't carry on by itself), Spade stores one `worker_reported` in its parent's
//! conversation, which the parent's model reads like a job's result. The engine's delivery
//! stores each worker's report of each state once, under the record lock, so a check run twice
//! (or again after a restart) adds nothing. A worker made while its parent's workers are all
//! busy waits queued, its brief held, and starts as one settles.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use spade_core::Event;
use spade_core::event::Known;
use spade_core::goal::verify::{self, Claim};
use spade_core::task::{self, Next};
use spade_core::tree::{self, Around, Kind, Report};

use super::super::Engine;
use super::super::roster::State;

impl Engine {
    /// Checks worker `id`: starts it if it is queued and a slot is free, and reports it to its
    /// parent if it has settled.
    pub(super) fn check_worker(self: &Arc<Self>, id: &str) {
        let Some(link) = self.worker_link(id) else {
            return;
        };
        if self.deleting(id) || self.deleting(&link.parent_conversation) {
            return;
        }
        if self.worker_queued(id) {
            self.admit_queued(&link.parent_conversation);
            return;
        }
        let Ok(events) = self.load(id) else { return };
        let around = self.around(id, &events);
        let Some(settled) = tree::settled(&events, around) else {
            return;
        };
        let Ok(Some(agent)) = self.store.agent_for_conversation(id) else {
            return;
        };
        let report = Event::Known(Known::WorkerReported(Report {
            worker: agent.id,
            kind: Kind::Bot,
            name: agent.name,
            state: settled.state,
            epoch: settled.epoch,
            summary: settled.summary,
            words: settled.words,
        }));
        match self.deliver_as(&link.parent_conversation, &report, None) {
            Ok(_) => {}
            // Its parent is gone or being deleted: nobody to tell.
            Err(spade_store::StoreError::NoConversation(_)) => {}
            Err(error) => tracing::error!(%error, "could not report a worker to its parent"),
        }
        // A settled worker frees a slot for a queued one.
        self.admit_queued(&link.parent_conversation);
    }

    /// What the worker's events don't say about whether it settled.
    fn around(&self, id: &str, events: &[Event]) -> Around {
        let mut around = Around::default();
        for child in self.worker_children(id) {
            match self.node_state(&child, 1) {
                State::Waiting => around.children_waiting = true,
                State::Working | State::Sleeping => around.children_working = true,
                // Paused by the person: it holds, and holds nothing of its maker's up.
                State::Idle | State::Paused => {}
            }
        }
        for child in tree::ace_children(events) {
            around.children_waiting |= child.state.waiting();
            around.children_working |= child.state.working();
        }
        around.carries_on = self.continuing(id, false)
            || matches!(task::next(events, &self.limits.task), Next::Continue { .. })
            || !matches!(verify::claim(events), Claim::None);
        around
    }

    /// Starts `parent`'s queued workers, oldest first, while fewer than the setting's number of
    /// its workers work. Nothing starts while Spade is closing.
    pub(super) fn admit_queued(self: &Arc<Self>, parent: &str) {
        // One admission at a time, so a brief is never delivered twice.
        let _one = super::lock(&self.workers.admitting);
        if !self.admission.load(Ordering::SeqCst) || self.deleting(parent) {
            return;
        }
        let children = self.worker_children(parent);
        let most = match self.limits.workers_at_once {
            0 => usize::MAX,
            n => n,
        };
        // A packaged bot's own bound, under the machine's (ADR 0200 §3.6).
        let most = self
            .package_workers_at_once(parent)
            .map_or(most, |own| own.min(most));
        let mut busy = children
            .iter()
            .filter(|c| {
                !self.worker_queued(c)
                    && matches!(self.node_state(c, 1), State::Working | State::Sleeping)
            })
            .count();
        for child in children {
            if busy >= most {
                break;
            }
            if !self.worker_queued(&child) || self.deleting(&child) {
                continue;
            }
            let Some(link) = self.worker_link(&child) else {
                continue;
            };
            let brief = self.brief_message(&child, &link);
            match self.deliver(&child, &brief) {
                Ok(()) => busy += 1,
                Err(error) => tracing::error!(%error, "could not start a queued worker"),
            }
        }
    }
}

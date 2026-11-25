// SPDX-License-Identifier: Apache-2.0
//! Stopping: a retire, a channel's detach, and the interrupts it needs.

use super::*;

impl Inner {
    /// The turns this channel is still running, by thread.
    pub(super) fn live_turns(&self, tenant: u64) -> Vec<(JsString, JsString)> {
        self.active
            .iter()
            .filter(|(thread, _)| self.router.owner(thread) == Some(&tenant))
            .map(|(thread, turn)| (thread.clone(), turn.clone()))
            .collect()
    }

    /// A close's `turn/interrupt` for every turn the channel still runs
    /// (`session.ts`'s close, `session-commands.ts`). Answers how many were
    /// sent, so the release waits for them.
    pub(super) fn interrupt_turns(&mut self, tenant: u64) -> usize {
        let mut sent = 0;
        for (thread, _turn) in self.live_turns(tenant) {
            if let Some(id) =
                self.own_request("turn/interrupt", &[("threadId", &thread)], INTERRUPT_MS)
            {
                self.own.insert(id, OwnPurpose::Interrupt { tenant });
                sent += 1;
            }
        }
        sent
    }

    /// One interrupt answered: the last one releases the channel's threads and
    /// unsubscribes them (`detach`, `:356`).
    pub(super) fn interrupt_answered(&mut self, tenant: u64) {
        let Some(state) = self.detaching.get_mut(&tenant) else {
            return;
        };
        if state.phase != Leaving::Interrupts {
            return;
        }
        state.remaining = state.remaining.saturating_sub(1);
        if state.remaining == 0 {
            self.unsubscribe_threads(tenant);
        }
    }

    /// Each of the channel's threads is unsubscribed (`:356`); they stay its
    /// own until the last one lands, so the frames their interrupts produce
    /// still reach the channel.
    pub(super) fn unsubscribe_threads(&mut self, tenant: u64) {
        let Some(state) = self.detaching.get_mut(&tenant) else {
            return;
        };
        state.phase = Leaving::Unsubscribes;
        let retirement = state.retirement;
        let threads = self.router.owned(&tenant);
        let mut issued = 0;
        for thread in &threads {
            if let Some(id) = self.own_request(
                "thread/unsubscribe",
                &[("threadId", thread)],
                UNSUBSCRIBE_MS,
            ) {
                self.own.insert(id, OwnPurpose::Unsubscribe { tenant });
                issued += 1;
            }
        }
        if issued == 0 {
            // Nothing could be asked: the channel still leaves.
            self.channel_detached(tenant, retirement);
            return;
        }
        if let Some(state) = self.detaching.get_mut(&tenant) {
            state.remaining = issued;
        }
    }

    /// One of a detached channel's unsubscribes landed.
    pub(super) fn unsubscribed(&mut self, tenant: u64) {
        let Some(state) = self.detaching.get_mut(&tenant) else {
            return;
        };
        state.remaining = state.remaining.saturating_sub(1);
        if state.remaining > 0 {
            return;
        }
        let Some(state) = self.detaching.shift_remove(&tenant) else {
            return;
        };
        self.channel_detached(tenant, state.retirement);
    }

    /// Stop the whole process (`retire`, `:379`): `onRetired` runs once, then
    /// the shell stops the child.
    pub(super) fn retire(&mut self, reason: Retirement, awaited: bool) {
        if self.retiring || self.exit.is_some() {
            return;
        }
        self.cancel_idle();
        if !self.retired {
            self.retired = true;
            self.out.push(HostEffect::Retired);
        }
        self.retiring = true;
        // A close started: a paused channel must not hold the drain.
        self.gate.drain();
        self.out.push(HostEffect::Retire { reason, awaited });
    }
}

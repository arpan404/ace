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
    /// (`session.ts`'s close, `session-commands.ts:198`): each names its thread
    /// and its turn. Answers how many were sent, so the release waits for them;
    /// an interrupt the peer refuses to enqueue is the close's failure.
    pub(super) fn interrupt_turns(&mut self, tenant: u64, attempt: u64) -> Result<(), String> {
        let turns = self.live_turns(tenant);
        let mut queued = Vec::with_capacity(turns.len());
        for (thread, turn) in &turns {
            match self.enqueue_own(
                "turn/interrupt",
                &[("threadId", thread), ("turnId", turn)],
                INTERRUPT_MS,
            ) {
                Ok((id, peer)) => {
                    self.own
                        .insert(id, OwnPurpose::Interrupt { tenant, attempt });
                    queued.push(peer);
                }
                Err(error) => {
                    // A refusal here ends the close, but the effects already
                    // collected may hold the active write: never drop a claimed
                    // ticket, or shared stdin never hands out another line.
                    for peer in queued {
                        self.apply(peer);
                    }
                    return Err(format!("the app-server refused the interrupt: {error}"));
                }
            }
        }
        if let Some(state) = self.detaching.get_mut(&tenant) {
            state.remaining = queued.len();
        }
        // Every attempt is on record before a settlement can answer one.
        for peer in queued {
            self.apply(peer);
        }
        Ok(())
    }

    /// One interrupt answered. Only a confirmed stop releases the channel: a
    /// refusal or a deadline leaves the turn running, so the channel and its
    /// work stay attached and the close reports the failure (`session.ts`'s
    /// close).
    pub(super) fn interrupt_answered(
        &mut self,
        tenant: u64,
        attempt: u64,
        result: &Result<Value, PeerError>,
    ) {
        let Some(state) = self.detaching.get_mut(&tenant) else {
            return;
        };
        // A reply to an earlier attempt is not this close's: a failed close
        // leaves its interrupts outstanding, and a retry starts over.
        if state.phase != Leaving::Interrupts || state.attempt != attempt {
            return;
        }
        if let Err(error) = result {
            self.detach_failed(tenant, error.message());
            return;
        }
        state.remaining = state.remaining.saturating_sub(1);
        if state.remaining == 0 {
            self.stop_terminals(tenant);
        }
    }

    /// The channel's background terminals stop next (`stopShells`,
    /// `session-commands.ts:183`): one list per thread, then one terminate per
    /// terminal, before the threads are unsubscribed.
    pub(super) fn stop_terminals(&mut self, tenant: u64) {
        let Some(state) = self.detaching.get_mut(&tenant) else {
            return;
        };
        state.phase = Leaving::Terminals;
        let threads = self.router.owned(&tenant);
        state.remaining = threads.len();
        if threads.is_empty() {
            self.unsubscribe_threads(tenant);
            return;
        }
        let mut queued = Vec::with_capacity(threads.len());
        for thread in &threads {
            match self.enqueue_own(
                "thread/backgroundTerminals/list",
                &[("threadId", thread)],
                TERMINALS_MS,
            ) {
                Ok((id, peer)) => {
                    self.own.insert(
                        id,
                        OwnPurpose::ShellList {
                            tenant,
                            thread: thread.clone(),
                        },
                    );
                    queued.push(peer);
                }
                Err(error) => {
                    // A claimed write is never dropped.
                    for peer in queued {
                        self.apply(peer);
                    }
                    self.detach_failed(
                        tenant,
                        &format!("Could not stop the background terminals: {error}"),
                    );
                    return;
                }
            }
        }
        for peer in queued {
            self.apply(peer);
        }
    }

    /// One thread's background terminals answered: stop each of them, then
    /// count this thread's step done.
    pub(super) fn terminals_listed(
        &mut self,
        tenant: u64,
        thread: &JsString,
        result: &Result<Value, PeerError>,
    ) {
        let Some(state) = self.detaching.get_mut(&tenant) else {
            return;
        };
        if state.phase != Leaving::Terminals {
            return;
        }
        let terminals = match result {
            Err(error) => {
                let message = format!(
                    "Could not stop the background terminals: {}",
                    error.message()
                );
                self.detach_failed(tenant, &message);
                return;
            }
            Ok(value) => value
                .get("data")
                .and_then(Value::as_array)
                .map(|listed| {
                    listed
                        .iter()
                        .filter_map(|terminal| terminal.get("processId"))
                        .filter_map(|id| match id {
                            Value::String(text) => Some(text.clone()),
                            _ => None,
                        })
                        .collect::<Vec<JsString>>()
                })
                .unwrap_or_default(),
        };
        let mut queued = Vec::with_capacity(terminals.len());
        for process in &terminals {
            match self.enqueue_own(
                "thread/backgroundTerminals/terminate",
                &[("threadId", thread), ("processId", process)],
                TERMINALS_MS,
            ) {
                Ok((id, peer)) => {
                    self.own.insert(id, OwnPurpose::ShellStop { tenant });
                    queued.push(peer);
                }
                Err(error) => {
                    for peer in queued {
                        self.apply(peer);
                    }
                    self.detach_failed(
                        tenant,
                        &format!("Could not stop the background terminals: {error}"),
                    );
                    return;
                }
            }
        }
        if let Some(state) = self.detaching.get_mut(&tenant) {
            // This thread's list becomes its terminals, one step each.
            state.remaining = state.remaining.saturating_sub(1) + terminals.len();
        }
        for peer in queued {
            self.apply(peer);
        }
        // A thread with no terminal is already done.
        self.terminals_settled(tenant);
    }

    /// One background terminal answered.
    pub(super) fn terminal_stopped(&mut self, tenant: u64, result: &Result<Value, PeerError>) {
        let Some(state) = self.detaching.get(&tenant) else {
            return;
        };
        if state.phase != Leaving::Terminals {
            return;
        }
        if let Err(error) = result {
            let message = format!(
                "Could not stop the background terminals: {}",
                error.message()
            );
            self.detach_failed(tenant, &message);
            return;
        }
        if let Some(state) = self.detaching.get_mut(&tenant) {
            state.remaining = state.remaining.saturating_sub(1);
        }
        self.terminals_settled(tenant);
    }

    /// Every terminal of every thread is stopped: the threads go next.
    fn terminals_settled(&mut self, tenant: u64) {
        if self
            .detaching
            .get(&tenant)
            .is_some_and(|state| state.phase == Leaving::Terminals && state.remaining == 0)
        {
            self.unsubscribe_threads(tenant);
        }
    }

    /// A close that cannot finish: the channel and its work stay attached, and
    /// the failure is the caller's.
    pub(super) fn detach_failed(&mut self, tenant: u64, message: &str) {
        let Some(state) = self.detaching.shift_remove(&tenant) else {
            return;
        };
        self.out.push(HostEffect::DetachFailed {
            tenant,
            reason: state.retirement,
            message: message.to_owned(),
        });
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
        let reason = state.reason.clone();
        // Only a confirmed stop detaches: the calls this channel waits on
        // settle once its turns are stopped (`tenant.abort`, `host.ts:349`).
        self.abort_calls(tenant, &reason);
        let threads = self.router.owned(&tenant);
        let mut queued = Vec::with_capacity(threads.len());
        for thread in &threads {
            if let Ok((id, peer)) = self.enqueue_own(
                "thread/unsubscribe",
                &[("threadId", thread)],
                UNSUBSCRIBE_MS,
            ) {
                self.own.insert(id, OwnPurpose::Unsubscribe { tenant });
                queued.push(peer);
            }
        }
        if queued.is_empty() {
            // Nothing could be asked: the channel still leaves.
            self.channel_detached(tenant, retirement);
            return;
        }
        if let Some(state) = self.detaching.get_mut(&tenant) {
            state.remaining = queued.len();
        }
        for peer in queued {
            self.apply(peer);
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

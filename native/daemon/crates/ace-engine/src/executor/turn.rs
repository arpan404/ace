// SPDX-License-Identifier: Apache-2.0
//! One turn of the pump (`E5.1` step 2): the budget, the lanes, the one-op-per-poll fairness and
//! the turn log. A child module of `executor` so it sees the executor's own fields.

use super::*;

impl Executor {
    pub fn pump(&self, budget: &mut dyn Budget, transaction_open: &dyn Fn() -> bool) -> Pump {
        if self.running.get() {
            // Reached from inside a port the turn called: the running turn sees the work.
            return Pump::Stale;
        }
        if claim::entry_next(self.shared.claim.load(SeqCst)) != Some(claim::RUNNING) {
            return Pump::Stale;
        }
        if self
            .shared
            .claim
            .compare_exchange(claim::SCHEDULED, claim::RUNNING, SeqCst, SeqCst)
            .is_err()
        {
            return Pump::Stale;
        }
        if transaction_open() {
            // The event loop already guarantees this cannot happen (Store.atomic is
            // synchronous); the check confirms it.
            self.shared.claim.store(claim::SCHEDULED, SeqCst);
            return Pump::Busy;
        }
        self.running.set(true);
        self.end_turn.set(false);
        budget.start();
        let (outcome, polls) = self.turn(budget);
        self.running.set(false);
        self.current.set(None);
        self.record_turn(polls);
        outcome
    }

    fn turn(&self, budget: &mut dyn Budget) -> (Pump, u32) {
        let mut polls: u64 = 0;
        // The inbox's share is one turn's, shared by its retries: 32 items in all.
        let mut moved: usize = 0;
        loop {
            let capped = self.intake(budget, &mut moved);
            let mut first = true;
            loop {
                // The first poll of a phase always happens, even when intake used the whole
                // budget: a run queue that is non-empty is never skipped.
                if !first && (polls >= 64 || budget.spent(polls as usize)) {
                    break;
                }
                let Some(runnable) = self.next_runnable() else {
                    break;
                };
                self.poll(runnable);
                polls += 1;
                first = false;
                // A task that ended the turn stops it after its poll; the rest runs in the next.
                if self.end_turn.replace(false) {
                    self.shared.claim.store(claim::SCHEDULED, SeqCst);
                    return (Pump::Rearm, polls as u32);
                }
            }
            if capped {
                // The rest of the inbox waits for the re-armed turn, which the shell schedules.
                self.shared.claim.store(claim::SCHEDULED, SeqCst);
                return (Pump::Rearm, polls as u32);
            }
            match self.end(polls as usize, budget) {
                End::Rearm => return (Pump::Rearm, polls as u32),
                End::Drained => return (Pump::Done, polls as u32),
                End::Again => continue,
            }
        }
    }

    /// The intake phase: at most 32 inbox items a turn, shared by its retries, stopping early
    /// when its 2 ms share is gone. Returns whether the cap left items for the next turn.
    fn intake(&self, budget: &mut dyn Budget, moved: &mut usize) -> bool {
        while *moved < 32 {
            if budget.intake_spent() {
                return false;
            }
            let item = match self.shared.inbox.pop() {
                Ok(item) => item,
                Err(PopError::Empty) => return false,
                Err(PopError::Closed) => return false,
            };
            *moved += 1;
            match item {
                Item::Wake(waker) => waker.wake(),
            }
        }
        !self.shared.inbox.is_empty()
    }

    /// The fairness rule: controls first, except that after eight in a row the next poll is work.
    fn next_runnable(&self) -> Option<Runnable<TaskId>> {
        let streak = self.control_streak.get();
        if streak >= 8
            && let Some(runnable) = self.take(Lane::Work)
        {
            self.control_streak.set(0);
            return Some(runnable);
        }
        if let Some(runnable) = self.take(Lane::Control) {
            self.control_streak.set((streak + 1).min(8));
            return Some(runnable);
        }
        match self.take(Lane::Work) {
            Some(runnable) => {
                self.control_streak.set(0);
                Some(runnable)
            }
            None => None,
        }
    }

    fn poll(&self, runnable: Runnable<TaskId>) {
        let id = *runnable.metadata();
        self.current.set(Some(id));
        let began = Instant::now();
        // `propagate_panic` keeps a task's panic out of the pump; this catches anything that
        // still unwinds and reports it once.
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| runnable.run()));
        let took = began.elapsed();
        self.current.set(None);
        let mut stats = self.stats.get();
        stats.polls += 1;
        stats.longest_poll_us = stats.longest_poll_us.max(took.as_micros() as u64);
        if took.as_millis() > 16 {
            stats.slow_polls += 1;
        }
        self.stats.set(stats);
        if caught.is_err() {
            eprintln!("engine task {id} panicked and was dropped");
        }
    }

    fn record_turn(&self, polls: u32) {
        let mut stats = self.stats.get();
        stats.turns += 1;
        stats.last_turn_polls = polls;
        self.stats.set(stats);
        self.turn_polls.borrow_mut().push(polls);
    }

    /// The turn's end, a loop over the observed state.
    fn end(&self, polls: usize, budget: &mut dyn Budget) -> End {
        let work_left = !self.shared.inbox.is_empty()
            || !self.shared.control.is_empty()
            || !self.shared.work.is_empty();
        if work_left && !budget.spent(polls) {
            return End::Again;
        }
        if budget.spent(polls) {
            // Whoever dirtied the claim posted nothing; the continuation covers its item.
            self.shared.claim.store(claim::SCHEDULED, SeqCst);
            return End::Rearm;
        }
        match self
            .shared
            .claim
            .compare_exchange(claim::RUNNING, claim::IDLE, SeqCst, SeqCst)
        {
            Ok(_) => {
                if self.signal_drained() {
                    // The close task is now runnable; nothing more to do this turn.
                    return End::Drained;
                }
                End::Drained
            }
            Err(now) if now == claim::RUNNING_DIRTY => {
                // A producer dirtied the claim: drain once more.
                self.shared.claim.store(claim::RUNNING, SeqCst);
                End::Again
            }
            Err(_) => End::Drained,
        }
    }

    /// Signals the close task's drain receiver when everything admitted has run.
    fn signal_drained(&self) -> bool {
        match self.draining.take() {
            Some(sender) => {
                let _ = sender.send(());
                true
            }
            None => false,
        }
    }
}

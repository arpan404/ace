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
    /// `session-commands.ts:183`): every page of each thread's list, then one
    /// terminate per terminal, before the threads are unsubscribed.
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
        let attempt = state.attempt;
        let mut queued = Vec::with_capacity(threads.len());
        for thread in &threads {
            match self.enqueue_shell_list(tenant, attempt, thread, ShellScan::new(), None) {
                Ok(peer) => queued.push(peer),
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

    /// One page of a thread's terminals, nothing more, is asked for.
    fn enqueue_shell_list(
        &mut self,
        tenant: u64,
        attempt: u64,
        thread: &JsString,
        scan: ShellScan,
        cursor: Option<&JsString>,
    ) -> Result<Vec<PeerEffect>, String> {
        let (thread_param, cursor_param) = (thread, cursor);
        let mut params: Vec<(&str, &JsString)> = Vec::with_capacity(2);
        params.push(("threadId", thread_param));
        if let Some(cursor) = cursor_param {
            params.push(("cursor", cursor));
        }
        let (id, peer) =
            self.enqueue_own("thread/backgroundTerminals/list", &params, TERMINALS_MS)?;
        self.own.insert(
            id,
            OwnPurpose::ShellList {
                tenant,
                attempt,
                thread: thread.clone(),
                scan,
            },
        );
        Ok(peer)
    }

    /// One page of a thread's background terminals answered: read on until the
    /// continuation is empty, then stop every terminal the pages named
    /// (`readBackgroundTerminals`, `background-terminals.ts:16`).
    pub(super) fn terminals_listed(
        &mut self,
        tenant: u64,
        attempt: u64,
        thread: &JsString,
        mut scan: ShellScan,
        result: &Result<Value, PeerError>,
    ) {
        let Some(state) = self.detaching.get(&tenant) else {
            return;
        };
        // A reply to an earlier close is not this one's.
        if state.phase != Leaving::Terminals || state.attempt != attempt {
            return;
        }
        let page = match result {
            Err(error) => {
                self.detach_failed(
                    tenant,
                    &format!(
                        "Could not stop the background terminals: {}",
                        error.message()
                    ),
                );
                return;
            }
            Ok(value) => value,
        };
        let (listed, next) = match read_terminal_page(page) {
            Ok(read) => read,
            Err(message) => {
                self.detach_failed(
                    tenant,
                    &format!("Could not stop the background terminals: {message}"),
                );
                return;
            }
        };
        scan.terminals.extend(listed);
        if scan.terminals.len() > TERMINAL_TOTAL {
            self.detach_failed(tenant, "Codex terminal capacity reached");
            return;
        }
        match next {
            None => self.stop_listed_terminals(tenant, attempt, thread, scan.terminals),
            Some(cursor) => {
                if scan.cursors.contains(&cursor) {
                    self.detach_failed(tenant, "Repeated Codex terminal cursor");
                    return;
                }
                scan.cursors.insert(cursor.clone());
                if scan.pages + 1 >= TERMINAL_PAGES {
                    self.detach_failed(tenant, "Codex terminal pagination capacity reached");
                    return;
                }
                scan.pages += 1;
                match self.enqueue_shell_list(tenant, attempt, thread, scan, Some(&cursor)) {
                    Ok(peer) => self.apply(peer),
                    Err(error) => self.detach_failed(
                        tenant,
                        &format!("Could not stop the background terminals: {error}"),
                    ),
                }
            }
        }
    }

    /// A thread's last page is in: each terminal it named is stopped once, in
    /// the order the pages listed it (`stopShells`'s `Set`,
    /// `session-commands.ts:181`).
    fn stop_listed_terminals(
        &mut self,
        tenant: u64,
        attempt: u64,
        thread: &JsString,
        terminals: Vec<JsString>,
    ) {
        let Some(state) = self.detaching.get_mut(&tenant) else {
            return;
        };
        // This thread's pages are read: its terminals take their turn next.
        state.remaining = state.remaining.saturating_sub(1);
        let mut seen = HashSet::with_capacity(terminals.len());
        for process in terminals {
            if seen.insert(process.clone()) {
                state.stops.push_back((thread.clone(), process));
            }
        }
        self.stop_next_terminal(tenant, attempt);
    }

    /// The next terminal's stop goes out, if the last one is answered: the
    /// peer's pending slots are shared with every other call, so a scan of any
    /// size never runs it out of room (`stopShells` awaits each terminate).
    fn stop_next_terminal(&mut self, tenant: u64, attempt: u64) {
        let next = self.detaching.get(&tenant).and_then(|state| {
            if state.stopping {
                None
            } else {
                state.stops.front().cloned()
            }
        });
        let Some((thread, process)) = next else {
            self.terminals_settled(tenant);
            return;
        };
        match self.enqueue_own(
            "thread/backgroundTerminals/terminate",
            &[("threadId", &thread), ("processId", &process)],
            TERMINALS_MS,
        ) {
            Ok((id, peer)) => {
                self.own
                    .insert(id, OwnPurpose::ShellStop { tenant, attempt });
                if let Some(state) = self.detaching.get_mut(&tenant) {
                    state.stopping = true;
                }
                self.apply(peer);
            }
            Err(error) => self.detach_failed(
                tenant,
                &format!("Could not stop the background terminals: {error}"),
            ),
        }
    }

    /// One background terminal answered.
    pub(super) fn terminal_stopped(
        &mut self,
        tenant: u64,
        attempt: u64,
        result: &Result<Value, PeerError>,
    ) {
        let Some(state) = self.detaching.get(&tenant) else {
            return;
        };
        // A stop from an earlier close is not this one's.
        if state.phase != Leaving::Terminals || state.attempt != attempt {
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
            state.stopping = false;
            state.stops.pop_front();
        }
        self.stop_next_terminal(tenant, attempt);
    }

    /// Every terminal of every thread is stopped: the threads go next.
    fn terminals_settled(&mut self, tenant: u64) {
        let settled = self.detaching.get(&tenant).is_some_and(|state| {
            state.phase == Leaving::Terminals
                && state.remaining == 0
                && state.stops.is_empty()
                && !state.stopping
        });
        if settled {
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

/// One terminal-list page as `TerminalPage` reads it
/// (`background-terminals.ts:2`): `data` is required, at most 256 rows with a
/// 1–1,024 character `processId` and, when present, a string `itemId`, and
/// `nextCursor` is absent, null, or a 1–4,096 character string. A page that
/// fails this is refused whole, never read as an empty page or as the end of
/// the list; keys the schema does not declare pass through, as `.passthrough()`
/// does.
fn read_terminal_page(page: &Value) -> Result<(Vec<JsString>, Option<JsString>), &'static str> {
    let data = match page.get("data") {
        Some(Value::Array(items)) => items,
        _ => return Err("the terminal page has no list of terminals"),
    };
    if data.len() > TERMINALS_PER_PAGE {
        return Err("the terminal page lists too many terminals");
    }
    let mut terminals = Vec::with_capacity(data.len());
    for terminal in data {
        match terminal.get("processId") {
            Some(Value::String(process))
                if process.len_utf16() > 0 && process.len_utf16() <= TERMINAL_ID_MAX =>
            {
                terminals.push(process.clone());
            }
            _ => return Err("the terminal page names an invalid process"),
        }
        // `itemId: z.string().optional()`: absent, or any string, of any length.
        match terminal.get("itemId") {
            None | Some(Value::String(_)) => {}
            Some(_) => return Err("the terminal page names an invalid item"),
        }
    }
    let next = match page.get("nextCursor") {
        None | Some(Value::Null) => None,
        Some(Value::String(cursor)) if (1..=CURSOR_MAX).contains(&cursor.len_utf16()) => {
            Some(cursor.clone())
        }
        Some(_) => return Err("the terminal page has an invalid cursor"),
    };
    Ok((terminals, next))
}

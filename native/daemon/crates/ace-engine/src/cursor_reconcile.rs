// SPDX-License-Identifier: Apache-2.0
//! Cursor turns a restart cut short, reconciled with Cursor's own store before they are called
//! failed (`cursor-reconcile.ts`, ADR 0043's 2026-11-22 amendment). This file holds the queue of
//! threads a startup marked: their lanes stay shut while a reconcile waits or runs, so a Resume
//! cannot open a second session that fences it.

use indexmap::IndexSet;

/// The threads a startup marked for reconcile, and those still held (`CursorReconciles`).
#[derive(Debug, Default)]
pub struct CursorReconciles {
    /// Marked by startup, not started yet.
    pub(crate) marked: IndexSet<String>,
    /// Marked or reconciling: no other work of theirs starts until it ends.
    pub(crate) held: IndexSet<String>,
    /// Close ran: nothing more is scheduled or opened.
    pub(crate) closed: bool,
}

/// `add` (`cursor-reconcile.ts:247`): a thread whose cut-off Cursor work waits for its reconcile.
pub fn mark(state: &mut crate::State, thread: &str) {
    state.cursor.marked.insert(thread.to_owned());
    state.cursor.held.insert(thread.to_owned());
}

/// `holds` (`:256`): true while a thread waits for or runs its reconcile, busy retries included.
pub fn holds(state: &crate::State, thread: &str) -> bool {
    state.cursor.held.contains(thread)
}

/// `close` (`:317`): no reconcile starts or retries after this.
pub fn close(state: &mut crate::State) {
    state.cursor.closed = true;
}

/// The threads startup marked, in marking order (`start`, `:259`).
pub fn take_marked(state: &mut crate::State) -> Vec<String> {
    state.cursor.marked.iter().cloned().collect()
}

/// `release` (`:307`): the thread's lanes open again.
pub fn release(state: &mut crate::State, thread: &str) {
    state.cursor.held.shift_remove(thread);
}

#[cfg(test)]
mod tests;

// SPDX-License-Identifier: Apache-2.0
//! `slot-reclaim.ts:24`-`:48` (E5.4e): frees an engine slot held only by a warm idle session, so
//! new work is admitted instead of refused while finished threads keep their processes warm.
//!
//! The choice is pure over the facts [`Facts`] carries, so it is tested without an engine. The
//! gatherer reads the same facts from the engine and marks the chosen actor `idleDue`; the retire
//! wake goes on the after-commit queue, and E5.6's control worker closes the session when it runs.
//! Closing stays E5.6's.
//!
//! `Repo::reserve` holds `&mut Repo` when its `reclaim` hook runs, so that hook cannot read the
//! actors or `opening` (both live in `State`). The receipt asks [`reclaim_idle_slot`] when
//! `reserve` refuses and retries once, which makes the same choice at the same point: `reserve`
//! refuses only on capacity, and the retry sees `retiring` grown by one.

use ace_store::stmt_cache;
use std::collections::HashSet;

use crate::executor::{Deferred, Lane};
use crate::{Core, EngineError, State};

const RUNNING: &str = "SELECT 1 FROM intents WHERE thread_id=? AND status='running' LIMIT 1";

/// One resident actor, as the choice reads it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Idle {
    /// `actor.session !== undefined`.
    pub session: bool,
    pub idle_due: bool,
    pub idle_since: Option<f64>,
}

/// Everything the choice reads for one thread.
#[derive(Debug, Clone, PartialEq)]
pub struct Facts {
    pub id: String,
    pub actor: Idle,
    /// `repo.reservedSlot(id)`: the thread holds an engine slot.
    pub slot: bool,
    /// `repo.sessionOpening(id)`.
    pub opening: bool,
    /// `pending.running || pending.message || pending.recovery || pending.transition ||
    /// pending.controls.length`: work a session still has to run.
    pub pending: bool,
    /// `sessions.isClosing(id)`.
    pub closing: bool,
    /// `fenced(id)`: held for a move, so its work waits and its session may retire.
    pub held: bool,
}

/// `reclaimIdleSlot`: the first warm idle session that may retire, or none.
pub fn choose(
    facts: impl IntoIterator<Item = Facts>,
    retiring: &HashSet<String>,
) -> Option<String> {
    for fact in facts {
        if !fact.actor.session || fact.actor.idle_due {
            continue;
        }
        if fact.actor.idle_since.is_none() && !fact.held {
            continue;
        }
        if retiring.contains(&fact.id) || fact.closing || !fact.slot {
            continue;
        }
        if !fact.held && (fact.opening || fact.pending) {
            continue;
        }
        return Some(fact.id);
    }
    None
}

/// `pending.running` (`intents.ts:331`): any intent of the thread is running.
fn running(core: &Core, id: &str) -> Result<bool, EngineError> {
    Ok(stmt_cache::get_row(core.store.conn(), RUNNING, vec![text(id)])?.is_some())
}

fn text(id: &str) -> ace_store::Value {
    ace_store::Value::Text(id.to_owned())
}

/// Whether any intent keeps the thread from retiring: one running, or one waiting to send, to
/// recover, to switch, or a control (a Stop, an interaction answer).
fn pending(core: &Core, id: &str) -> Result<bool, EngineError> {
    let conn = core.store.conn();
    Ok(running(core, id)?
        || crate::intents::store::message(conn, id)?.is_some()
        || crate::intents::store::recovery(conn, id)?.is_some()
        || crate::intents::store::transition(conn, id)?.is_some()
        || !crate::intents::store::controls(conn, id)?.is_empty())
}

/// The reclaim as the receipt reaches it: the choice, the `idleDue` mark and the after-commit
/// retire wake. The caller adds the returned thread to `retiring`, as `reserve` does.
pub fn reclaim_idle_slot(
    core: &Core,
    state: &mut State,
    closing: &dyn Fn(&str) -> bool,
    held: &dyn Fn(&str) -> bool,
) -> Result<Option<String>, EngineError> {
    let facts = {
        let repo = &state.repo;
        let mut facts = Vec::with_capacity(state.actors.by_thread.len());
        for (id, actor) in state.actors.by_thread.iter() {
            facts.push(Facts {
                id: id.clone(),
                actor: Idle {
                    session: actor.session_attached,
                    idle_due: actor.idle_due,
                    idle_since: actor.idle_since,
                },
                slot: repo.reserved_slot(&core.store, id)?,
                opening: repo.opening.contains(id),
                pending: pending(core, id)?,
                closing: closing(id),
                held: held(id),
            });
        }
        facts
    };
    let Some(chosen) = choose(facts, &state.repo.retiring) else {
        return Ok(None);
    };
    // The marks are the caller's, applied once the whole receipt commits
    // ([`mark`]): a receipt that throws after this choice rolls its SQL back and must leave no
    // `idleDue` actor or `retiring` entry behind.
    Ok(Some(chosen))
}

/// Applies a reclaim the receipt committed: the actor is `idleDue` and the retire wake runs the
/// control worker, which closes a session whose idle release is due (closing is E5.6's).
pub fn mark(core: &Core, state: &mut State, thread: &str) {
    if let Some(actor) = state.actors.by_thread.get_mut(thread) {
        actor.idle_due = true;
    }
    state.repo.retiring.insert(thread.to_owned());
    core.defer(Deferred::Wake(thread.to_owned(), Lane::Control));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(id: &str, idle_since: Option<f64>) -> Facts {
        Facts {
            id: id.to_owned(),
            actor: Idle {
                session: true,
                idle_due: false,
                idle_since,
            },
            slot: true,
            opening: false,
            pending: false,
            closing: false,
            held: false,
        }
    }

    fn none() -> HashSet<String> {
        HashSet::new()
    }

    #[test]
    fn the_oldest_warm_idle_session_is_chosen_and_a_busy_one_is_not() {
        let mut busy = facts("busy", Some(1.0));
        busy.pending = true;
        assert_eq!(
            choose([busy, facts("idle", Some(2.0))], &none()).as_deref(),
            Some("idle")
        );
        // No idle mark and not held: the actor never had a session go idle.
        let mut cold = facts("cold", None);
        cold.actor.session = false;
        assert_eq!(choose([cold], &none()), None);
        assert_eq!(choose([facts("cold", None)], &none()), None);
    }

    #[test]
    fn a_thread_with_no_session_or_an_idle_mark_already_set_is_skipped() {
        let mut nosession = facts("no-session", Some(1.0));
        nosession.actor.session = false;
        let mut due = facts("due", Some(1.0));
        due.actor.idle_due = true;
        assert_eq!(choose([nosession, due], &none()), None);
    }

    #[test]
    fn a_retiring_closing_or_slotless_thread_is_skipped() {
        let mut closing = facts("closing", Some(1.0));
        closing.closing = true;
        let mut slotless = facts("slotless", Some(1.0));
        slotless.slot = false;
        let mut retiring = HashSet::new();
        retiring.insert("retiring".to_owned());
        assert_eq!(
            choose(
                [
                    closing,
                    slotless,
                    facts("retiring", Some(1.0)),
                    facts("free", Some(1.0))
                ],
                &retiring
            )
            .as_deref(),
            Some("free")
        );
    }

    #[test]
    fn a_session_still_opening_never_retires_unless_a_move_holds_the_thread() {
        let mut opening = facts("opening", Some(1.0));
        opening.opening = true;
        assert_eq!(choose([opening.clone()], &none()), None);
        let mut held = facts("held", Some(1.0));
        held.held = true;
        held.pending = true;
        held.opening = true;
        assert_eq!(choose([held], &none()).as_deref(), Some("held"));
        // A held thread with no idle mark still gives its slot up: its work waits elsewhere.
        let mut waiting = facts("waiting", None);
        waiting.held = true;
        assert_eq!(choose([waiting], &none()).as_deref(), Some("waiting"));
    }
}

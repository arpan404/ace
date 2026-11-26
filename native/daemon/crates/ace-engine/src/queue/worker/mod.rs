// SPDX-License-Identifier: Apache-2.0
//! The sends worker (`index.ts:1220`-`:1277` `wake`, `:1300`-`:1384` `work`, `wakeQueued`,
//! `releaseDormant`, E5.4f): what one pass of a thread's sends lane does, and the wake that
//! starts it.
//!
//! Delivery is E5.5's: the two calls into it throw `NotPorted` and the worker set reports them
//! once. Closing a session is E5.6's, and the ownership fence E5.9's (`live-move`); the reads
//! below are the same conditions their rules name, so a pass makes the same choice today.

use ace_json::Value;
use std::rc::Rc;

use crate::actor;
use crate::executor::{Deferred, Lane};
use crate::intents::header::IntentHeader;
use crate::queue::ready::ready_for_input;
use crate::steering::route::SessionSteer;
use crate::{Core, EngineError};

/// The ownership states that take no new work here (ADR 0191, `ownership-rules.ts:117`).
const FENCED: &str = "SELECT 1 FROM thread_ownership WHERE thread_id=? AND state IN ('stopping','handing','moved') LIMIT 1";
/// `workspaceReservations.reserved(root)`: a Git change holds the workspace.
const RESERVED: &str = "SELECT 1 FROM workspace_root_reservations WHERE root=? LIMIT 1";
/// The thread's checkout, for the reservation check.
const CWD: &str = "SELECT cwd FROM engine_sessions WHERE thread_id=?";

/// `fenced(id)`: the thread is moving to another machine.
fn fenced(core: &Core, thread: &str) -> Result<bool, EngineError> {
    Ok(ace_store::stmt_cache::get_row(
        core.store.conn(),
        FENCED,
        vec![ace_store::Value::Text(thread.to_owned())],
    )?
    .is_some())
}

/// The thread's checkout, when it has one.
fn session_cwd(core: &Core, thread: &str) -> Result<Option<String>, EngineError> {
    let row = ace_store::stmt_cache::get_row(
        core.store.conn(),
        CWD,
        vec![ace_store::Value::Text(thread.to_owned())],
    )?;
    Ok(row.and_then(|row| {
        row.get("cwd")
            .and_then(crate::repository::residency::cell_text)
            .map(str::to_owned)
    }))
}

/// `store.workspaceReservations.reserved(cwd)`.
fn workspace_reserved(core: &Core, cwd: &str) -> Result<bool, EngineError> {
    Ok(ace_store::stmt_cache::get_row(
        core.store.conn(),
        RESERVED,
        vec![ace_store::Value::Text(cwd.to_owned())],
    )?
    .is_some())
}

/// The actor facts one pass reads once, after the flush.
struct ActorFacts {
    poisoned: bool,
    persistence_failed: bool,
    session: bool,
    idle_due: bool,
}

fn actor_facts(core: &Core, thread: &str) -> Result<Option<ActorFacts>, EngineError> {
    core.with_state(|state| {
        state.actors.by_thread.get(thread).map(|actor| ActorFacts {
            poisoned: actor.poisoned,
            persistence_failed: actor.persistence_failed,
            session: actor.session_attached,
            idle_due: actor.idle_due,
        })
    })
}

/// `actor.schedule()`: arm the actor's own deadline.
fn schedule_actor(core: &Core, thread: &str) {
    actor::timer::schedule(core, &thread.to_owned());
}

/// `wake(id)`: the thread's lanes run, unless it is closing, cleaning or moving. A wake while
/// the store publishes history waits for writability, once per thread.
pub fn wake(core: &Rc<Core>, thread: &str) -> Result<(), EngineError> {
    if core.closing.get() || core.with_state(|state| state.repo.cleaning(thread))? {
        return Ok(());
    }
    let row = crate::commands::prelude::thread_row(core, thread)?;
    let takes_work = row.as_ref().is_some_and(|row| {
        row.get("deletedAt").is_none_or(Value::is_null)
            && row.get("continuation").is_none_or(Value::is_null)
    });
    if row.is_some() && !takes_work {
        return Ok(());
    }
    let live = core.actor_deps.borrow().live.clone();
    if live.history_writing() {
        // The publication ends soon; the wake runs once it does, and only one per thread.
        let deferred = core.with_state(|state| state.deferred_wakes.insert(thread.to_owned()))?;
        if !deferred {
            return Ok(());
        }
        let ask = Rc::clone(core);
        let thread = thread.to_owned();
        // The live store is cloned out first: no `RefCell` borrow may live across the await.
        let live = core.actor_deps.borrow().live.clone();
        let future = Box::pin(async move {
            live.writable().await;
            let _ = ask.with_state(|state| state.deferred_wakes.remove(&thread));
            let _ = wake(&ask, &thread);
        });
        core.defer(Deferred::Spawn(Lane::Work, future));
        return Ok(());
    }
    release_dormant(core, thread)?;
    let reserved = core.with_state(|state| state.repo.reserved_slot(&core.store, thread))??;
    if !reserved {
        return Ok(());
    }
    let run = runner(Rc::clone(core));
    core.with_state(|state| {
        state.workers.sends.wake(thread, &core.executor, run);
    })?;
    Ok(())
}

/// `wakeQueued()`: threads whose intents wait but hold no slot start here.
pub fn wake_queued(core: &Rc<Core>) -> Result<(), EngineError> {
    if core.closing.get() {
        return Ok(());
    }
    let limit = core.with_state(|state| state.limits.max_active_threads)?;
    let threads = crate::intents::store::runnable_threads(core.store.conn(), limit as i64)?;
    for thread in threads {
        if fenced(core, &thread)? {
            continue;
        }
        let reserved = core.with_state(|state| state.repo.reserve(&core.store, &thread))??;
        if reserved {
            wake(core, &thread)?;
        }
    }
    Ok(())
}

/// `releaseDormant(id)`: a thread with nothing to run gives up its actor and its slot.
pub fn release_dormant(core: &Rc<Core>, thread: &str) -> Result<(), EngineError> {
    let facts = actor_facts(core, thread)?;
    let Some(facts) = facts else {
        return Ok(());
    };
    if facts.session
        || core.with_state(|state| state.session_opening(thread))?
        || running(core, thread)?
    {
        return Ok(());
    }
    let queue = crate::queue::store::get(&core.store, thread)?;
    let fenced = fenced(core, thread)?;
    if !fenced
        && (crate::intents::store::recovery(core.store.conn(), thread)?.is_some()
            || crate::intents::store::transition(core.store.conn(), thread)?.is_some()
            || !crate::intents::store::controls(core.store.conn(), thread)?.is_empty()
            || (!queue.paused
                && !queue.limited
                && crate::intents::store::message(core.store.conn(), thread)?.is_some()))
    {
        return Ok(());
    }
    let (backlog, _bytes) = actor::mailbox::task::backlog(core, &thread.to_owned());
    if !facts.poisoned && backlog == 0 {
        actor::stop(core, &thread.to_owned());
        core.with_state(|state| {
            state.actors.by_thread.shift_remove(thread);
            state.repo.evict(&core.store, thread)
        })??;
    }
    let reserved = core.with_state(|state| state.repo.reserved_slot(&core.store, thread))??;
    if reserved {
        core.with_state(|state| state.repo.release_slot(&core.store, thread))??;
        wake_queued(core)?;
    }
    Ok(())
}

/// `pending.running(id)`: an intent of the thread is running.
fn running(core: &Core, thread: &str) -> Result<bool, EngineError> {
    const SQL: &str = "SELECT 1 FROM intents WHERE thread_id=? AND status='running' LIMIT 1";
    Ok(ace_store::stmt_cache::get_row(
        core.store.conn(),
        SQL,
        vec![ace_store::Value::Text(thread.to_owned())],
    )?
    .is_some())
}

/// `pending.runningBesides(id, except)`: another intent of the thread is running.
fn running_besides(core: &Core, thread: &str, except: i64) -> Result<bool, EngineError> {
    const SQL: &str =
        "SELECT 1 FROM intents WHERE thread_id=? AND status='running' AND id<>? LIMIT 1";
    Ok(ace_store::stmt_cache::get_row(
        core.store.conn(),
        SQL,
        vec![
            ace_store::Value::Text(thread.to_owned()),
            ace_store::Value::Integer(except),
        ],
    )?
    .is_some())
}

/// The root's active run, read from the thread's state.
fn root_run(core: &Core, thread: &str) -> Result<Option<String>, EngineError> {
    let snapshot = core.with_state(|state| state.repo.state(&core.store, thread))??;
    Ok(snapshot.and_then(|snapshot| {
        let borrowed = snapshot.borrow();
        crate::steering::route::root_run(&borrowed.state)
    }))
}

/// Whether the tree reads quiescent.
fn quiescent(core: &Core, thread: &str) -> Result<bool, EngineError> {
    core.with_state(|state| crate::transitions::switch_ready::quiescent(core, state, thread))?
}

/// The thread's steer-yield record, as E5.5's lane left it.
fn yield_record(
    core: &Core,
    thread: &str,
) -> Result<Option<crate::steering::yields::SteerYield>, EngineError> {
    core.with_state(|state| state.steering.yield_for(thread).cloned())
}

/// `steerLane.isSteer`: whether the intent goes into the provider right now.
fn is_steer(core: &Core, thread: &str, intent: &IntentHeader) -> Result<bool, EngineError> {
    let capabilities =
        core.with_state(|state| crate::queue::ready::thread_capabilities(core, state, thread))??;
    let Some(capabilities) = capabilities else {
        return Ok(false);
    };
    let yielded = yield_record(core, thread)?;
    crate::steering::route::is_steer(
        core,
        thread,
        intent,
        crate::steering::route::SteerQuery {
            capabilities: &capabilities,
            session: SessionSteer::default(),
            quiescent: quiescent(core, thread)?,
            running_besides: running_besides(core, thread, intent.id)?,
            yielded: yielded.as_ref(),
        },
    )
}

/// One pass of a thread's sends lane (`index.ts:1300`).
pub async fn work(core: Rc<Core>, thread: String) -> Result<(), EngineError> {
    actor::mailbox::task::flush(Rc::clone(&core), thread.clone(), None).await;
    if core.with_state(|state| state.repo.cleaning(&thread))? {
        return Ok(());
    }
    let Some(facts) = actor_facts(&core, &thread)? else {
        return Ok(());
    };
    if facts.poisoned {
        // Closing the session is E5.6's; its absence throws here, as an unported call must.
        if facts.session {
            return Err(EngineError::not_ported("a session close", "E5.6"));
        }
        for intent in crate::intents::header::headers(core.store.conn(), Some(&thread), None)? {
            if !matches!(intent.status.as_str(), "pending" | "queued") {
                continue;
            }
            let reason = if facts.persistence_failed {
                "Thread stopped after a persistence failure; restart the daemon before retrying"
            } else {
                "Provider stopped after an invalid response; resume the thread to retry"
            };
            crate::delivery::fail(&core, &intent, reason)?;
        }
        actor::fold::sync_queue(&core, &thread)?;
        if !facts.persistence_failed {
            actor::stop(&core, &thread);
            core.with_state(|state| {
                state.actors.by_thread.shift_remove(&thread);
                state.repo.evict(&core.store, &thread)
            })??;
            core.with_state(|state| state.repo.release_slot(&core.store, &thread))??;
            wake_queued(&core)?;
        }
        return Ok(());
    }
    if let Some(cwd) = session_cwd(&core, &thread)?
        && workspace_reserved(&core, &cwd)?
    {
        return Ok(());
    }
    if fenced(&core, &thread)? {
        return release_dormant(&core, &thread);
    }
    // Controls own idle retirement; sends must remain free to open a replacement.
    if core.closing.get() || (facts.idle_due && facts.session) {
        return Ok(());
    }
    let guard = core.with_state(|state| state.transition_guard_owner(&core.store, &thread))??;
    let change = crate::intents::store::transition(core.store.conn(), &thread)?;
    let guard_allows = |command: &str| guard.as_deref().is_none_or(|owner| owner == command);
    if let Some(change) = &change
        && guard_allows(&change.command_id)
        && crate::intents::store::awaiting(core.store.conn(), &thread)?.is_none()
        && !crate::intents::store::recovering(core.store.conn(), &thread)?
        && core.with_state(|state| {
            crate::transitions::switch_ready::switch_ready(&core, state, change)
        })??
    {
        crate::delivery::run(&core, change)?;
        wake(&core, &thread)?;
        return Ok(());
    }
    let recovery = crate::intents::store::recovery(core.store.conn(), &thread)?;
    // Every queue change wakes the thread; keep core's view of a held queue current with it.
    actor::fold::sync_queue(&core, &thread)?;
    let queue = crate::queue::store::get(&core.store, &thread)?;
    if let Some(recovery) = &recovery
        && (guard_allows(&recovery.command_id)
            || (queue.continuation.is_none()
                && matches!(recovery.kind.as_str(), "thread.resume" | "queue.resume")))
    {
        crate::delivery::run(&core, recovery)?;
        wake(&core, &thread)?;
        return Ok(());
    }
    if crate::intents::store::recovery_acknowledgement(core.store.conn(), &thread)? {
        return Ok(());
    }
    if queue.paused || queue.limited {
        release_dormant(&core, &thread)?;
        schedule_actor(&core, &thread);
        return Ok(());
    }
    let first = crate::intents::store::message(core.store.conn(), &thread)?;
    let steerable = match &first {
        Some(first) => is_steer(&core, &thread, first)? && root_run(&core, &thread)?.is_some(),
        None => false,
    };
    let intent = if first
        .as_ref()
        .is_some_and(|first| matches!(first.kind.as_str(), "thread.switch" | "thread.merge"))
    {
        crate::intents::store::child_result(core.store.conn(), &thread)?
    } else {
        match crate::steering::route::yielded(
            &core,
            &thread,
            yield_record(&core, &thread)?.as_ref(),
        )? {
            Some(yielded) => Some(yielded),
            // A steer joins the running turn on its own lane; with no turn running it goes first.
            None if steerable => crate::intents::store::queued_message(core.store.conn(), &thread)?,
            None => first,
        }
    };
    if let Some(intent) = &intent
        && guard_allows(&intent.command_id)
        && !matches!(intent.kind.as_str(), "thread.switch" | "thread.merge")
    {
        crate::intents::lifecycle::mark(&core.store, intent, "queued", None)?;
        actor::fold::sync_queue(&core, &thread)?;
        let ready = core.with_state(|state| ready_for_input(&core, state, intent))??;
        if crate::intents::store::awaiting(core.store.conn(), &thread)?.is_none() && ready {
            crate::delivery::run(&core, intent)?;
            wake(&core, &thread)?;
            return Ok(());
        }
    }
    release_dormant(&core, &thread)?;
    schedule_actor(&core, &thread);
    Ok(())
}

/// The sends lane's `run`, for E5.1's worker set.
pub fn runner(core: Rc<Core>) -> crate::workers::WorkerRun {
    Rc::new(move |thread: String| {
        let core = Rc::clone(&core);
        Box::pin(async move { work(core, thread).await })
    })
}

#[cfg(test)]
mod tests;

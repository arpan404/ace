// SPDX-License-Identifier: Apache-2.0
//! `settled-trees.ts` (E5.10): how a settle leaves a thread's queue, which inputs a settled tree
//! retires, and the fence that stops a settle the person has already undone. Settling says the
//! person is done, so nothing the tree started keeps running; a part that fails to stop is the
//! daemon's to report, never the person's.

use std::collections::HashSet;
use std::rc::Rc;

use ace_json::Value;

use crate::{Core, EngineError, State};

/// How a settle leaves a thread's queue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueueHold {
    pub paused: bool,
    pub reason: Option<String>,
}

/// A send that failed, or may have gone, keeps its own hold and reason: it is not retried now,
/// and it still says why it waits.
const KEPT_REASONS: [&str; 3] = ["not_sent", "model_unavailable", "uncertain"];

/// `settledHold`: with nothing to send the queue is released; anything else still to send, the
/// person's messages and child results alike, is held as stopped.
pub fn settled_hold(paused: bool, reason: Option<&str>, waiting_sends: i64) -> QueueHold {
    if waiting_sends == 0 {
        return QueueHold {
            paused: false,
            reason: None,
        };
    }
    if paused
        && let Some(reason) = reason
        && KEPT_REASONS.contains(&reason)
    {
        return QueueHold {
            paused: true,
            reason: Some(reason.to_owned()),
        };
    }
    QueueHold {
        paused: true,
        reason: Some("stopped".to_owned()),
    }
}

/// `latestIntent`: the newest command the thread took, by intent id.
pub fn latest_intent(core: &Core) -> Result<i64, EngineError> {
    // The ledger's high-water mark includes completed commands, which can finish while a
    // provider close is waiting. Reading its highest row id is independent of thread history.
    let row = ace_store::stmt_cache::get_row(
        core.store.conn(),
        "SELECT max(id) AS mark FROM intents",
        Vec::new(),
    )?;
    Ok(row
        .and_then(|row| {
            row.get("mark")
                .and_then(crate::repository::residency::cell_int)
        })
        .unwrap_or(0))
}

/// Whether a newer intent has taken ownership of the thread while the settle was in flight.
pub fn new_delivery(core: &Core, id: &str, mark: i64) -> Result<bool, EngineError> {
    use ace_store::{Value as Cell, stmt_cache};
    Ok(stmt_cache::get_row(
        core.store.conn(),
        "SELECT 1 FROM intents WHERE thread_id=? AND status IN ('pending','queued','running','done','failed')
         AND id>? AND kind IN ('thread.send','thread.create','thread.fork','thread.switch','thread.merge','thread.resume','queue.resume') LIMIT 1",
        vec![Cell::Text(id.to_owned()), Cell::Integer(mark)],
    )?.is_some())
}

/// `retireLiveIntents`: inputs that need a live session end with it; queued sends wait for the
/// thread's next run.
pub fn retire_live_intents(core: &Core, state: &mut State, id: &str) -> Result<(), EngineError> {
    for intent in crate::intents::header::headers(core.store.conn(), Some(id), None)? {
        if crate::liveness::resumable(&intent.kind) {
            continue;
        }
        crate::intents::lifecycle::mark(
            &core.store,
            &intent,
            "failed",
            Some("The thread was settled"),
        )?;
        state.transition_release_guards(&core.store, &intent.command_id)?;
    }
    Ok(())
}

/// The settle's own hold as the queue patch a write takes.
pub fn hold_patch(hold: &QueueHold) -> String {
    format!(
        r#"{{"paused":{},"reason":{},"resumeAt":null,"timerAction":null}}"#,
        hold.paused,
        hold.reason
            .as_deref()
            .map_or("null".to_owned(), |reason| format!("\"{reason}\""))
    )
}

/// Find a settled owner for this local child without enumerating completed threads.
pub(crate) fn settled_root(core: &Core, thread: &str) -> Result<Option<String>, EngineError> {
    core.with_state(|state| {
        let mut settled = None;
        let mut visited = HashSet::new();
        let mut id = thread.to_owned();
        loop {
            if !visited.insert(id.clone()) {
                break;
            }
            if settled_at(core, &id)?.is_some() {
                settled = Some(id.clone());
            }
            let Some(parent) = crate::liveness::reconcile::local_parent(core, state, &id)? else {
                break;
            };
            id = parent;
        }
        Ok(settled)
    })?
}

/// The organizer also writes outside the engine. Sweep only resident work for such settles.
pub(crate) async fn retry_active(core: &Rc<Core>) -> Result<(), EngineError> {
    let threads = core.with_state(|state| crate::actor::live_thread_ids(state))?;
    let mut visited = HashSet::new();
    for thread in threads {
        if core.closing.get() {
            break;
        }
        if let Some(root) = settled_root(core, &thread)?
            && visited.insert(root.clone())
        {
            stop_tree(core, &root).await?;
        }
    }
    Ok(())
}

fn settled_at(core: &Core, thread: &str) -> Result<Option<f64>, EngineError> {
    Ok(crate::recovery::threads::get(&core.store, thread)?
        .and_then(|row| row.client.get("settledAt").and_then(Value::as_f64)))
}

struct Fence<'a> {
    root: &'a str,
    at: f64,
    intent: i64,
}

impl Fence<'_> {
    fn holds(&self, core: &Core) -> Result<bool, EngineError> {
        Ok(settled_at(core, self.root)? == Some(self.at)
            && !new_delivery(core, self.root, self.intent)?)
    }
}

/// Stop the providers and retire live-only inputs, children first. Every suspension gives a
/// newer person command a chance to take ownership before the stop can close another session.
pub async fn stop_tree(core: &Rc<Core>, root: &str) -> Result<(), EngineError> {
    let Some(at) = settled_at(core, root)? else {
        return Ok(());
    };
    let fence = Fence {
        root,
        at,
        intent: latest_intent(core)?,
    };
    let Some(owners) = core.with_state(|state| {
        if state.liveness.settling.contains_key(root) {
            return Ok(None);
        }
        let owners = crate::liveness::thread_tree(core, state, root)?;
        state
            .liveness
            .settling
            .insert(root.to_owned(), core.executor.current());
        Ok::<_, EngineError>(Some(owners))
    })??
    else {
        return Ok(());
    };
    let outcome = stop_owners(core, &fence, owners).await;
    core.with_state(|state| state.liveness.settling.remove(root))?;
    outcome
}

async fn stop_owners(
    core: &Rc<Core>,
    fence: &Fence<'_>,
    owners: Vec<String>,
) -> Result<(), EngineError> {
    for thread in owners.into_iter().rev() {
        if !fence.holds(core)? {
            break;
        }
        if let Err(error) = stop_one(core, fence, &thread).await {
            if !error.skippable_at_startup() {
                return Err(error);
            }
            core.ports.report(format!("{thread}: {error}"));
        }
        crate::actor::yield_once().await;
    }
    Ok(())
}

async fn stop_one(core: &Rc<Core>, fence: &Fence<'_>, thread: &String) -> Result<(), EngineError> {
    let present = core.store.atomic(|_| {
        core.with_state(|state| {
            if state.repo.state(&core.store, thread)?.is_none() {
                return Ok(false);
            }
            retire_live_intents(core, state, thread)?;
            let hold = queue_hold(core, thread)?;
            crate::recovery::capture::discard_holding_in(core, state, thread, hold)?;
            Ok(true)
        })?
    })?;
    if !present || !fence.holds(core)? {
        return Ok(());
    }
    crate::sessions::attach::close_for_settle(core, thread).await?;
    if !fence.holds(core)? {
        return Ok(());
    }
    let waiters = core.with_state(|state| {
        [
            &state.workers.sends,
            &state.workers.controls,
            &state.workers.steering,
        ]
        .into_iter()
        .filter_map(|worker| worker.drain_excluding(thread, core.executor.current()))
        .collect::<Vec<_>>()
    })?;
    for waiter in waiters {
        let _ = waiter.await;
        if !fence.holds(core)? {
            return Ok(());
        }
    }
    crate::actor::mailbox::flush(Rc::clone(core), thread.clone(), core.executor.current()).await;
    if !fence.holds(core)? {
        return Ok(());
    }
    // An open already in progress may have finished during the drain.
    crate::sessions::attach::close_for_settle(core, thread).await?;
    if !fence.holds(core)? {
        return Ok(());
    }
    finish(core, thread)?;
    crate::actor::promotion::evict_now(core, thread);
    Ok(())
}

fn finish(core: &Core, thread: &str) -> Result<(), EngineError> {
    core.store.atomic(|_| {
        core.with_state(|state| {
            let Some(snapshot) = state.repo.state(&core.store, thread)? else {
                return Ok(());
            };
            let mut facts = snapshot.borrow().state.indexes.pending_interactions.keys()
                .map(|key| ace_json::json!({"type":"interaction.closed","interaction":key,"state":"cancelled"}))
                .collect::<Vec<_>>();
            facts.push(ace_json::json!({"type":"process.exited","deliberate":true}));
            facts.push(ace_json::json!({"type":"queue.changed","source":"provider","count":0}));
            let at = core.ports.now();
            state.apply(&core.store, thread, &ace_json::to_string(&Value::Array(facts.into())), at, None)?;
            let queue = crate::queue::store::get(&core.store, thread)?;
            let waiting = crate::queue::store::waiting_sends(core.store.conn(), thread)?;
            let hold = settled_hold(queue.paused, queue.reason.as_deref(), waiting);
            crate::queue::write::set(&core.store, thread, &hold_patch(&hold), at)?;
            crate::queue::holds::sync(core, state, thread, at)?;
            crate::liveness::reconcile::ancestors(core, state, thread)?;
            state.repo.release_slot(&core.store, thread)
        })?
    })
}

fn queue_hold(
    core: &Core,
    thread: &str,
) -> Result<crate::recovery::capture::QueueHold, EngineError> {
    let queue = crate::queue::store::get(&core.store, thread)?;
    let waiting = crate::queue::store::waiting_sends(core.store.conn(), thread)?;
    let hold = settled_hold(queue.paused, queue.reason.as_deref(), waiting);
    let reason = KEPT_REASONS
        .into_iter()
        .chain(["stopped"])
        .find(|reason| hold.reason.as_deref() == Some(*reason));
    Ok(crate::recovery::capture::QueueHold {
        paused: hold.paused,
        reason,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::testsupport::{Shell, header, home};

    #[test]
    fn a_settle_holds_what_is_still_to_send_as_stopped_and_keeps_a_failed_holds_reason() {
        let released = settled_hold(false, None, 0);
        assert_eq!(
            released,
            QueueHold {
                paused: false,
                reason: None
            }
        );
        let stopped = settled_hold(false, None, 2);
        assert_eq!(stopped.reason.as_deref(), Some("stopped"));
        assert!(stopped.paused);
        // A send that failed, or may have gone, keeps its own reason.
        for reason in KEPT_REASONS {
            let kept = settled_hold(true, Some(reason), 1);
            assert_eq!(kept.reason.as_deref(), Some(reason), "{reason}");
            assert!(kept.paused);
        }
        // Any other reason becomes stopped: a paused manual hold with nothing to say is not kept.
        assert_eq!(
            settled_hold(true, Some("manual"), 1).reason.as_deref(),
            Some("stopped")
        );
    }

    #[test]
    fn only_a_new_resumable_delivery_undoes_a_settle() {
        let conn = home("t", &header("t"));
        let (_, shell) = Shell::store_with_controls(&conn);
        let engine = crate::Engine::new(
            shell.clone(),
            shell,
            crate::Inputs::default(),
            "[]",
            Box::new(Pump),
            &conn,
            std::rc::Rc::new(crate::actor::ActorDeps::production(
                std::rc::Rc::new(crate::frames::live::UnportedLive),
                0.0,
            )),
        )
        .expect("engine");
        let core = engine.core();
        conn.exec(
            "INSERT INTO intents (command_id,thread_id,kind,payload,status,delivery,position) VALUES
             ('a','t','thread.send','{}','pending','queue',1)",
        )
        .unwrap();
        let mark = latest_intent(core).unwrap();
        assert!(!new_delivery(core, "t", mark).unwrap());
        // A control the settle itself retired does not undo it.
        conn.exec(
            "INSERT INTO intents (command_id,thread_id,kind,payload,status,delivery,position) VALUES
             ('b','t','thread.interrupt','{}','pending','queue',2)",
        )
        .unwrap();
        assert!(!new_delivery(core, "t", mark).unwrap());
        // A send does; a limit does not.
        conn.exec(
            "INSERT INTO intents (command_id,thread_id,kind,payload,status,delivery,position) VALUES
             ('c','t','thread.limit','{}','pending','queue',3)",
        )
        .unwrap();
        assert!(!new_delivery(core, "t", mark).unwrap());
        conn.exec(
            "INSERT INTO intents (command_id,thread_id,kind,payload,status,delivery,position) VALUES
             ('d','t','thread.send','{}','pending','queue',4)",
        )
        .unwrap();
        assert!(new_delivery(core, "t", mark).unwrap());
    }

    struct Pump;

    impl crate::executor::Notifier for Pump {
        fn notify(&self) -> crate::executor::Notified {
            crate::executor::Notified::Posted
        }
    }
}

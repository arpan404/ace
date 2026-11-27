// SPDX-License-Identifier: Apache-2.0

use std::rc::Rc;

use ace_json::Value;

use crate::executor::Lane;
use crate::intents::{header::Intent, lifecycle, store};
use crate::{Core, EngineError};

pub(super) fn wake(core: &Rc<Core>, thread: &str) -> Result<(), EngineError> {
    let weak = Rc::downgrade(core);
    let run: crate::workers::WorkerRun = Rc::new(move |thread| {
        let weak = weak.clone();
        Box::pin(async move {
            if let Some(core) = weak.upgrade() {
                pass(&core, &thread).await?;
            }
            Ok(())
        })
    });
    core.with_state(|state| state.workers.controls.wake(thread, &core.executor, run))
}

/// Reclaims and background stops run on the control lane, even while a sends pass waits for I/O.
async fn pass(core: &Rc<Core>, thread: &str) -> Result<(), EngineError> {
    crate::actor::mailbox::flush(Rc::clone(core), thread.to_owned(), core.executor.current()).await;
    let (blocked, retire) = core.with_state(|state| {
        (
            state.repo.cleaning(thread)
                || crate::cursor_reconcile::holds(state, thread)
                || state.actors.get(thread).is_some_and(|actor| actor.poisoned),
            state
                .actors
                .get(thread)
                .is_some_and(|actor| actor.idle_due && actor.session_attached),
        )
    })?;
    if blocked || core.closing.get() {
        return Ok(());
    }
    if retire {
        crate::sessions::attach::close_idle(core, &thread.to_owned()).await?;
        core.with_state(|state| {
            state.repo.retiring.remove(thread);
            if let Some(mut actor) = state.actors.get_mut(thread) {
                actor.idle_due = false;
            }
        })?;
        core.defer(crate::executor::Deferred::Wake(
            thread.to_owned(),
            Lane::Work,
        ));
    }
    let controls = store::controls(core.store.conn(), thread)?;
    let fenced = super::fenced(core, thread)?;
    let mut processed = 0;
    for header in crate::moves::admitted_controls(&controls, fenced) {
        if core.closing.get()
            || core.with_state(|state| {
                state.repo.cleaning(thread) || crate::cursor_reconcile::holds(state, thread)
            })?
        {
            break;
        }
        if !matches!(
            header.kind.as_str(),
            "background_task.stop" | "thread.interrupt"
        ) {
            continue;
        }
        let guard =
            core.with_state(|state| state.transition_guard_owner(&core.store, thread))??;
        if guard
            .as_deref()
            .is_some_and(|guard| guard != header.command_id)
        {
            continue;
        }
        let Some(intent) = lifecycle::claim(&core.store, header)? else {
            continue;
        };
        match execute(core, &intent).await {
            Ok(()) => lifecycle::mark(&core.store, &intent.header, "done", None)?,
            Err(error) => lifecycle::mark(
                &core.store,
                &intent.header,
                "failed",
                Some(&error.to_string()),
            )?,
        }
        processed += 1;
    }
    super::release_dormant(core, thread)?;
    if controls.len() == 64 && processed != 0 {
        core.defer(crate::executor::Deferred::Wake(
            thread.to_owned(),
            Lane::Control,
        ));
    }
    Ok(())
}

async fn execute(core: &Rc<Core>, intent: &Intent) -> Result<(), EngineError> {
    let thread = &intent.header.thread_id;
    let session = core.with_state(|state| {
        state
            .sessions
            .attached
            .get(thread)
            .map(|attached| Rc::clone(&attached.session))
    })?;
    let payload = crate::commands::payload(&intent.command);
    if intent.header.kind == "thread.interrupt" {
        if let Some(session) = session {
            session
                .interrupt(ace_adapter_api::session::InterruptTarget {
                    agent: payload
                        .get("agentId")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    cascade: payload
                        .get("cascade")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                })
                .await
                .map_err(|error| EngineError::Records(error.to_string()))?;
        }
        return Ok(());
    }

    let task = payload
        .get("taskId")
        .and_then(Value::as_str)
        .ok_or(EngineError::InvalidRecord)?;
    let key = core.with_state(|state| {
        let Some(key) = state.native_entity(&core.store, thread, "tasks", task)? else {
            return Ok(None);
        };
        let Some(snapshot) = state.repo.state(&core.store, thread)? else {
            return Ok(None);
        };
        let task = snapshot.borrow_mut().task(&key)?;
        match task {
            Some(task) if task.status == "running" && task.stoppable => Ok(Some(key)),
            Some(task) if task.status == "running" => Err(EngineError::Records(
                "The task no longer supports Stop".to_owned(),
            )),
            _ => Ok(None),
        }
    })??;
    if let Some(key) = key {
        let session = session.ok_or_else(|| {
            EngineError::Records("Owning provider session is no longer running".to_owned())
        })?;
        session
            .stop_task(key)
            .await
            .map_err(|error| EngineError::Records(error.to_string()))?;
    }
    Ok(())
}

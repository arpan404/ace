// SPDX-License-Identifier: Apache-2.0
//! The transition intents' execution (`intent-delivery.ts:84`): after a transition's receipt
//! commits, and on restart, the thread's queued `thread.merge` runs and settles itself.
//!
//! A merge needs no session, so it lands here complete. A switch's execution awaits E5.6's
//! sessions and models ports (closing the source session and preparing the destination model),
//! so its intent stays queued for that item's dispatcher instead of being claimed and failed.

use ace_json::Value;
use std::rc::Rc;

use crate::commands::payload;
use crate::executor::{Deferred, Lane};
use crate::intents::header::Intent;
use crate::intents::lifecycle;
use crate::transitions::execute::{self, MergeRequest};
use crate::{Core, EngineError, State};

/// After a transition receipt commits, run the thread's queued transition intent. The receipt
/// runs inside the shell's transaction, so the work is deferred to the commit and then to the
/// pump, never inline.
pub fn schedule(core: &Rc<Core>, thread: &str) {
    let weak = Rc::downgrade(core);
    let thread = thread.to_owned();
    core.defer(Deferred::Spawn(
        Lane::Work,
        Box::pin(async move {
            if let Some(core) = weak.upgrade() {
                let outcome = core.with_state(|state| run_thread(&core, state, &thread));
                report(&core, thread.as_str(), outcome);
            }
        }),
    ));
}

/// On restart, resume a thread's queued transition.
pub fn recover_thread(core: &Rc<Core>, state: &mut State, thread: &str) -> Result<(), EngineError> {
    run_thread(core, state, thread)
}

fn report(core: &Rc<Core>, thread: &str, outcome: Result<Result<(), EngineError>, EngineError>) {
    match outcome {
        Ok(Ok(())) => {}
        Ok(Err(error)) | Err(error) => core.ports.report(format!("{thread}: {error}")),
    }
}

/// Claim and execute the transition intents `thread` has queued, up to the merge queue's
/// capacity, so a restart with several merges runs all of them and none stays pending.
pub fn run_thread(core: &Rc<Core>, state: &mut State, thread: &str) -> Result<(), EngineError> {
    for _ in 0..8 {
        let Some(header) = crate::intents::store::transition(core.store.conn(), thread)? else {
            return Ok(());
        };
        // A switch's execution is E5.6's: its intent waits, unclaimed, for that item's own
        // dispatcher, and nothing behind it may be assumed to have run.
        if header.kind != "thread.merge" {
            return Ok(());
        }
        let Some(intent) = lifecycle::claim(&core.store, &header)? else {
            continue;
        };
        if let Err(error) = run_merge(core, state, &intent) {
            fail(core, state, &intent, &error)?;
        }
    }
    Ok(())
}

fn run_merge(core: &Rc<Core>, state: &mut State, intent: &Intent) -> Result<(), EngineError> {
    let command = &intent.command;
    let fork = payload(command)
        .get("threadId")
        .and_then(Value::as_str)
        .ok_or_else(|| EngineError::Records("merge payload".into()))?;
    let summary = payload(command)
        .get("summary")
        .cloned()
        .unwrap_or(Value::Null);
    let citations = payload(command)
        .get("citations")
        .cloned()
        .unwrap_or(Value::Array(vec![].into()));
    let patch = payload(command).get("patch").filter(|p| !p.is_null());
    execute::merge(
        &core.store,
        state,
        &intent.header.thread_id,
        fork,
        MergeRequest {
            summary: &summary,
            citations: &citations,
            intent_id: intent.header.id,
            intent: Some(&intent.header),
            patch_applied: patch.is_some(),
            now: core.ports.now(),
        },
    )
}

/// A merge that cannot land fails here: the intent records why and the guards it held go with
/// it, in one transaction, so neither can outlive the other.
fn fail(
    core: &Rc<Core>,
    state: &mut State,
    intent: &Intent,
    error: &EngineError,
) -> Result<(), EngineError> {
    core.store.atomic(|_tx| {
        lifecycle::mark(
            &core.store,
            &intent.header,
            "failed",
            Some(&error.to_string()),
        )?;
        state.transition_release_guards(&core.store, &intent.header.command_id)?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use crate::repository::testsupport::{Shell, header, home};

    // A switch's intent waits for the item that can execute it, and is never claimed and
    // failed as if the merge path had run it.
    #[test]
    fn a_switch_intent_is_left_queued_for_the_sessions_item() {
        let conn = home("t", &header("t"));
        let store = Shell::store(&conn);
        conn.exec(
            "INSERT INTO intents (command_id,thread_id,kind,payload,status,position) VALUES ('sw','t','thread.switch','{}','pending',1)",
        )
        .expect("intent");
        let header = crate::intents::store::transition(store.conn(), "t")
            .expect("read")
            .expect("an intent");
        assert_eq!(header.kind, "thread.switch");
        // No claim happens outside a dispatcher; the row is exactly as it was.
        let status = crate::intents::store::command_status(store.conn(), "sw").expect("status");
        assert_eq!(status.as_deref(), Some("pending"));
    }
}

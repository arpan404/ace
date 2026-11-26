// SPDX-License-Identifier: Apache-2.0
//! A Cursor send the daemon saw attempted but never saw admitted (`cursor-attempt.ts`): settled
//! from what a reopened host read back from Cursor's store (ADR 0043, amendment of 2026-11-22).
//! Cursor has a run for it: the input is Cursor's, acknowledged with a notice. Cursor has none and
//! ace recorded only the attempt: it never reached Cursor, so it goes back in the queue and is
//! sent once. Anything else stays held for the person, never claiming it wasn't sent.

use ace_json::Value;

use crate::intents::header::Intent;
use crate::queue::{store as queue_store, write as queue_write};
use crate::{Core, EngineError, State};

/// What a re-queued message's notice says while it waits for Cursor's acknowledgement.
pub const RESENDING_CODE: &str = "delivery_resending";

const REQUEUED_TITLE: &str = "Queued to send again";
const REQUEUED_TEXT: &str =
    "ace restarted before Cursor received this message, so it is queued to send again";
const UNCONFIRMED_TITLE: &str = "Delivery unconfirmed";
const UNCONFIRMED_TEXT: &str = "ace couldn't confirm whether Cursor received this message. It is held in the queue: check the conversation before sending it again";

/// True when settling would send an attempted send again as never admitted
/// (`requeueNeedsProof`).
pub fn requeue_needs_proof(core: &Core, thread: &str) -> Result<bool, EngineError> {
    let admission = super::provider_recovery::last_admission(core.store.conn(), thread)?;
    let Some((Some(command_id), admitted)) = admission else {
        return Ok(false);
    };
    if admitted {
        return Ok(false);
    }
    may_requeue(core, thread, &command_id)
}

/// True when an attempted send, read back as never admitted, would be sent again (`mayRequeue`).
pub fn may_requeue(core: &Core, thread: &str, command_id: &str) -> Result<bool, EngineError> {
    if crate::intents::store::uncertain_send(core.store.conn(), thread, command_id)?.is_none() {
        return Ok(false);
    }
    Ok(!super::provider_recovery::admission_recorded(
        core.store.conn(),
        thread,
        command_id,
    )?)
}

/// The held sends whose fate a reopen couldn't read (`inDoubt`): the attempted one, or, for an
/// earlier build's thread whose attempt is past the frames it kept (no command id), every send
/// held as uncertain.
pub fn in_doubt(core: &Core, thread: &str) -> Result<Vec<Intent>, EngineError> {
    if let Some(command) = super::provider_recovery::attempted_command(core.store.conn(), thread)?
        && let Some(intent) =
            crate::intents::store::uncertain_send(core.store.conn(), thread, &command)?
    {
        return Ok(vec![intent]);
    }
    if super::provider_recovery::unknown_attempt(core.store.conn(), thread)? {
        return crate::intents::store::uncertain_sends(core.store.conn(), thread);
    }
    Ok(Vec::new())
}

/// `settleCursorAttempt` (`:46`): one transaction, after every Cursor open. `verified` says the
/// previous run's process groups are proven gone, so an empty read of the store is final.
pub fn settle_cursor_attempt(
    core: &Core,
    state: &mut State,
    thread: &str,
    at: f64,
    verified: bool,
) -> Result<(), EngineError> {
    let admission = super::provider_recovery::last_admission(core.store.conn(), thread)?;
    let Some((command_id, admitted)) = admission else {
        // The host read nothing back of the attempt: its fate is unknown, and the thread says
        // that, not the restart's "not sent".
        let waiting = in_doubt(core, thread)?;
        if waiting.is_empty() {
            return Ok(());
        }
        for intent in &waiting {
            unconfirmed(core, state, thread, intent.header.id, at)?;
        }
        // Nothing more will come of the attempt: the thread waits on the person, not on Cursor.
        let root = root_key(core, state, thread)?;
        let mut fact = ace_json::Map::new();
        fact.insert("type", Value::from("wake.expected"));
        fact.insert("agent", Value::from(root.as_str()));
        fact.insert("until", Value::from(at as i64));
        apply(core, state, thread, &[Value::Object(fact)], at)?;
        return Ok(());
    };
    let Some(command_id) = command_id else {
        return Ok(());
    };
    let Some(intent) =
        crate::intents::store::uncertain_send(core.store.conn(), thread, &command_id)?
    else {
        return Ok(());
    };
    if admitted {
        acknowledge(core, state, thread, intent.header.id, &command_id, at)?;
    } else if verified
        && !super::provider_recovery::admission_recorded(core.store.conn(), thread, &command_id)?
    {
        queue_store::set_uncertain(core.store.conn(), intent.header.id, false)?;
        crate::intents::lifecycle::defer(core.store.conn(), &intent.header)?;
        queue_store::track_attachments(
            core.store.conn(),
            intent.header.id,
            thread,
            &intent.command,
        )?;
        say(core, state, thread, intent.header.id, at, Notice::Requeued)?;
    } else {
        unconfirmed(core, state, thread, intent.header.id, at)?;
        return Ok(());
    }
    let staged = queue_write::reconcile_uncertainty(&core.store, thread, at)?;
    queue_write::finish(&core.store, &staged)?;
    let queue = queue_store::get(&core.store, thread)?;
    // Held only for this send's uncertainty: nothing else waits on the person.
    if queue.paused
        && queue.continuation.is_none()
        && !queue.limited
        && queue.reason.as_deref() == Some("manual")
    {
        queue_write::set(&core.store, thread, r#"{"paused":false,"reason":null}"#, at)?;
    }
    Ok(())
}

/// `acknowledge` (`:98`): Cursor had the message; the delivery notice says so and a waiting
/// handoff is cleared, as a run start would have done.
fn acknowledge(
    core: &Core,
    state: &mut State,
    thread: &str,
    intent_id: i64,
    command_id: &str,
    at: f64,
) -> Result<(), EngineError> {
    let rows = state.acknowledge_command(&core.store, thread, command_id)?;
    for row in &rows {
        crate::queue::messages::prune(core.store.conn(), *row)?;
    }
    if !rows.contains(&intent_id) {
        return Ok(());
    }
    state.transition_delivered(&core.store, thread)?;
    let root = root_key(core, state, thread)?;
    let prior = prior_notice(state, thread, intent_id);
    if prior.as_ref().and_then(|(code, _)| code.as_deref()) == Some("delivery_uncertain") {
        let mut notice = ace_json::Map::new();
        notice.insert("type", Value::from("notice"));
        notice.insert("level", Value::from("info"));
        notice.insert("code", Value::from("delivery_confirmed"));
        notice.insert("title", Value::from("Message received"));
        notice.insert(
            "text",
            Value::from("Cursor had this message before ace restarted"),
        );
        notice.insert("complete", Value::Bool(true));
        let mut fact = ace_json::Map::new();
        fact.insert("type", Value::from("item.upsert"));
        fact.insert("agent", Value::from(root.as_str()));
        fact.insert("item", Value::from(format!("intent:{intent_id}")));
        fact.insert("draft", Value::Object(notice));
        apply(core, state, thread, &[Value::Object(fact)], at)?;
    }
    Ok(())
}

/// The notice a settled or doubtful send leaves.
#[derive(Debug, Clone, Copy)]
enum Notice {
    Requeued,
    Unconfirmed,
}

/// A send whose fate couldn't be settled (`unconfirmed`): the thread says the fate is unknown,
/// never that it wasn't sent (a resend by hand could then be a second copy).
pub fn unconfirmed(
    core: &Core,
    state: &mut State,
    thread: &str,
    intent_id: i64,
    at: f64,
) -> Result<(), EngineError> {
    say(core, state, thread, intent_id, at, Notice::Unconfirmed)
}

fn say(
    core: &Core,
    state: &mut State,
    thread: &str,
    intent_id: i64,
    at: f64,
    notice: Notice,
) -> Result<(), EngineError> {
    let root = root_key(core, state, thread)?;
    let key = format!("intent:{intent_id}");
    let prior = prior_notice(state, thread, intent_id);
    let mut draft = ace_json::Map::new();
    draft.insert("type", Value::from("notice"));
    let (code, level, title, text) = match notice {
        Notice::Requeued => (RESENDING_CODE, "info", REQUEUED_TITLE, REQUEUED_TEXT),
        Notice::Unconfirmed => (
            "delivery_uncertain",
            "warning",
            UNCONFIRMED_TITLE,
            UNCONFIRMED_TEXT,
        ),
    };
    draft.insert("code", Value::from(code));
    draft.insert("level", Value::from(level));
    draft.insert("title", Value::from(title));
    draft.insert("text", Value::from(text));
    if let Some(command_id) = prior
        .as_ref()
        .and_then(|(_, command_id)| command_id.clone())
    {
        draft.insert("commandId", Value::from(command_id));
    }
    draft.insert("complete", Value::Bool(true));
    let mut fact = ace_json::Map::new();
    fact.insert("type", Value::from("item.upsert"));
    fact.insert("agent", Value::from(root.as_str()));
    fact.insert("item", Value::from(key));
    fact.insert("draft", Value::Object(draft));
    apply(core, state, thread, &[Value::Object(fact)], at)
}

/// The stored notice's code and command id, when the intent's item is a notice.
fn prior_notice(
    state: &State,
    thread: &str,
    intent_id: i64,
) -> Option<(Option<String>, Option<String>)> {
    let snapshot = state.repo.snapshots.get(thread)?;
    let borrowed = snapshot.try_borrow().ok()?;
    let item = borrowed.state.items.get(&format!("intent:{intent_id}"))?;
    match item {
        ace_core::items::Item::Notice {
            code, command_id, ..
        } => Some((code.clone(), command_id.clone())),
        _ => None,
    }
}

/// The thread's root agent key (`rootKey`, `"root"` when absent).
fn root_key(core: &Core, state: &mut State, thread: &str) -> Result<String, EngineError> {
    let snapshot = state.repo.require_state(&core.store, thread)?;
    let key = {
        let borrowed = snapshot.try_borrow().map_err(|_| EngineError::Reentrant)?;
        borrowed
            .state
            .root_key
            .clone()
            .unwrap_or_else(|| "root".to_owned())
    };
    Ok(key)
}

/// `repo.apply`: the facts in the thread's own transaction.
fn apply(
    core: &Core,
    state: &mut State,
    thread: &str,
    facts: &[Value],
    at: f64,
) -> Result<(), EngineError> {
    state.apply(
        &core.store,
        thread,
        &ace_json::to_string(&Value::Array(facts.to_vec().into())),
        at,
        None,
    )
}

#[cfg(test)]
mod tests;

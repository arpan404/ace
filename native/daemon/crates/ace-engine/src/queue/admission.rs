// SPDX-License-Identifier: Apache-2.0
//! `Recovery`'s preferences and send admission (`recovery.ts:91`-`:110`, `:130`-`:200`, E5.4d):
//! the follow-up behaviour, the input budget, a dropped restated selection and the loop guard.

use crate::repository::residency::cell_text;
use crate::{Core, EngineError, State};
use ace_json::Value;

/// The defaults a thread without its own preferences follows (`recovery.ts:23`).
pub const DEFAULT_PREFERENCES: &str = r#"{"followUpBehavior":"queue","limitPolicy":"manual"}"#;

/// The most inputs one thread may have in flight (`recovery.ts:135`).
pub const MAX_INPUTS: i64 = 256;
/// The largest command a send may carry (`maxMessageBytes`).
const MAX_MESSAGE_BYTES: usize = 256 * 1024;
const PREFERENCES: &str = "SELECT preferences FROM engine_queue WHERE thread_id=?";
const CLEAR_STREAK: &str = "DELETE FROM engine_restart_resumes WHERE thread_id=?";

/// `RecoveryPreferences.parse` with its defaults: an unknown follow-up falls back to `queue`.
pub fn preferences(value: Option<&Value>, defaults: &Value) -> Value {
    let source = value.unwrap_or(defaults);
    let mut preferences = ace_json::Map::new();
    let follow = source.get("followUpBehavior").and_then(Value::as_str);
    preferences.insert(
        "followUpBehavior",
        Value::from(if follow == Some("steer") {
            "steer"
        } else {
            "queue"
        }),
    );
    let policy = source.get("limitPolicy").and_then(Value::as_str);
    preferences.insert(
        "limitPolicy",
        Value::from(
            if [
                "manual",
                "resume_at_reset",
                "snooze_until_reset",
                "migrate_now",
            ]
            .contains(&policy.unwrap_or_default())
            {
                policy.unwrap_or("manual")
            } else {
                "manual"
            },
        ),
    );
    Value::Object(preferences)
}

/// `recovery.preferences(id)`: the thread's stored preferences, else the engine's defaults.
pub fn thread_preferences(core: &Core, state: &State, thread: &str) -> Result<Value, EngineError> {
    let row = ace_store::stmt_cache::get_row(
        core.store.conn(),
        PREFERENCES,
        vec![ace_store::Value::Text(thread.to_owned())],
    )?;
    let stored = row.and_then(|row| {
        row.get("preferences")
            .and_then(cell_text)
            .map(str::to_owned)
    });
    let parsed = stored
        .as_deref()
        .and_then(|text| ace_json::parse(text).ok());
    let defaults = if state.recovery.defaults.is_null() {
        ace_json::parse(DEFAULT_PREFERENCES).unwrap_or(Value::Null)
    } else {
        state.recovery.defaults.clone()
    };
    Ok(preferences(parsed.as_ref(), &defaults))
}

/// `RestartStreaks.clear` (`restart-resume.ts:98`): new input ends the run of restarts.
pub fn clear_restart_streak(
    conn: &std::sync::Arc<ace_store::Connection>,
    thread: &str,
) -> Result<(), EngineError> {
    ace_store::stmt_cache::run(
        conn,
        CLEAR_STREAK,
        vec![ace_store::Value::Text(thread.to_owned())],
    )?;
    Ok(())
}

/// `recovery.admit`: `None` refuses with `queue_capacity_exceeded`; `Some` is the command to
/// admit, with a restated selection dropped and an omitted delivery filled in.
pub fn admit(
    core: &Core,
    state: &mut State,
    command: &Value,
    thread: &str,
) -> Result<Option<Value>, EngineError> {
    if !is_send(command) {
        return Ok(Some(command.clone()));
    }
    clear_restart_streak(core.store.conn(), thread)?;
    let bytes = ace_json::to_string(command).len();
    if !state.input_capacity(&core.store, thread, MAX_INPUTS)? || bytes > MAX_MESSAGE_BYTES {
        return Ok(None);
    }
    let sent = without_restated_selection(core, state, command, thread)?;
    let payload = sent.get("payload").cloned().unwrap_or(Value::Null);
    if payload.get("type").and_then(Value::as_str) != Some("thread.send")
        || payload.get("delivery").is_some()
    {
        return Ok(Some(sent));
    }
    let chosen = thread_preferences(core, state, thread)?;
    let delivery = chosen
        .get("followUpBehavior")
        .and_then(Value::as_str)
        .unwrap_or("queue");
    let mut replaced = payload;
    if let Some(map) = replaced.as_object_mut() {
        map.insert("delivery", Value::from(delivery));
    }
    let mut out = sent;
    if let Some(map) = out.as_object_mut() {
        map.insert("payload", replaced);
    }
    Ok(Some(crate::intents::command::normalize(&out)?))
}

/// A send or create: the payloads new input arrives as.
pub fn is_send(command: &Value) -> bool {
    matches!(
        command
            .get("payload")
            .and_then(|payload| payload.get("type"))
            .and_then(Value::as_str),
        Some("thread.send") | Some("thread.create")
    )
}

/// `withoutRestatedSelection`: a send that repeats what the thread runs on keeps no selection.
fn without_restated_selection(
    core: &Core,
    state: &mut State,
    command: &Value,
    thread: &str,
) -> Result<Value, EngineError> {
    let Some(payload) = command.get("payload") else {
        return Ok(command.clone());
    };
    if payload.get("type").and_then(Value::as_str) != Some("thread.send") {
        return Ok(command.clone());
    }
    let selection = state.transition_get(&core.store, thread)?.selection;
    if !crate::rules::restates_selection(selection.as_ref(), payload)
        || state.transition_guarded(&core.store, thread)?
        || crate::intents::store::selection_ahead(core.store.conn(), thread)?
    {
        return Ok(command.clone());
    }
    let mut stripped = payload.clone();
    if let Some(map) = stripped.as_object_mut() {
        map.shift_remove("model");
        map.shift_remove("options");
    }
    let mut out = command.clone();
    if let Some(map) = out.as_object_mut() {
        map.insert("payload", stripped);
    }
    crate::intents::command::normalize(&out)
}

// SPDX-License-Identifier: Apache-2.0
//! The input journal (`input-journal.ts:106`-`:294`, E5.4b): durable, indexed echo correlation.
//! Transcript history is never scanned on a frame.
//!
//! Every statement is the TypeScript's text, character for character, through the shared
//! connection's cached statements. The journal runs inside the caller's transaction; the
//! TypeScript's own `store.atomic` calls are the caller's frame (the receipt's or the fold's), so
//! a throw rolls the caller back exactly as `identify`'s nested savepoint would.

use ace_json::Value;
use ace_store::{Value as SqlValue, stmt_cache};
use std::sync::Arc;

use crate::EngineError;
use crate::inputs::origin::{message_origin, person_input};
use crate::inputs::signature::{provider_input, signature};
use crate::repository::residency::{cell_text, text};

pub const ORIGIN: &str = "SELECT origin FROM engine_inputs WHERE thread_id=? AND item_key=?";
pub const IDENTITY: &str =
    "SELECT command_id FROM engine_input_identities WHERE thread_id=? AND native_id=?";
pub const IDENTIFY: &str = "INSERT OR IGNORE INTO engine_input_identities VALUES (?,?,?)";
pub const ATTACH_RUN: &str = "UPDATE engine_inputs SET run_id=? WHERE thread_id=? AND item_key=?";
pub const RUN_OF: &str = "SELECT run_id FROM engine_inputs WHERE thread_id=? AND item_key=?";
pub const REPLACE: &str = "INSERT OR IGNORE INTO engine_input_replacements VALUES (?,?,?)";
pub const REPLACEMENT: &str =
    "SELECT replacement_id FROM engine_input_replacements WHERE thread_id=? AND command_id=?";
pub const KEY_FOR: &str =
    "SELECT command_id FROM engine_input_identities WHERE thread_id=? AND native_id=?";
pub const SENT_IN: &str =
    "SELECT 1 FROM engine_inputs WHERE thread_id=? AND item_key=? AND sent=1 AND generation IS ?";
pub const BIND_SENT: &str = "UPDATE engine_inputs SET run_id=? WHERE thread_id=? AND sent=1 AND run_id IS NULL AND generation IS ? RETURNING item_key";
pub const IN_RUNS: &str = "SELECT item_key FROM engine_inputs WHERE thread_id=? AND run_id=?";
pub const INVALIDATE_ECHO: &str =
    "DELETE FROM engine_input_echoes WHERE thread_id=? AND item_key=?";
pub const INVALIDATE: &str = "DELETE FROM engine_inputs WHERE thread_id=? AND item_key=?";
pub const RESTAMP: &str = "UPDATE engine_inputs SET origin=? WHERE thread_id=? AND item_key=?";
pub const REGISTER: &str =
    "INSERT OR IGNORE INTO engine_inputs(thread_id,item_key,signature,origin) VALUES (?,?,?,?)";
pub const SENDING: &str =
    "UPDATE engine_inputs SET signature=?,sent=1,generation=? WHERE thread_id=? AND item_key=?";
pub const ECHO_ALIAS: &str = "SELECT e.item_key FROM engine_input_echoes e JOIN engine_inputs i ON i.thread_id=e.thread_id AND i.item_key=e.item_key WHERE e.thread_id=? AND e.native_key=? AND (? IS NULL OR i.generation=?)";
pub const BY_SIGNATURE: &str = "SELECT item_key,origin FROM engine_inputs WHERE thread_id=? AND signature=? AND generation IS ? AND sent=1 AND matched=0 ORDER BY ordinal LIMIT 1";
pub const MATCHED: &str = "UPDATE engine_inputs SET matched=1 WHERE thread_id=? AND item_key=?";
pub const ECHO: &str = "INSERT OR IGNORE INTO engine_input_echoes VALUES (?,?,?)";

/// A generation parameter: absent binds NULL, so `generation IS ?` stays.
pub(crate) fn generation(value: Option<f64>) -> SqlValue {
    match value {
        None => SqlValue::Null,
        Some(number) => SqlValue::Real(number),
    }
}

/// A row cell as text.
fn row_text(row: &stmt_cache::Row, column: &str) -> Option<String> {
    row.get(column).and_then(cell_text).map(str::to_owned)
}

/// The stored origin of an input, validated as `MessageOrigin.parse` does.
pub fn origin(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    key: &str,
) -> Result<Option<Value>, EngineError> {
    let row = stmt_cache::get_row(conn, ORIGIN, vec![text(thread), text(key)])?;
    let Some(stored) = row.as_ref().and_then(|row| row_text(row, "origin")) else {
        return Ok(None);
    };
    match message_origin(&stored) {
        Some(origin) => Ok(Some(origin)),
        None => Err(EngineError::Records("Invalid message origin".to_owned())),
    }
}

/// `identify`: native metadata supplies identity only.
pub fn identify(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    identity: &Value,
) -> Result<(), EngineError> {
    let command_id = identity
        .get("commandId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| EngineError::Records("Invalid input identity".to_owned()))?;
    let native_id = identity
        .get("nativeId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.encode_utf16().count() <= 256)
        .ok_or_else(|| EngineError::Records("Invalid input identity".to_owned()))?;
    let previous = stmt_cache::get_row(conn, IDENTITY, vec![text(thread), text(native_id)])?;
    if let Some(previous) = previous
        .as_ref()
        .and_then(|row| row_text(row, "command_id"))
        && previous != command_id
    {
        return Err(EngineError::Records(
            "Provider reused an input message identity for a different command".to_owned(),
        ));
    }
    stmt_cache::run(
        conn,
        IDENTIFY,
        vec![text(thread), text(native_id), text(command_id)],
    )?;
    Ok(())
}

/// The run a delivery hands this input to; none until a run consumes it.
pub fn attach_run(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    key: &str,
    run: Option<&str>,
) -> Result<(), EngineError> {
    let run = match run {
        None => SqlValue::Null,
        Some(run) => text(run),
    };
    stmt_cache::run(conn, ATTACH_RUN, vec![run, text(thread), text(key)])?;
    Ok(())
}

/// The run that took input `key`; none until one does.
pub fn run_of(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    key: &str,
) -> Result<Option<String>, EngineError> {
    let row = stmt_cache::get_row(conn, RUN_OF, vec![text(thread), text(key)])?;
    Ok(row.as_ref().and_then(|row| row_text(row, "run_id")))
}

/// Input `command_id` was sent again as `replacement` (a queue resend).
pub fn replace(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    command_id: &str,
    replacement: &str,
) -> Result<(), EngineError> {
    stmt_cache::run(
        conn,
        REPLACE,
        vec![text(thread), text(command_id), text(replacement)],
    )?;
    Ok(())
}

/// The command that replaced input `command_id`, if it was sent again.
pub fn replacement(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    command_id: &str,
) -> Result<Option<String>, EngineError> {
    let row = stmt_cache::get_row(conn, REPLACEMENT, vec![text(thread), text(command_id)])?;
    Ok(row.as_ref().and_then(|row| row_text(row, "replacement_id")))
}

/// The transcript key of the input whose send carried native id `native_id`.
pub fn key_for(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    native_id: &str,
) -> Result<Option<String>, EngineError> {
    let row = stmt_cache::get_row(conn, KEY_FOR, vec![text(thread), text(native_id)])?;
    Ok(row
        .as_ref()
        .and_then(|row| row_text(row, "command_id"))
        .map(|command| format!("input:{command}")))
}

/// Whether session `generation` was handed this input: only its own deliveries bind runs.
pub fn sent_in(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    key: &str,
    generation_value: Option<f64>,
) -> Result<bool, EngineError> {
    let row = stmt_cache::get_row(
        conn,
        SENT_IN,
        vec![text(thread), text(key), generation(generation_value)],
    )?;
    Ok(row.is_some())
}

/// Inputs session `generation` was handed that no run has taken yet now belong to `run`.
pub fn bind_sent(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    run: &str,
    generation_value: Option<f64>,
) -> Result<Vec<String>, EngineError> {
    let rows = stmt_cache::all_rows(
        conn,
        BIND_SENT,
        vec![text(run), text(thread), generation(generation_value)],
    )?;
    Ok(rows
        .iter()
        .filter_map(|row| row_text(row, "item_key"))
        .collect())
}

/// The inputs any of `runs` took, in the runs' order.
pub fn in_runs(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    runs: &[String],
) -> Result<Vec<String>, EngineError> {
    let mut keys = Vec::new();
    for run in runs {
        let rows = stmt_cache::all_rows(conn, IN_RUNS, vec![text(thread), text(run)])?;
        keys.extend(rows.iter().filter_map(|row| row_text(row, "item_key")));
    }
    Ok(keys)
}

/// Takes an input out of delivery.
pub fn invalidate(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    key: &str,
) -> Result<(), EngineError> {
    stmt_cache::run(conn, INVALIDATE_ECHO, vec![text(thread), text(key)])?;
    stmt_cache::run(conn, INVALIDATE, vec![text(thread), text(key)])?;
    Ok(())
}

/// Correct an accepted input's origin once its delivery is known (a steer into a run).
pub fn restamp(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    key: &str,
    origin: &Value,
) -> Result<(), EngineError> {
    stmt_cache::run(
        conn,
        RESTAMP,
        vec![text(&ace_json::to_string(origin)), text(thread), text(key)],
    )?;
    Ok(())
}

/// Keep the signature of the person's parts and the origin at acceptance.
pub fn register(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    key: &str,
    parts: &[Value],
    origin: &Value,
) -> Result<(), EngineError> {
    stmt_cache::run(
        conn,
        REGISTER,
        vec![
            text(thread),
            text(key),
            text(&signature(parts)),
            text(&ace_json::to_string(origin)),
        ],
    )?;
    Ok(())
}

/// Re-sign with the provider's own rendering and record the generation at delivery.
pub fn sending(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    key: &str,
    parts: &[Value],
    provider: Option<&str>,
    generation_value: Option<f64>,
) -> Result<(), EngineError> {
    let rendered = provider_input(parts, provider)?;
    stmt_cache::run(
        conn,
        SENDING,
        vec![
            text(&signature(&rendered)),
            generation(generation_value),
            text(thread),
            text(key),
        ],
    )?;
    Ok(())
}

/// Match a root user message to the input it echoes, rewriting the fact to that input's key.
pub fn correlate(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    fact: Value,
    root: &str,
    generation_value: Option<f64>,
) -> Result<Option<Value>, EngineError> {
    let kind = fact.get("type").and_then(Value::as_str).unwrap_or_default();
    let draft = fact.get("draft");
    if (kind != "item.upsert" && kind != "item.reconciled")
        || fact.get("agent").and_then(Value::as_str) != Some(root)
        || draft
            .and_then(|draft| draft.get("type"))
            .and_then(Value::as_str)
            != Some("message")
        || draft
            .and_then(|draft| draft.get("role"))
            .and_then(Value::as_str)
            == Some("assistant")
    {
        return Ok(Some(fact));
    }
    let Some(draft) = draft.cloned() else {
        return Ok(Some(fact));
    };
    let item = fact.get("item").and_then(Value::as_str).unwrap_or_default();
    let native_id = draft.get("nativeId").and_then(Value::as_str);
    let command_id = match native_id {
        Some(native_id) => identify_command(conn, thread, native_id)?,
        None => None,
    };
    if let Some(command_id) = command_id.as_deref()
        && origin(conn, thread, &format!("input:{command_id}"))?.is_none()
    {
        let mut rewritten = fact;
        let mut origin = ace_json::Map::new();
        origin.insert("kind", Value::from("person"));
        origin.insert("commandId", Value::from(command_id));
        if let Some(object) = rewritten.as_object_mut()
            && let Some(draft) = object.get_mut("draft").and_then(Value::as_object_mut)
        {
            draft.insert("origin", Value::Object(origin));
            draft.insert("synthetic", Value::Bool(false));
        }
        return Ok(Some(rewritten));
    }
    let alias = match command_id.as_deref() {
        Some(command_id) => Some(format!("input:{command_id}")),
        None => {
            let row = stmt_cache::get_row(
                conn,
                ECHO_ALIAS,
                vec![
                    text(thread),
                    text(item),
                    generation(generation_value),
                    generation(generation_value),
                ],
            )?;
            row.as_ref().and_then(|row| row_text(row, "item_key"))
        }
    };
    let role = draft
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if role != "user" && alias.is_none() {
        return Ok(Some(fact));
    }
    let draft_origin = draft.get("origin");
    if native_id.is_none()
        && draft_origin.is_some()
        && draft_origin
            .and_then(|origin| origin.get("kind"))
            .and_then(Value::as_str)
            != Some("person")
        && draft_origin
            .and_then(|origin| origin.get("commandId"))
            .and_then(Value::as_str)
            .is_none()
    {
        return Ok(Some(fact));
    }
    if alias.is_none() && draft.get("parts").is_none() {
        return Ok(Some(fact));
    }
    let key = match &alias {
        Some(key) => key.clone(),
        None => {
            let parts = draft.get("parts").and_then(Value::as_array);
            let hashed = signature(&parts.map(|parts| parts.to_vec()).unwrap_or_default());
            let row = stmt_cache::get_row(
                conn,
                BY_SIGNATURE,
                vec![text(thread), text(&hashed), generation(generation_value)],
            )?;
            match row.as_ref().and_then(|row| row_text(row, "item_key")) {
                Some(key) => key,
                None => return Ok(Some(fact)),
            }
        }
    };
    if key == item && alias.is_none() {
        return Ok(Some(fact));
    }
    stmt_cache::run(conn, MATCHED, vec![text(thread), text(&key)])?;
    stmt_cache::run(conn, ECHO, vec![text(thread), text(item), text(&key)])?;
    let Some(origin) = origin(conn, thread, &key)? else {
        return Err(EngineError::Records("Invalid message origin".to_owned()));
    };
    // Keep the person's original parts; provider input may contain expanded context.
    let mut moved = draft.clone();
    if let Some(object) = moved.as_object_mut() {
        object.remove("parts");
        let synthetic = !person_input(&origin);
        object.insert("origin", origin);
        object.insert("synthetic", Value::Bool(synthetic));
        let native_id = draft_native_id(&fact, item);
        object.insert("nativeId", Value::from(native_id.as_str()));
    }
    let mut rewritten = fact;
    if let Some(object) = rewritten.as_object_mut() {
        object.insert("item", Value::from(key.as_str()));
        object.insert("draft", moved);
    }
    Ok(Some(rewritten))
}

fn draft_native_id(fact: &Value, item: &str) -> String {
    fact.get("draft")
        .and_then(|draft| draft.get("nativeId"))
        .and_then(Value::as_str)
        .unwrap_or(item)
        .to_owned()
}

fn identify_command(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    native_id: &str,
) -> Result<Option<String>, EngineError> {
    let row = stmt_cache::get_row(conn, IDENTITY, vec![text(thread), text(native_id)])?;
    Ok(row.as_ref().and_then(|row| row_text(row, "command_id")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::testsupport::{header, home};

    fn value(text: &str) -> Value {
        ace_json::parse(text).expect("json")
    }

    fn parts(text: &str) -> Vec<Value> {
        value(&format!(r#"[{{"type":"text","text":"{text}"}}]"#))
            .as_array()
            .expect("parts")
            .to_vec()
    }

    /// The journal row the receipt writes at acceptance and the delivery re-signs.
    fn sent(
        conn: &Arc<ace_store::Connection>,
        thread: &str,
        command: &str,
        text: &str,
        generation: Option<f64>,
    ) {
        let key = format!("input:{command}");
        let origin = value(&format!(r#"{{"kind":"person","commandId":"{command}"}}"#));
        register(conn, thread, &key, &parts(text), &origin).expect("register");
        sending(conn, thread, &key, &parts(text), None, generation).expect("sending");
    }

    #[test]
    fn an_echo_by_native_identity_takes_the_inputs_key_origin_and_person_parts() {
        let conn = home("j-identity", &header("j-identity"));
        let thread = "j-identity";
        sent(&conn, thread, "c1", "hello", Some(1.0));
        identify(
            &conn,
            thread,
            &value(r#"{"commandId":"c1","nativeId":"n1"}"#),
        )
        .expect("identify");
        let fact = value(
            r#"{"type":"item.upsert","agent":"root","item":"native-item","draft":{"type":"message","role":"user","nativeId":"n1","parts":[{"type":"text","text":"expanded"}]}}"#,
        );
        let correlated = correlate(&conn, thread, fact, "root", Some(1.0))
            .expect("correlate")
            .expect("a fact");
        assert_eq!(
            ace_json::to_string(&correlated),
            r#"{"type":"item.upsert","agent":"root","item":"input:c1","draft":{"type":"message","role":"user","nativeId":"n1","origin":{"kind":"person","commandId":"c1"},"synthetic":false}}"#
        );
        assert_eq!(
            key_for(&conn, thread, "n1").expect("key"),
            Some("input:c1".into())
        );
    }

    #[test]
    fn a_known_identity_with_no_journal_origin_marks_the_fact_but_keeps_its_item() {
        let conn = home("j-early", &header("j-early"));
        let thread = "j-early";
        identify(
            &conn,
            thread,
            &value(r#"{"commandId":"c9","nativeId":"n9"}"#),
        )
        .expect("identify");
        let fact = value(
            r#"{"type":"item.upsert","agent":"root","item":"native-9","draft":{"type":"message","role":"user","nativeId":"n9"}}"#,
        );
        let correlated = correlate(&conn, thread, fact, "root", None)
            .expect("correlate")
            .expect("a fact");
        assert_eq!(
            ace_json::to_string(&correlated),
            r#"{"type":"item.upsert","agent":"root","item":"native-9","draft":{"type":"message","role":"user","nativeId":"n9","origin":{"kind":"person","commandId":"c9"},"synthetic":false}}"#
        );
    }

    #[test]
    fn an_echo_correlates_by_signature_only_in_the_generation_that_was_handed_it() {
        let conn = home("j-signature", &header("j-signature"));
        let thread = "j-signature";
        sent(&conn, thread, "c2", "hello", Some(1.0));
        let fact = value(
            r#"{"type":"item.upsert","agent":"root","item":"native-2","draft":{"type":"message","role":"user","parts":[{"type":"text","text":"hello"}]}}"#,
        );
        let elsewhere =
            correlate(&conn, thread, fact.clone(), "root", Some(2.0)).expect("correlate");
        assert_eq!(
            ace_json::to_string(&elsewhere.expect("a fact")),
            ace_json::to_string(&fact),
            "another generation's echo stays the provider's item"
        );
        let correlated = correlate(&conn, thread, fact, "root", Some(1.0))
            .expect("correlate")
            .expect("a fact");
        assert_eq!(
            correlated.get("item").and_then(Value::as_str),
            Some("input:c2")
        );
        // Its echo row answers the same native item without a signature next time.
        let repeat = value(
            r#"{"type":"item.upsert","agent":"root","item":"native-2","draft":{"type":"message","role":"user"}}"#,
        );
        let echoed = correlate(&conn, thread, repeat, "root", Some(1.0))
            .expect("correlate")
            .expect("a fact");
        assert_eq!(echoed.get("item").and_then(Value::as_str), Some("input:c2"));
    }

    #[test]
    fn a_native_identity_cannot_be_reused_for_a_different_command() {
        let conn = home("j-conflict", &header("j-conflict"));
        let thread = "j-conflict";
        identify(
            &conn,
            thread,
            &value(r#"{"commandId":"c1","nativeId":"n1"}"#),
        )
        .expect("identify");
        let error = identify(
            &conn,
            thread,
            &value(r#"{"commandId":"c2","nativeId":"n1"}"#),
        )
        .expect_err("the identity is taken");
        assert_eq!(
            error.to_string(),
            "Provider reused an input message identity for a different command"
        );
    }
}

// SPDX-License-Identifier: Apache-2.0
//! The receipt's synchronous checks (E5.4d): the prelude every command passes before its
//! atomic step, the guest and host refusals, and the `CommandResult` shapes they return.

use ace_json::Value;

use crate::State;
use crate::executor::TaskId;

pub mod admissions;
pub mod create;
pub mod guest;
pub mod prelude;
pub mod receipt;
pub mod validation;
pub mod worktree;

/// One command's payload.
pub(crate) fn payload(command: &Value) -> &Value {
    command.get("payload").unwrap_or(&Value::Null)
}

/// A payload's type, or the empty string.
pub(crate) fn payload_type(command: &Value) -> &str {
    payload(command)
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// A command's id.
pub(crate) fn command_id(command: &Value) -> &str {
    command
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// `{ commandId, ok: true }`, with the thread when the success names one.
pub(crate) fn ok(command_id: &str, thread: Option<&str>) -> Value {
    let mut value = ace_json::Map::new();
    value.insert("commandId", Value::from(command_id));
    value.insert("ok", Value::Bool(true));
    if let Some(thread) = thread {
        value.insert("threadId", Value::from(thread));
    }
    Value::Object(value)
}

/// `{ commandId, ok: false, error }`.
pub(crate) fn error(command_id: &str, code: &str) -> Value {
    let mut value = ace_json::Map::new();
    value.insert("commandId", Value::from(command_id));
    value.insert("ok", Value::Bool(false));
    value.insert("error", Value::from(code));
    Value::Object(value)
}

/// A refusal with its title and detail, in the order the table gives them.
pub(crate) fn refusal(command_id: &str, code: &str, title: &str, detail: &str) -> Value {
    let mut value = ace_json::Map::new();
    value.insert("commandId", Value::from(command_id));
    value.insert("ok", Value::Bool(false));
    value.insert("error", Value::from(code));
    value.insert("title", Value::from(title));
    value.insert("detail", Value::from(detail));
    Value::Object(value)
}

/// Commands, intents and the queue (E5.4): the creation reservations span asynchronous
/// preparation and the synchronous receipt, so they live here.
#[derive(Debug, Default)]
pub struct Commands {
    pub admissions: admissions::CreationAdmissions,
}

/// Whether commands hold no work E5.1 must wait for (E5.4 fills this).
pub fn quiescent(_state: &State, _exclude: Option<TaskId>) -> bool {
    true
}

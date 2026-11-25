// SPDX-License-Identifier: Apache-2.0
//! The receipt's prelude (`handler.ts:55`-`:123`, E5.4d): the checks before the atomic step, in
//! the TypeScript's order, because tests pin which refusal wins when two apply.
//!
//! Execution stays with the owners: a thread command reaches E5.4e here, a transition E5.9, an
//! access change E5.7, and an imported thread's adoption E5.8; each fails `NotPorted`.

use ace_core::provider_admission::{ProviderAdmissionFacts, ProviderThread};
use ace_json::Value;

use super::guest::{guest_refusal, host_refusal};
use super::{command_id, error, payload, payload_type};
use crate::{Core, EngineError, State};

/// The largest message a send may carry (`maxMessageBytes`).
const MAX_MESSAGE_BYTES: usize = 256 * 1024;
/// The most parts one message may carry.
const MAX_PARTS: usize = 64;

/// The payload types the receipt knows; anything else is `not_implemented`.
const HANDLED: [&str; 11] = [
    "thread.create",
    "thread.prepare",
    "thread.send",
    "thread.interrupt",
    "thread.archive",
    "thread.model.set",
    "thread.mode.set",
    "thread.goal.set",
    "thread.goal.clear",
    "interaction.resolve",
    "background_task.stop",
];

/// The provider facts `providerCommandDisabled` reads.
struct Facts<'a> {
    core: &'a Core,
}

/// The thread row as `store.getThread` gives it.
pub(crate) fn thread_row(core: &Core, id: &str) -> Result<Option<Value>, EngineError> {
    let Some(text) = core.store.get_thread(id)? else {
        return Ok(None);
    };
    Ok(ace_json::parse(&text).ok())
}

impl ProviderAdmissionFacts for Facts<'_> {
    fn thread(&self, id: &str) -> Option<ProviderThread> {
        // `thread()` is read through the store, which takes `&self`; the state is not touched.
        let row = thread_row(self.core, id).ok().flatten()?;
        Some(ProviderThread {
            provider: row.get("provider").and_then(Value::as_str)?.to_owned(),
            instance_id: session_instance(self.core, id),
            parent_thread_id: row
                .get("lineage")
                .and_then(|lineage| lineage.get("parentThreadId"))
                .and_then(Value::as_str)
                .map(str::to_owned),
        })
    }

    fn default_instance(&self, provider: &str) -> Option<String> {
        self.core.ports.select_instance(provider, None)
    }

    fn enabled(&self, provider: &str, instance: Option<&str>) -> bool {
        self.core.ports.provider_enabled(provider, instance)
    }
}

fn session_instance(core: &Core, id: &str) -> Option<String> {
    crate::sessions::metadata::session(&core.store, id)
        .ok()
        .and_then(|session| session.instance_id)
}

/// Whether the thread's workspace root is reserved for a Git change (`threadReserved`).
fn thread_reserved(core: &Core, id: &str) -> Result<bool, EngineError> {
    use ace_store::{Value as Cell, stmt_cache};
    const ROOT: &str = "SELECT COALESCE((SELECT cwd FROM engine_sessions WHERE thread_id=?), (SELECT root FROM workspace_canonical_roots w JOIN threads t ON t.workspace_id=w.workspace_id WHERE t.id=?)) AS root";
    const RESERVED: &str = "SELECT 1 FROM workspace_root_reservations WHERE root=? LIMIT 1";
    let row = stmt_cache::get_row(
        core.store.conn(),
        ROOT,
        vec![Cell::Text(id.to_owned()), Cell::Text(id.to_owned())],
    )?;
    let Some(root) = row.and_then(|row| {
        row.get("root")
            .and_then(crate::repository::residency::cell_text)
            .map(str::to_owned)
    }) else {
        return Ok(false);
    };
    Ok(stmt_cache::get_row(core.store.conn(), RESERVED, vec![Cell::Text(root)])?.is_some())
}

/// `handler.ts:55`-`:123`: a refusal, or none when the command may reach its atomic step.
pub fn handle(
    core: &Core,
    state: &mut State,
    command: &Value,
) -> Result<Option<Value>, EngineError> {
    let id = command_id(command).to_owned();
    let p = payload(command);
    let kind = payload_type(command);
    let thread = p.get("threadId").and_then(Value::as_str);
    if let Some(thread) = thread {
        let row = thread_row(core, thread)?;
        let details = row.as_ref().and_then(|row| row.get("details"));
        if let Some(refused) =
            guest_refusal(&id, kind, details.and_then(|details| details.get("guest")))
        {
            return Ok(Some(refused));
        }
        if let Some(refused) = host_refusal(
            &id,
            kind,
            row.as_ref()
                .and_then(|row| row.get("host"))
                .and_then(Value::as_str),
        ) {
            return Ok(Some(refused));
        }
    }
    if kind == "thread.send"
        && let Some(thread) = thread
        && thread_row(core, thread)?
            .and_then(|row| row.get("imported").map(|value| !value.is_null()))
            .unwrap_or(false)
    {
        return Err(EngineError::not_ported("imported thread adoption", "E5.8"));
    }
    if let Some(thread) = thread
        && state.repo.cleaning(thread)
    {
        return Ok(Some(error(&id, "thread_deleting")));
    }
    if let Some(thread) = thread
        && thread_row(core, thread)?
            .and_then(|row| row.get("continuation").map(|value| !value.is_null()))
            .unwrap_or(false)
        && !matches!(kind, "thread.archive" | "thread.fork")
    {
        return Ok(Some(super::refusal(
            &id,
            "cursor_cli_retired",
            "This Cursor thread is read-only",
            "Continue in a new thread to carry its history to Cursor.",
        )));
    }
    {
        let facts = Facts { core };
        if ace_core::provider_admission::provider_command_disabled(p, &facts) {
            return Ok(Some(error(&id, "provider_disabled")));
        }
    }
    if let Some(thread) = thread
        && thread_reserved(core, thread)?
    {
        return Ok(Some(error(&id, "workspace_change_in_progress")));
    }
    if let Some(result) = crate::queue::commands::handle(core, state, command)? {
        return Ok(Some(result));
    }
    if matches!(kind, "thread.switch" | "thread.merge" | "thread.fork") {
        return Err(EngineError::not_ported("a thread transition", "E5.9"));
    }
    if matches!(kind, "thread.permission.set" | "thread.mode.set") {
        return Err(EngineError::not_ported("an access change", "E5.7"));
    }
    if let Some(thread) = thread
        && let Some(details) = thread_row(core, thread)?.and_then(|row| row.get("details").cloned())
        && let Some(change) = details.get("workspaceChange")
        && (change.get("state").and_then(Value::as_str) == Some("preparing")
            || change.get("uncertain").and_then(Value::as_bool) == Some(true))
    {
        return Ok(Some(error(&id, "workspace_change_in_progress")));
    }
    if kind == "thread.send" || kind == "thread.create" {
        let parts = p
            .get("input")
            .and_then(Value::as_array)
            .map(|parts| parts.len())
            .unwrap_or(0);
        if parts > MAX_PARTS {
            return Ok(Some(error(&id, "message_too_large")));
        }
        if ace_json::bounded::bounded_json(command, MAX_MESSAGE_BYTES).is_err() {
            return Ok(Some(error(&id, "message_too_large")));
        }
    }
    if !HANDLED.contains(&kind) {
        return Ok(Some(error(&id, "not_implemented")));
    }
    Err(EngineError::not_ported("thread commands", "E5.4e"))
}

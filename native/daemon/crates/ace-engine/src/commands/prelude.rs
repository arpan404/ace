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
use crate::rules::{MAX_MESSAGE_BYTES, MAX_PARTS};
use crate::{Core, EngineError, State};

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
    state: &'a State,
    /// The command thread's row, parsed once by the prelude.
    row: Option<(&'a str, &'a Value)>,
}

/// The thread row as `store.getThread` gives it.
pub(crate) fn thread_row(core: &Core, id: &str) -> Result<Option<Value>, EngineError> {
    let Some(text) = core.store.get_thread(id)? else {
        return Ok(None);
    };
    Ok(ace_json::parse(&text).ok())
}

/// The facts `providerCommandDisabled` reads from one thread row.
fn provider_thread(core: &Core, id: &str, row: &Value) -> Option<ProviderThread> {
    Some(ProviderThread {
        provider: row.get("provider").and_then(Value::as_str)?.to_owned(),
        instance_id: session_instance(core, id),
        parent_thread_id: row
            .get("lineage")
            .and_then(|lineage| lineage.get("parentThreadId"))
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

impl ProviderAdmissionFacts for Facts<'_> {
    fn thread(&self, id: &str) -> Option<ProviderThread> {
        // The command's own row was parsed once by the prelude; a parent thread's is read here.
        match self.row {
            Some((known, row)) if known == id => provider_thread(self.core, id, row),
            _ => thread_row(self.core, id)
                .ok()
                .flatten()
                .and_then(|row| provider_thread(self.core, id, &row)),
        }
    }

    fn default_instance(&self, provider: &str) -> Result<Option<String>, String> {
        // `registry.has(provider) ? selectInstance(provider, backend) : undefined`.
        if !self.state.registry.has(provider) {
            return Ok(None);
        }
        let backend = self
            .state
            .registry
            .get(provider, None)
            .ok()
            .and_then(|entry| entry.backend.clone());
        self.core
            .ports
            .default_instance(provider, backend.as_deref())
            .map_err(|error| error.to_string())
    }

    fn enabled(&self, provider: &str, instance: Option<&str>) -> Result<bool, String> {
        self.core
            .ports
            .provider_enabled(provider, instance)
            .map_err(|error| error.to_string())
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
    // One read and one parse for the five checks that need the thread row.
    let row = match thread {
        Some(thread) => thread_row(core, thread)?,
        None => None,
    };
    let present = |key: &str| {
        row.as_ref()
            .and_then(|row| row.get(key))
            .is_some_and(|value| !value.is_null())
    };
    if thread.is_some() {
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
    if kind == "thread.send" && thread.is_some() && present("imported") {
        return Err(EngineError::not_ported("imported thread adoption", "E5.8"));
    }
    if let Some(thread) = thread
        && state.repo.cleaning(thread)
    {
        return Ok(Some(error(&id, "thread_deleting")));
    }
    if thread.is_some()
        && present("continuation")
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
        let facts = Facts {
            core,
            state: &*state,
            row: thread.zip(row.as_ref()),
        };
        let disabled = ace_core::provider_admission::provider_command_disabled(p, &facts)
            .map_err(|message| EngineError::Port(crate::ports::PortError::Threw(message)))?;
        if disabled {
            return Ok(Some(error(&id, "provider_disabled")));
        }
    }
    if let Some(thread) = thread
        && thread_reserved(core, thread)?
    {
        return Ok(Some(error(&id, "workspace_change_in_progress")));
    }
    // `handler.ts:403`: a transition or checkout holding the thread refuses a new send.
    if kind == "thread.send"
        && let Some(thread) = thread
        && state.transition_guarded(&core.store, thread)?
    {
        return Ok(Some(error(&id, "thread_transition_in_progress")));
    }
    if let Some(result) = crate::recovery::handle(core, state, command)? {
        return Ok(Some(result));
    }
    if matches!(kind, "thread.switch" | "thread.merge" | "thread.fork") {
        if let Some(result) = crate::transitions::receipt::accept(core, state, command)? {
            return Ok(Some(result));
        }
        // A fork's receipt creates the new thread, which is E5.4e's create seam.
        return Err(EngineError::not_ported("a thread fork", "E5.4e"));
    }
    // A native mode by name is an access change: the same ceiling check and acknowledgement.
    if matches!(kind, "thread.permission.set" | "thread.mode.set") {
        let capabilities = row
            .as_ref()
            .and_then(|row| {
                row.get("effectiveCapabilities")
                    .or_else(|| row.get("capabilities"))
            })
            .cloned()
            .or_else(|| {
                let thread = thread?;
                let provider = row
                    .as_ref()
                    .and_then(|row| row.get("provider"))
                    .and_then(Value::as_str)?
                    .to_owned();
                let backend = state.backend(&core.store, thread).ok().flatten();
                state
                    .registry
                    .capabilities(&provider, backend.as_deref())
                    .ok()
                    .and_then(|text| ace_json::parse(&text).ok())
            });
        let at = core.store.now();
        let result = if kind == "thread.mode.set" {
            state.permission_accept_native(&core.store, command, capabilities.as_ref(), at)?
        } else {
            state.permission_accept(&core.store, command, capabilities.as_ref(), at)?
        };
        return Ok(Some(
            result.unwrap_or_else(|| error(&id, "not_implemented")),
        ));
    }
    if thread.is_some()
        && let Some(details) = row.as_ref().and_then(|row| row.get("details"))
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
    super::receipt::handle(core, state, command).map(Some)
}

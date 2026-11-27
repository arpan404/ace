// SPDX-License-Identifier: Apache-2.0
//! A thread ace imported from another tool's history (`imported-thread.ts`): its stored items stay
//! in the paged store, and only the live root enters the engine, bound to the native session the
//! import recorded. Adoption is the first step of continuing it; opening and sending are E5.6's and
//! E5.5's.

use ace_core::state::{AgentRecord, CoreConfig, create_thread_state};
use ace_json::Value;
use ace_store::{Value as Cell, stmt_cache};
use std::cell::RefCell;
use std::rc::Rc;

use crate::snapshot::Snapshot;
use crate::{Core, EngineError, State};

const MCP_AGENT: &str = "SELECT payload FROM mcp_agents WHERE thread_id=? AND id=?";
const NATIVE_SESSION: &str = "UPDATE engine_sessions SET native_session_id=? WHERE thread_id=?";
const UPSERT_STATE: &str = "INSERT INTO thread_state VALUES (?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET state=excluded.state, seq=excluded.seq";

/// `adoptImportedThread` (`:17`): the imported thread's root becomes the engine's live root, with
/// its workspace, model, instance and native session. Idempotent: a thread already resident is
/// left as it is.
pub fn adopt_imported_thread(
    core: &Core,
    state: &mut State,
    id: &str,
    now: f64,
    silence_ms: f64,
) -> Result<(), EngineError> {
    if state.repo.state(&core.store, id)?.is_some() {
        return Ok(());
    }
    let thread = super::threads::get(&core.store, id)?
        .ok_or_else(|| EngineError::Records("Imported thread unavailable".to_owned()))?;
    let imported = thread
        .imported
        .clone()
        .filter(|_| thread.root_agent_id.is_some())
        .ok_or_else(|| EngineError::Records("Imported thread unavailable".to_owned()))?;
    let root_id = thread
        .root_agent_id
        .clone()
        .ok_or_else(|| EngineError::Records("Imported thread unavailable".to_owned()))?;
    let root: ace_core::state::Agent = {
        let row = stmt_cache::get_row(
            core.store.conn(),
            MCP_AGENT,
            vec![Cell::Text(id.to_owned()), Cell::Text(root_id.clone())],
        )?
        .ok_or_else(|| EngineError::Records("Imported thread unavailable".to_owned()))?;
        let text = row
            .get("payload")
            .and_then(crate::repository::residency::cell_text)
            .ok_or_else(|| EngineError::Records("Imported thread unavailable".to_owned()))?;
        ace_json::from_value(
            &ace_json::parse(text).map_err(|error| EngineError::Records(error.to_string()))?,
        )
        .map_err(|_| EngineError::Records("Imported thread unavailable".to_owned()))?
    };
    let workspace = state
        .workspace(&core.store, &thread.workspace_id)?
        .ok_or_else(|| EngineError::Records("Imported project unavailable".to_owned()))?;
    let native_id = root
        .native
        .native_id
        .clone()
        .or_else(|| {
            imported
                .get("native")
                .and_then(|native| native.get("nativeId"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .filter(|native| !native.is_empty())
        .ok_or_else(|| EngineError::Records("Native session identity unavailable".to_owned()))?;
    let instance_id = imported
        .get("instanceId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let mut next = create_thread_state(
        id.to_owned(),
        None,
        CoreConfig {
            provider: thread.provider.clone(),
            silence_ms,
            liveness: None,
        },
    )
    .map_err(|error| EngineError::Records(error.to_string()))?;
    next.root_key = Some("root".to_owned());
    next.agents.insert(
        "root".to_owned(),
        AgentRecord {
            agent: root.clone(),
            activity: "thinking".to_owned(),
            last_signal_at: now as i64,
            parent_key: None,
            spawned_by_key: None,
            appended: Vec::new(),
            completion_relevant: None,
            native_runs: None,
            active_run: None,
            last_run: None,
            last_outcome_order: None,
            last_successful_outcome_order: None,
            external_status: None,
            last_error: None,
            process_settled_status: None,
            detail: None,
            disconnected_at: None,
            limited: None,
            retry: None,
            wake_until: None,
            extra: Default::default(),
        },
    );
    next.indexes
        .agent_keys_by_id
        .insert(root.id.clone(), "root".to_owned());
    let snapshot = Rc::new(RefCell::new(Snapshot::new(
        std::sync::Arc::clone(core.store.conn()),
        state.repo.budget(),
        next,
        None,
    )?));
    // The snapshot derives its indexes from records; the root's own id → key is this state's.
    snapshot
        .borrow_mut()
        .state
        .indexes
        .agent_keys_by_id
        .insert(root.id.clone(), "root".to_owned());
    core.store.atomic(|_| {
        crate::sessions::metadata::create_session(
            &core.store,
            id,
            &workspace,
            root.model.as_deref(),
            None,
            instance_id.as_deref(),
            None,
        )?;
        stmt_cache::run(
            core.store.conn(),
            NATIVE_SESSION,
            vec![Cell::Text(native_id.clone()), Cell::Text(id.to_owned())],
        )?;
        crate::access::storage::ensure(&core.store, id, None)?;
        crate::queue::store::ensure(core.store.conn(), id)?;
        let mut borrowed = snapshot.borrow_mut();
        // Adopt the state's indexes into their records before persisting: the snapshot derives
        // them from records, and the live root's id → key is this state's own.
        borrowed.adopt(&crate::snapshot::touched::Touched::values(&[], &[]))?;
        let header = borrowed.header()?;
        let seq = core.store.head_seq()?;
        // The header first: the section records reference its row.
        stmt_cache::run(
            core.store.conn(),
            UPSERT_STATE,
            vec![
                Cell::Text(id.to_owned()),
                Cell::Text(header),
                Cell::Integer(seq as i64),
            ],
        )?;
        borrowed.persist()?;
        borrowed.committed();
        Ok(())
    })?;
    // Load what was saved, so the next receipt or frame reads it.
    state.repo.state(&core.store, id)?;
    Ok(())
}

/// What continuing an imported thread answers before any session work (`:48`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContinueAnswer {
    /// The provider can resume the imported session; adoption and a send may go ahead.
    Continue,
    /// The provider cannot continue it in ace.
    Unsupported(String),
}

/// The continuation decision: an imported thread continues only on a provider that can resume a
/// native session, and only in `resume` mode.
pub fn continue_answer(
    core: &Core,
    state: &mut State,
    id: &str,
    mode: &str,
) -> Result<ContinueAnswer, EngineError> {
    let thread = super::threads::get(&core.store, id)?
        .filter(|thread| thread.imported.is_some())
        .ok_or_else(|| EngineError::Records("Imported thread unavailable".to_owned()))?;
    let resumable = if state.registry.has(&thread.provider) {
        state
            .registry
            .get(&thread.provider, None)
            .ok()
            .and_then(|entry| entry.capabilities.get("resume").and_then(Value::as_bool))
            .unwrap_or(false)
    } else {
        false
    };
    if resumable && mode == "resume" {
        return Ok(ContinueAnswer::Continue);
    }
    let _ = core;
    Ok(ContinueAnswer::Unsupported(
        "Import this session to read it. This provider cannot continue it in ace.".to_owned(),
    ))
}

#[cfg(test)]
mod tests;

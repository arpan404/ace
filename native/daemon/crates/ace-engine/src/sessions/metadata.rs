// SPDX-License-Identifier: Apache-2.0
//! Ported by E5.4c as a synchronous receipt dependency; owned by E5.6.
//!
//! `session-metadata.ts`'s row reads and writes (`session`, `backend`, `createSession`,
//! `createUnpreparedSession`): the provider, account and workspace binding every create writes
//! and every capability and backend read needs. `nativeSession` and `pinSessionIdentity` stay
//! E5.6's.

use ace_json::Value;
use ace_store::{Value as Cell, stmt_cache};

use crate::EngineError;
use crate::repository::residency::cell_text;
use crate::{EngineStore, State};

const SESSION: &str = "SELECT * FROM engine_sessions WHERE thread_id = ?";
const BACKEND: &str = "SELECT backend FROM engine_sessions WHERE thread_id=?";
const INSERT: &str = "INSERT INTO engine_sessions (thread_id,cwd,model,native_session_id,backend,instance_id,options) VALUES (?, ?, ?, NULL, ?, ?, ?)";
const UNPREPARED: &str = "UPDATE engine_sessions SET workspace_ready=0 WHERE thread_id=?";
const MISSING: &str = "Missing engine session metadata";

/// One thread's stored session binding, in the order `session(id)` builds it.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionMetadata {
    pub cwd: String,
    pub backend: Option<String>,
    pub instance_id: Option<String>,
    pub workspace_ready: bool,
    pub options: Option<Value>,
    pub model: Option<String>,
    pub native_session_id: Option<String>,
}

impl SessionMetadata {
    pub fn to_json(&self) -> Value {
        let mut value = ace_json::Map::new();
        value.insert("cwd", Value::from(self.cwd.as_str()));
        if let Some(backend) = &self.backend {
            value.insert("backend", Value::from(backend.as_str()));
        }
        if let Some(instance) = &self.instance_id {
            value.insert("instanceId", Value::from(instance.as_str()));
        }
        value.insert("workspaceReady", Value::Bool(self.workspace_ready));
        if let Some(options) = &self.options {
            value.insert("options", options.clone());
        }
        if let Some(model) = &self.model {
            value.insert("model", Value::from(model.as_str()));
        }
        if let Some(native) = &self.native_session_id {
            value.insert("nativeSessionId", Value::from(native.as_str()));
        }
        Value::Object(value)
    }
}

/// The provider backends a session row records (`session-metadata.ts:27`).
const BACKENDS: [&str; 2] = ["acp", "cursor-sdk"];

fn backend(value: &str) -> Result<String, EngineError> {
    if BACKENDS.contains(&value) {
        return Ok(value.to_owned());
    }
    Err(EngineError::Records(
        "Invalid option: expected one of \"acp\"|\"cursor-sdk\"".to_owned(),
    ))
}

fn row_text(row: &stmt_cache::Row, column: &str) -> Option<String> {
    row.get(column).and_then(cell_text).map(str::to_owned)
}

/// `SessionMetadata.session(id)`: the thread's persisted binding.
pub fn session(store: &EngineStore, id: &str) -> Result<SessionMetadata, EngineError> {
    let row = stmt_cache::get_row(store.conn(), SESSION, vec![Cell::Text(id.to_owned())])?;
    let Some(row) = row else {
        return Err(EngineError::Records(MISSING.to_owned()));
    };
    let cwd = row_text(&row, "cwd").ok_or_else(|| EngineError::Records(MISSING.to_owned()))?;
    let stored_backend = match row.get("backend") {
        Some(Cell::Null) | None => None,
        Some(cell) => Some(backend(cell_text(cell).unwrap_or_default())?),
    };
    let instance_id = match row.get("instance_id") {
        Some(Cell::Null) | None => None,
        Some(cell) => {
            let text = cell_text(cell).unwrap_or_default();
            // `z.string().min(1).max(256)` counts code points (rule 17).
            let points = text.chars().count();
            if points == 0 {
                return Err(EngineError::Records(
                    "Too small: expected string to have >=1 characters".to_owned(),
                ));
            }
            if points > 256 {
                return Err(EngineError::Records(
                    "Too big: expected string to have <=256 characters".to_owned(),
                ));
            }
            Some(text.to_owned())
        }
    };
    let options = match row.get("options") {
        Some(Cell::Null) | None => None,
        Some(cell) => {
            let text = cell_text(cell).unwrap_or_default();
            let parsed =
                ace_json::parse(text).map_err(|error| EngineError::Records(error.to_string()))?;
            if parsed.as_object().is_none() {
                return Err(EngineError::Records(
                    "Invalid input: expected record, received something else".to_owned(),
                ));
            }
            Some(parsed)
        }
    };
    Ok(SessionMetadata {
        cwd,
        backend: stored_backend,
        instance_id,
        workspace_ready: row
            .get("workspace_ready")
            .is_some_and(|cell| matches!(cell, Cell::Integer(1) | Cell::Real(1.0))),
        options,
        model: row_text(&row, "model"),
        native_session_id: row_text(&row, "native_session_id"),
    })
}

impl State {
    /// `SessionMetadata.backend(id)`: the stored backend, else ACP for a Cursor thread.
    /// Recovery and teardown read a tombstoned thread's binding too.
    pub fn session_backend(
        &mut self,
        store: &EngineStore,
        id: &str,
    ) -> Result<Option<String>, EngineError> {
        let row = stmt_cache::get_row(store.conn(), BACKEND, vec![Cell::Text(id.to_owned())])?;
        let Some(row) = row else {
            return Err(EngineError::Records(MISSING.to_owned()));
        };
        if let Some(cell) = row.get("backend")
            && !matches!(cell, Cell::Null)
        {
            return Ok(Some(backend(cell_text(cell).unwrap_or_default())?));
        }
        let provider = {
            let snapshot = self.repo.require_state(store, id)?;
            snapshot.borrow().state.config.provider.clone()
        };
        Ok((provider == "cursor").then(|| "acp".to_owned()))
    }
}

/// `SessionMetadata.createSession` (`:68`): the row, inside the caller's transaction.
pub fn create_session(
    store: &EngineStore,
    id: &str,
    cwd: &str,
    model: Option<&str>,
    backend: Option<&str>,
    instance_id: Option<&str>,
    options: Option<&Value>,
) -> Result<(), EngineError> {
    let params = vec![
        Cell::Text(id.to_owned()),
        Cell::Text(cwd.to_owned()),
        model.map_or(Cell::Null, |value| Cell::Text(value.to_owned())),
        backend.map_or(Cell::Null, |value| Cell::Text(value.to_owned())),
        instance_id.map_or(Cell::Null, |value| Cell::Text(value.to_owned())),
        options.map_or(Cell::Null, |value| Cell::Text(ace_json::to_string(value))),
    ];
    store.atomic(|tx| {
        stmt_cache::run(tx.conn(), INSERT, params)?;
        Ok(())
    })
}

/// `SessionMetadata.createUnpreparedSession` (`:53`): the row, not yet workspace-ready.
pub fn create_unprepared_session(
    store: &EngineStore,
    id: &str,
    cwd: &str,
    model: Option<&str>,
    backend: Option<&str>,
    instance_id: Option<&str>,
    options: Option<&Value>,
) -> Result<(), EngineError> {
    create_session(store, id, cwd, model, backend, instance_id, options)?;
    store.atomic(|tx| {
        stmt_cache::run(tx.conn(), UNPREPARED, vec![Cell::Text(id.to_owned())])?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::testsupport::{Shell, header, home};

    #[test]
    fn a_created_session_reads_its_row_and_starts_unprepared() {
        let conn = home("t", &header("t"));
        // The fixture's thread has its created row; this case proves `createSession` itself.
        conn.exec("DELETE FROM engine_sessions").expect("clear");
        let store = Shell::store(&conn);
        create_session(
            &store,
            "t",
            "/tmp/work",
            Some("model"),
            Some("acp"),
            None,
            None,
        )
        .expect("create");
        let read = session(&store, "t").expect("read");
        assert_eq!(read.cwd, "/tmp/work");
        assert_eq!(read.backend.as_deref(), Some("acp"));
        assert_eq!(read.model.as_deref(), Some("model"));
        assert!(read.workspace_ready, "a prepared session is ready");

        // A fresh thread's create writes its own row; a thread is created once.
        conn.exec(
            "INSERT INTO threads (id, workspace_id, title, provider, status, created_at, updated_at) \
             VALUES ('t2', 'workspace', 'Thread', 'claude', '{\"state\":\"new\"}', 0, 0)",
        )
        .expect("thread");
        create_unprepared_session(&store, "t2", "/tmp/work", None, None, None, None)
            .expect("unprepared");
        assert!(!session(&store, "t2").expect("read").workspace_ready);
        assert_eq!(session(&store, "missing").unwrap_err().to_string(), MISSING);
    }

    #[test]
    fn an_instance_id_is_bounded_in_code_points_as_the_schema_bounds_it() {
        let conn = home("t", &header("t"));
        conn.exec("DELETE FROM engine_sessions").expect("clear");
        let store = Shell::store(&conn);
        // 256 emoji are 512 UTF-16 units and still fit `z.string().max(256)` (rule 17).
        let emoji = "\u{1f600}".repeat(256);
        create_session(&store, "t", "/tmp", None, None, Some(&emoji), None).expect("create");
        assert_eq!(
            session(&store, "t").expect("read").instance_id.as_deref(),
            Some(emoji.as_str())
        );
        let too = format!("{emoji}\u{1f600}");
        conn.exec(&format!(
            "UPDATE engine_sessions SET instance_id='{too}' WHERE thread_id='t'"
        ))
        .expect("update");
        assert_eq!(
            session(&store, "t").unwrap_err().to_string(),
            "Too big: expected string to have <=256 characters"
        );
    }

    #[test]
    fn a_stored_backend_is_read_and_cursor_defaults_to_acp() {
        let conn = home("t", &header("t"));
        conn.exec("DELETE FROM engine_sessions").expect("clear");
        let store = Shell::store(&conn);
        let mut state = State::default();
        state.repo.probe_passthrough = true;
        create_session(&store, "t", "/tmp", None, Some("cursor-sdk"), None, None).expect("create");
        assert_eq!(
            state
                .session_backend(&store, "t")
                .expect("backend")
                .as_deref(),
            Some("cursor-sdk")
        );
        conn.exec("UPDATE engine_sessions SET backend=NULL WHERE thread_id='t'")
            .expect("clear");
        conn.exec("UPDATE thread_state SET state=json_set(state,'$.config.provider','cursor')")
            .expect("provider");
        assert_eq!(
            state
                .session_backend(&store, "t")
                .expect("backend")
                .as_deref(),
            Some("acp")
        );
    }
}

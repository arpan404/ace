// SPDX-License-Identifier: Apache-2.0
//! The thread row as recovery reads it (`store.getThread`, narrowed): whether it is settled or
//! archived, whose process it belongs to, and the backend its provider metadata names. The
//! columns are the store's; the decode is the one `thread-row.ts` does for these fields.

use ace_json::Value;
use ace_store::{Value as Cell, stmt_cache};

use crate::repository::residency::cell_text;
use crate::{EngineError, EngineStore};

const THREAD: &str = "SELECT provider, provider_metadata, client, imported, root_agent_id,
        archived_at, status, workspace_id FROM threads WHERE id=?";

/// One thread's stored facts, as the engine reads them at startup, close and on a fold.
#[derive(Debug, Clone)]
pub struct ThreadRow {
    /// `threads.provider`.
    pub provider: String,
    /// `provider_metadata.backend`: `acp` when absent.
    pub backend: Option<String>,
    /// `client.host`: `spade` or `spade-bot` for a thread the daemon holds (ADR 0121).
    pub host: Option<String>,
    pub archived: bool,
    /// `client.settledAt !== undefined`: explicit `null` counts as present, as the TypeScript's
    /// `getThread(id)?.settledAt` check does.
    pub settled: bool,
    pub root_agent_id: Option<String>,
    pub imported: Option<Value>,
    pub status: Value,
    pub workspace_id: String,
    pub client: Value,
}

impl ThreadRow {
    /// `continuation` (`thread-row.ts:198`): a Cursor CLI thread is read-only in ace.
    pub fn continuation(&self) -> bool {
        self.provider == "cursor" && self.backend.as_deref() != Some("cursor-sdk")
    }
}

/// Reads the row, or `None` when the thread is gone.
pub fn get(store: &EngineStore, id: &str) -> Result<Option<ThreadRow>, EngineError> {
    let Some(row) = stmt_cache::get_row(store.conn(), THREAD, vec![Cell::Text(id.to_owned())])?
    else {
        return Ok(None);
    };
    let text = |key: &str| row.get(key).and_then(cell_text).map(str::to_owned);
    let json = |key: &str| text(key).and_then(|text| ace_json::parse(&text).ok());
    let provider = text("provider")
        .ok_or_else(|| EngineError::Records("Invalid stored thread row: provider".to_owned()))?;
    let client = json("client").unwrap_or(Value::Null);
    let provider_metadata = json("provider_metadata").unwrap_or(Value::Null);
    Ok(Some(ThreadRow {
        provider,
        backend: provider_metadata
            .get("backend")
            .and_then(Value::as_str)
            .map(str::to_owned),
        host: client
            .get("host")
            .and_then(Value::as_str)
            .map(str::to_owned),
        archived: row
            .get("archived_at")
            .is_some_and(|value| !matches!(value, Cell::Null)),
        settled: client.get("settledAt").is_some(),
        root_agent_id: text("root_agent_id"),
        imported: json("imported"),
        status: json("status").unwrap_or(Value::Null),
        workspace_id: text("workspace_id").unwrap_or_default(),
        client,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::testsupport::{Shell, header, home};

    #[test]
    fn a_settled_thread_is_the_one_with_a_settled_at_and_an_archived_one_with_its_column() {
        let conn = home("row", &header("row"));
        conn.exec(r#"UPDATE threads SET client='{"settledAt":5}' WHERE id='row'"#)
            .unwrap();
        let store = Shell::store(&conn);
        let row = get(&store, "row").unwrap().unwrap();
        assert!(row.settled);
        assert!(!row.archived);
        conn.exec(r#"UPDATE threads SET client='{}', archived_at=9 WHERE id='row'"#)
            .unwrap();
        let row = get(&store, "row").unwrap().unwrap();
        assert!(!row.settled);
        assert!(row.archived);
        assert!(get(&store, "gone").unwrap().is_none());
    }

    #[test]
    fn a_cursor_thread_before_the_sdk_backend_reads_as_a_retired_continuation() {
        let conn = home("cursor", &header("cursor"));
        conn.exec(r#"UPDATE threads SET provider='cursor' WHERE id='cursor'"#)
            .unwrap();
        let store = Shell::store(&conn);
        assert!(get(&store, "cursor").unwrap().unwrap().continuation());
        conn.exec(
            r#"UPDATE threads SET provider_metadata='{"backend":"cursor-sdk"}' WHERE id='cursor'"#,
        )
        .unwrap();
        assert!(!get(&store, "cursor").unwrap().unwrap().continuation());
    }
}

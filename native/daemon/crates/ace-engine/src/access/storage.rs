// SPDX-License-Identifier: Apache-2.0
//! Ported by E5.4c as a synchronous receipt dependency; owned by E5.7.
//!
//! `permissions.ts:115`-`:124` (`ensure`, with `state` and `read`) and
//! `permission-storage.ts`'s `permissionState`: the permission row every create ensures. The
//! rest of access, approvals and the ceiling stay E5.7's.

use ace_store::{Value as Cell, stmt_cache};

use crate::EngineError;
use crate::EngineStore;
use crate::repository::residency::cell_text;

const READ: &str = "SELECT override,effective,parent,ceiling_provider,ceiling_mode,ceiling_identity FROM engine_permissions WHERE thread_id=?";
const ENSURE: &str = "INSERT OR IGNORE INTO engine_permissions(thread_id,override,effective,parent) VALUES (?,?,?,NULL)";

/// The four ace modes (`AccessMode`).
const MODES: [&str; 4] = ["read-only", "ask", "auto-review", "full-access"];

/// One thread's stored permission row (`permission-storage.ts:8`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PermissionRecord {
    pub override_mode: Option<String>,
    pub effective: Option<String>,
    pub parent: Option<String>,
    pub ceiling_provider: Option<String>,
    pub ceiling_mode: Option<String>,
    pub ceiling_identity: Option<String>,
}

/// The state a client reads (`PermissionState`), in its schema's key order.
#[derive(Debug, Clone, PartialEq)]
pub struct PermissionState {
    pub override_mode: Option<String>,
    pub effective: Option<String>,
    pub custom: Option<String>,
    pub pending: bool,
}

impl PermissionState {
    pub fn to_json(&self) -> ace_json::Value {
        let mut value = ace_json::Map::new();
        value.insert(
            "override",
            self.override_mode
                .as_deref()
                .map_or(ace_json::Value::Null, ace_json::Value::from),
        );
        value.insert(
            "effective",
            self.effective
                .as_deref()
                .map_or(ace_json::Value::Null, ace_json::Value::from),
        );
        if let Some(custom) = &self.custom {
            value.insert("custom", ace_json::Value::from(custom.as_str()));
        }
        value.insert("pending", ace_json::Value::Bool(self.pending));
        ace_json::Value::Object(value)
    }
}

fn mode(stored: Option<&str>) -> Option<String> {
    stored
        .filter(|value| MODES.contains(value))
        .map(str::to_owned)
}

/// `permissionState` (`permission-storage.ts:28`): the four modes, the native selector a
/// `custom:` effective mode names, and whether an accepted choice still waits to apply.
pub fn permission_state(record: &PermissionRecord) -> PermissionState {
    let custom = record
        .effective
        .as_deref()
        .and_then(|effective| effective.strip_prefix("custom:"))
        .map(str::to_owned);
    PermissionState {
        override_mode: mode(record.override_mode.as_deref()),
        effective: mode(record.effective.as_deref()),
        custom,
        pending: record.override_mode.is_some() && record.override_mode != record.effective,
    }
}

fn row_text(row: &stmt_cache::Row, column: &str) -> Option<String> {
    row.get(column).and_then(cell_text).map(str::to_owned)
}

/// `Permissions.read` (`permissions.ts:85`): the row, or the defaults when there is none.
pub fn read(store: &EngineStore, id: &str) -> Result<PermissionRecord, EngineError> {
    let row = stmt_cache::get_row(store.conn(), READ, vec![Cell::Text(id.to_owned())])?;
    let Some(row) = row else {
        return Ok(PermissionRecord::default());
    };
    Ok(PermissionRecord {
        override_mode: row_text(&row, "override"),
        effective: row_text(&row, "effective"),
        parent: row_text(&row, "parent"),
        ceiling_provider: row_text(&row, "ceiling_provider"),
        ceiling_mode: row_text(&row, "ceiling_mode"),
        ceiling_identity: row_text(&row, "ceiling_identity"),
    })
}

/// `Permissions.state` (`:180`).
pub fn state(store: &EngineStore, id: &str) -> Result<PermissionState, EngineError> {
    Ok(permission_state(&read(store, id)?))
}

/// `Permissions.ensure` (`:115`): the row exists, then the state it reads.
pub fn ensure(
    store: &EngineStore,
    id: &str,
    override_mode: Option<&str>,
) -> Result<PermissionState, EngineError> {
    let params = vec![
        Cell::Text(id.to_owned()),
        override_mode.map_or(Cell::Null, |value| Cell::Text(value.to_owned())),
        override_mode.map_or(Cell::Null, |value| Cell::Text(value.to_owned())),
    ];
    store.atomic(|tx| {
        stmt_cache::run(tx.conn(), ENSURE, params)?;
        Ok(())
    })?;
    state(store, id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::testsupport::{Shell, home};

    #[test]
    fn ensure_writes_the_row_once_and_reads_the_state_a_client_shows() {
        let conn = home("t", &crate::repository::testsupport::header("t"));
        let store = Shell::store(&conn);
        let first = ensure(&store, "t", Some("ask")).expect("ensure");
        assert_eq!(first.override_mode.as_deref(), Some("ask"));
        assert_eq!(first.effective.as_deref(), Some("ask"));
        assert!(!first.pending);
        // A second ensure keeps the stored choice, as INSERT OR IGNORE does.
        let again = ensure(&store, "t", Some("full-access")).expect("ensure");
        assert_eq!(again.override_mode.as_deref(), Some("ask"));
        assert_eq!(
            state(&store, "unknown")
                .expect("no row")
                .to_json()
                .to_string(),
            "{\"override\":null,\"effective\":null,\"pending\":false}"
        );
    }

    #[test]
    fn a_custom_effective_mode_names_its_native_selector_and_a_pending_choice_shows() {
        let record = PermissionRecord {
            override_mode: Some("custom:plan".into()),
            effective: Some("custom:plan".into()),
            ..PermissionRecord::default()
        };
        let state = permission_state(&record);
        assert_eq!(state.override_mode, None);
        assert_eq!(state.effective, None);
        assert_eq!(state.custom.as_deref(), Some("plan"));
        assert!(!state.pending);
        let pending = permission_state(&PermissionRecord {
            override_mode: Some("ask".into()),
            effective: Some("read-only".into()),
            ..PermissionRecord::default()
        });
        assert!(pending.pending);
    }
}

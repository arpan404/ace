// SPDX-License-Identifier: Apache-2.0
//! Ported by E5.4c as a synchronous receipt dependency; owned by E5.7.
//!
//! `permissions.ts:115`-`:124` (`ensure`, with `state` and `read`) and
//! `permission-storage.ts`'s `permissionState`: the permission row every create ensures. E5.7
//! adds `migrateSelection` and the one-time row mapping; the table's DDL is the Rust opener's
//! (`open::ddl::PERMISSIONS`), which runs it in `open.ts`'s order.

use ace_json::Value;
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

/// `migrateSelection` (`permission-storage.ts:23`): a selection stored before the four ace modes
/// becomes the ace mode the migration table names, or null (the defaults) without one. A
/// `custom:` selection is already ace's own and stays.
pub fn migrate_selection(provider: &str, stored: Option<&str>) -> Option<String> {
    match stored {
        None => None,
        Some(value) if value.starts_with("custom:") => Some(value.to_owned()),
        Some(value) => crate::access::modes::stored_access(provider, Some(value)),
    }
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

/// `migratePermissions` (`permission-storage.ts:54`): map every stored selection onto the four
/// ace modes once, and republish threads whose permission state changed, so clients never read a
/// native id as an ace mode.
pub fn migrate_permissions(store: &EngineStore) -> Result<(), EngineError> {
    const ROWS: &str = "SELECT * FROM engine_permissions";
    const THREAD: &str = "SELECT provider,provider_metadata,updated_at FROM threads WHERE id=?";
    const UPDATE: &str =
        "UPDATE engine_permissions SET override=?,effective=?,ceiling_mode=? WHERE thread_id=?";
    store.atomic(|_| {
        for row in stmt_cache::all_rows(store.conn(), ROWS, vec![])? {
            let Some(id) = row_text(&row, "thread_id") else {
                continue;
            };
            let Some(thread) =
                stmt_cache::get_row(store.conn(), THREAD, vec![Cell::Text(id.clone())])?
            else {
                continue;
            };
            let Some(provider) = row_text(&thread, "provider") else {
                continue;
            };
            let metadata =
                row_text(&thread, "provider_metadata").and_then(|text| ace_json::parse(&text).ok());
            let shown = metadata
                .as_ref()
                .and_then(|metadata| metadata.get("permission"))
                .cloned();
            let record = PermissionRecord {
                override_mode: migrate_selection(&provider, row_text(&row, "override").as_deref()),
                effective: migrate_selection(&provider, row_text(&row, "effective").as_deref()),
                parent: row_text(&row, "parent"),
                ceiling_provider: row_text(&row, "ceiling_provider"),
                ceiling_mode: match row_text(&row, "ceiling_provider") {
                    Some(ceiling) => {
                        migrate_selection(&ceiling, row_text(&row, "ceiling_mode").as_deref())
                    }
                    None => None,
                },
                ceiling_identity: row_text(&row, "ceiling_identity"),
            };
            let changed = record.override_mode.as_deref() != row_text(&row, "override").as_deref()
                || record.effective.as_deref() != row_text(&row, "effective").as_deref()
                || record.ceiling_mode.as_deref() != row_text(&row, "ceiling_mode").as_deref();
            if changed {
                stmt_cache::run(
                    store.conn(),
                    UPDATE,
                    vec![
                        record
                            .override_mode
                            .as_deref()
                            .map_or(Cell::Null, |value| Cell::Text(value.to_owned())),
                        record
                            .effective
                            .as_deref()
                            .map_or(Cell::Null, |value| Cell::Text(value.to_owned())),
                        record
                            .ceiling_mode
                            .as_deref()
                            .map_or(Cell::Null, |value| Cell::Text(value.to_owned())),
                        Cell::Text(id.clone()),
                    ],
                )?;
            }
            let permission = permission_state(&record);
            let same = shown.as_ref().is_none_or(|shown| {
                field(shown, "override") == permission.override_mode.as_deref()
                    && field(shown, "effective") == permission.effective.as_deref()
                    && field(shown, "custom") == permission.custom.as_deref()
            });
            if same {
                continue;
            }
            let at = match thread.get("updated_at") {
                Some(Cell::Integer(value)) => *value as f64,
                Some(Cell::Real(value)) => *value,
                _ => 0.0,
            };
            let payload = permission_event(&permission);
            store.write_events(&id, &payload, at)?;
        }
        Ok(())
    })
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn permission_event(state: &PermissionState) -> String {
    let mut event = ace_json::Map::new();
    event.insert("type", Value::from("thread.updated"));
    event.insert("permission", state.to_json());
    ace_json::to_string(&Value::Array(vec![Value::Object(event)].into()))
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

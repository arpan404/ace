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
        .filter(|value| crate::access::modes::is_access_mode(value))
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

pub(crate) fn row_text(row: &stmt_cache::Row, column: &str) -> Option<String> {
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

/// The marker a completed permission-mode fill leaves (`upgrade_cleanup`), so a restarted daemon
/// never walks the rows again.
pub(crate) const PERMISSION_FILL_DONE: &str = "engine-permission-modes-v1";

/// The fill's batch size (ADR 0170: idle, bounded, resumable).
pub const PERMISSION_FILL_BATCH: usize = 256;

const PERMISSION_FILL_DONE_SQL: &str = "SELECT 1 FROM upgrade_cleanup WHERE id=?";
const PERMISSION_PAGE: &str =
    "SELECT * FROM engine_permissions WHERE thread_id > ? ORDER BY thread_id LIMIT ?";

/// Whether the one-time permission-mode fill already completed on this home.
pub fn permission_fill_done(store: &EngineStore) -> Result<bool, EngineError> {
    Ok(stmt_cache::get_row(
        store.conn(),
        PERMISSION_FILL_DONE_SQL,
        vec![Cell::Text(PERMISSION_FILL_DONE.to_owned())],
    )?
    .is_some())
}

/// One bounded step of `migratePermissions` (`permission-storage.ts:54`): map at most `limit`
/// stored selections onto the four ace modes, and republish threads whose permission state
/// changed, so clients never read a native id as an ace mode. Returns the next cursor and
/// whether the fill is done.
pub fn migrate_permissions_step(
    store: &EngineStore,
    after: Option<&str>,
    limit: usize,
) -> Result<(Option<String>, bool), EngineError> {
    if permission_fill_done(store)? {
        return Ok((None, true));
    }
    let rows = stmt_cache::all_rows(
        store.conn(),
        PERMISSION_PAGE,
        vec![
            Cell::Text(after.unwrap_or_default().to_owned()),
            Cell::Integer(limit as i64),
        ],
    )?;
    let mut next = after.map(str::to_owned);
    for row in &rows {
        let Some(id) = row_text(row, "thread_id") else {
            continue;
        };
        migrate_permission_row(store, row, &id)?;
        next = Some(id);
    }
    let done = rows.len() < limit;
    if done {
        stmt_cache::run(
            store.conn(),
            "INSERT OR IGNORE INTO upgrade_cleanup VALUES (?)",
            vec![Cell::Text(PERMISSION_FILL_DONE.to_owned())],
        )?;
    }
    Ok((next, done))
}

/// `migratePermissions` for a caller that can afford the whole pass (tests and the opener's
/// proof): repeated bounded steps until the done marker exists.
pub fn migrate_permissions(store: &EngineStore) -> Result<(), EngineError> {
    let mut after: Option<String> = None;
    loop {
        let (next, done) =
            migrate_permissions_step(store, after.as_deref(), PERMISSION_FILL_BATCH)?;
        if done {
            return Ok(());
        }
        after = next;
    }
}

fn migrate_permission_row(
    store: &EngineStore,
    row: &stmt_cache::Row,
    id: &str,
) -> Result<(), EngineError> {
    const THREAD: &str = "SELECT provider,provider_metadata,updated_at FROM threads WHERE id=?";
    const UPDATE: &str =
        "UPDATE engine_permissions SET override=?,effective=?,ceiling_mode=? WHERE thread_id=?";
    store.atomic(|_| {
        let Some(thread) =
            stmt_cache::get_row(store.conn(), THREAD, vec![Cell::Text(id.to_owned())])?
        else {
            return Ok(());
        };
        let Some(provider) = row_text(&thread, "provider") else {
            return Ok(());
        };
        let metadata =
            row_text(&thread, "provider_metadata").and_then(|text| ace_json::parse(&text).ok());
        let shown = metadata
            .as_ref()
            .and_then(|metadata| metadata.get("permission"))
            .cloned();
        let record = PermissionRecord {
            override_mode: migrate_selection(&provider, row_text(row, "override").as_deref()),
            effective: migrate_selection(&provider, row_text(row, "effective").as_deref()),
            parent: row_text(row, "parent"),
            ceiling_provider: row_text(row, "ceiling_provider"),
            ceiling_mode: match row_text(row, "ceiling_provider") {
                Some(ceiling) => {
                    migrate_selection(&ceiling, row_text(row, "ceiling_mode").as_deref())
                }
                None => None,
            },
            ceiling_identity: row_text(row, "ceiling_identity"),
        };
        let changed = record.override_mode.as_deref() != row_text(row, "override").as_deref()
            || record.effective.as_deref() != row_text(row, "effective").as_deref()
            || record.ceiling_mode.as_deref() != row_text(row, "ceiling_mode").as_deref();
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
                    Cell::Text(id.to_owned()),
                ],
            )?;
        }
        let permission = permission_state(&record);
        if !permission_published(shown.as_ref(), &permission) {
            return Ok(());
        }
        let at = match thread.get("updated_at") {
            Some(Cell::Integer(value)) => *value as f64,
            Some(Cell::Real(value)) => *value,
            _ => 0.0,
        };
        let payload = permission_event(&permission);
        store.write_events(id, &payload, at)
    })
}

/// Whether the mapped state is news to clients. A thread that displayed no permission before the
/// mapping never read as an ace mode, so the mapped state publishes; only an identical displayed
/// state skips.
fn permission_published(shown: Option<&Value>, permission: &PermissionState) -> bool {
    shown.is_none_or(|shown| {
        field(shown, "override") != permission.override_mode.as_deref()
            || field(shown, "effective") != permission.effective.as_deref()
            || field(shown, "custom") != permission.custom.as_deref()
    })
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

pub(crate) fn permission_event(state: &PermissionState) -> String {
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
    fn a_thread_with_no_displayed_permission_still_publishes_its_mapped_state() {
        let permission = permission_state(&PermissionRecord {
            override_mode: Some("auto-review".into()),
            effective: Some("auto-review".into()),
            ..PermissionRecord::default()
        });
        assert!(permission_published(None, &permission));
        let shown = ace_json::parse(
            r#"{"override":"auto-review","effective":"auto-review","pending":false}"#,
        )
        .unwrap();
        assert!(!permission_published(Some(&shown), &permission));
        let stale = ace_json::parse(r#"{"override":"ask","effective":"ask"}"#).unwrap();
        assert!(permission_published(Some(&stale), &permission));
    }

    #[test]
    fn a_stored_selection_migrates_to_its_ace_mode_and_a_custom_one_stays() {
        // `permission-storage.ts:23`: native ids map once; an ace value or a `custom:` stays.
        assert_eq!(
            migrate_selection("claude", Some("plan")).as_deref(),
            Some("read-only")
        );
        assert_eq!(
            migrate_selection("claude", Some("acceptEdits")).as_deref(),
            Some("auto-review")
        );
        assert_eq!(
            migrate_selection("claude", Some("full-access")).as_deref(),
            Some("full-access")
        );
        assert_eq!(
            migrate_selection("claude", Some("custom:dontAsk")).as_deref(),
            Some("custom:dontAsk")
        );
        assert_eq!(migrate_selection("pi", Some("unrestricted")), None);
        assert_eq!(migrate_selection("claude", None), None);
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

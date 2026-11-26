// SPDX-License-Identifier: Apache-2.0
//! The opener's deferred work (ADR 0170, decision 8's 2026-11-26 note): the permission-mode
//! mapping and the title-input index are history-sized, so they run after the engine is ready,
//! one bounded batch at a time, and never inside `open`.

use ace_store::stmt_cache;

use crate::access::storage;
use crate::{EngineError, EngineStore};

const TITLE_INDEX: &str =
    "SELECT 1 FROM sqlite_master WHERE type='index' AND name='engine_first_person_input'";

/// The deferred open work's progress. One process's run; a restart starts it again, and the
/// permission fill's done marker stops a completed mapping from walking the table.
#[derive(Debug, Default)]
pub struct OpenFills {
    permission_cursor: Option<String>,
    permission_done: bool,
    title_done: bool,
    started: bool,
}

impl OpenFills {
    pub fn new() -> OpenFills {
        OpenFills::default()
    }

    /// One idle step: at most 256 permission rows, then the index once that is done. Returns
    /// whether any work remains, so the caller can yield and come back, or stop.
    pub fn step(&mut self, store: &EngineStore) -> Result<bool, EngineError> {
        if !self.started {
            self.started = true;
            self.permission_done = storage::permission_fill_done(store)?;
            self.title_done = title_index_exists(store)?;
        }
        if !self.permission_done {
            let (next, done) = storage::migrate_permissions_step(
                store,
                self.permission_cursor.as_deref(),
                storage::PERMISSION_FILL_BATCH,
            )?;
            self.permission_cursor = next;
            self.permission_done = done;
            return Ok(!self.permission_done || !self.title_done);
        }
        if !self.title_done {
            ensure_title_index(store)?;
            self.title_done = true;
        }
        Ok(false)
    }
}

/// Whether the title-input index exists: a version-9 home without it waits for the idle step.
pub fn title_index_exists(store: &EngineStore) -> Result<bool, EngineError> {
    Ok(stmt_cache::get_row(store.conn(), TITLE_INDEX, vec![])?.is_some())
}

/// `indexTitleInputs` (`title-input.ts:12`) on a populated `items` table, deferred out of open.
/// SQLite's index build is one statement; it runs idle, after ready, never inside the opener.
pub fn ensure_title_index(store: &EngineStore) -> Result<(), EngineError> {
    store.atomic(|tx| {
        tx.conn().exec(crate::open::ddl::TITLE_INDEX)?;
        Ok(())
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::open::open;
    use crate::repository::testsupport::Shell;
    use ace_store::{Connection, OpenOptions, Value as Cell};
    use std::sync::Arc;

    fn base_home(name: &str) -> (Arc<Connection>, EngineStore) {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "ace-engine-fill-{}-{}-{}-{}.sqlite",
            std::process::id(),
            name,
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|since| since.as_nanos())
                .unwrap_or(0)
        ));
        let conn = Connection::open(
            path.to_str().unwrap_or_default(),
            OpenOptions {
                read_only: false,
                timeout_ms: 1_000,
            },
        )
        .expect("a temp home");
        let value = ace_json::parse(include_str!("../../tests/fixtures/engine-schema.json"))
            .expect("fixture");
        let base = value
            .get("base")
            .and_then(ace_json::Value::as_array)
            .expect("base");
        for row in base {
            let name = row
                .get("name")
                .and_then(ace_json::Value::as_str)
                .unwrap_or_default();
            let sql = row
                .get("sql")
                .and_then(ace_json::Value::as_str)
                .unwrap_or_default();
            if name.starts_with("search_") {
                continue;
            }
            conn.exec(sql).expect("a base statement");
        }
        conn.exec(&format!(
            "INSERT INTO workspaces VALUES ('workspace','/tmp','Workspace',0);
             INSERT INTO threads (id,workspace_id,title,provider,status,created_at,updated_at)
               VALUES ('{name}','workspace','T','claude','{{\"state\":\"new\"}}',0,0);"
        ))
        .expect("a thread");
        let store = Shell::store(&conn);
        (conn, store)
    }

    #[test]
    fn a_large_permission_table_is_not_migrated_at_open_and_the_fill_maps_it_in_batches() {
        let (conn, store) = base_home("fills");
        open(&store).expect("open");
        conn.exec(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1000)
             INSERT INTO threads (id,workspace_id,title,provider,status,created_at,updated_at)
               SELECT 't'||i,'workspace','T','claude','{\"state\":\"new\"}',0,0 FROM n;
             WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1000)
             INSERT INTO engine_permissions (thread_id,override,effective)
               SELECT 't'||i,'acceptEdits','acceptEdits' FROM n;",
        )
        .expect("a large permission table");
        // The opener itself does no per-row work.
        open(&store).expect("second open");
        let mapped = || -> i64 {
            stmt_cache::get_row(
                &conn,
                "SELECT COUNT(*) AS n FROM engine_permissions WHERE override='auto-review'",
                vec![],
            )
            .expect("count")
            .and_then(|row| match row.get("n") {
                Some(Cell::Integer(value)) => Some(*value),
                _ => None,
            })
            .unwrap_or(0)
        };
        assert_eq!(mapped(), 0, "open migrated rows");
        let mut fills = OpenFills::new();
        assert!(fills.step(&store).expect("first step"));
        assert_eq!(mapped(), 256, "one bounded batch");
        let mut steps = 1;
        while fills.step(&store).expect("step") {
            steps += 1;
            assert!(steps < 10);
        }
        assert_eq!(mapped(), 1000);
        assert!(storage::permission_fill_done(&store).expect("marker"));
    }

    #[test]
    fn a_version_nine_home_without_the_title_index_opens_without_building_it() {
        let (conn, _store) = base_home("noindex");
        let store = Shell::store(&conn);
        open(&store).expect("open");
        conn.exec(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<500)
             INSERT INTO items (id,thread_id,created_seq,item)
               SELECT 'item'||i,'noindex',i,
                 json_object('id','item'||i,'agentId','root','type','message','role','user',
                   'parts',json_array(json_object('type','text','text','hello')),'createdAt',1) FROM n;",
        )
        .expect("populated items without the index");
        assert!(!title_index_exists(&store).expect("index check"));
        let mut fills = OpenFills::new();
        while fills.step(&store).expect("step") {}
        assert!(title_index_exists(&store).expect("index built"));
    }
}

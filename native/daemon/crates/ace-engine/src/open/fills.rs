// SPDX-License-Identifier: Apache-2.0
//! The opener's deferred work (ADR 0170): the permission-mode mapping is history-sized, so it
//! runs after the engine is ready, one bounded batch at a time, and never inside `open`. The
//! title-input and liveness indexes are not built here at all; their readers are bounded.

use crate::access::storage;
use crate::{EngineError, EngineStore};

/// The deferred open work's progress. One process's run; a restart starts it again, and the
/// permission fill's done marker stops a completed mapping from walking the table.
#[derive(Debug, Default)]
pub struct OpenFills {
    permission_cursor: Option<String>,
    permission_done: bool,
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
        }
        if !self.permission_done {
            let (next, done) = storage::migrate_permissions_step(
                store,
                self.permission_cursor.as_deref(),
                storage::PERMISSION_FILL_BATCH,
            )?;
            self.permission_cursor = next;
            self.permission_done = done;
            return Ok(!self.permission_done);
        }
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actor::ActorDeps;
    use crate::executor::{Budget, Notified, Notifier};
    use crate::frames::live::UnportedLive;
    use crate::open::open;
    use crate::repository::testsupport::Shell;
    use ace_store::{Connection, OpenOptions, Value as Cell, stmt_cache};
    use std::rc::Rc;
    use std::sync::Arc;

    struct ManualPump;
    impl Notifier for ManualPump {
        fn notify(&self) -> Notified {
            Notified::Posted
        }
    }
    struct Turn;
    impl Budget for Turn {
        fn start(&mut self) {}
        fn spent(&self, started: usize) -> bool {
            started >= 64
        }
    }

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
        // The cursor committed with that batch: a fresh fill (a restart) resumes after it.
        let cursor = stmt_cache::get_row(
            &conn,
            "SELECT id FROM upgrade_cleanup WHERE id LIKE 'engine-permission-cursor:%'",
            vec![],
        )
        .expect("cursor")
        .and_then(|row| match row.get("id") {
            Some(Cell::Text(value)) => Some(value.clone()),
            _ => None,
        });
        assert!(cursor.is_some(), "the cursor committed with the rows");
        let mut fills = OpenFills::new();
        let mut steps = 1;
        while fills.step(&store).expect("step") {
            steps += 1;
            assert!(steps < 10);
        }
        assert_eq!(mapped(), 1000);
        assert!(storage::permission_fill_done(&store).expect("marker"));
    }

    #[test]
    fn the_engine_runs_the_fill_after_readiness_and_keeps_it_until_it_commits() {
        let (conn, store) = base_home("startup");
        open(&store).expect("open");
        conn.exec(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<600)
             INSERT INTO threads (id,workspace_id,title,provider,status,created_at,updated_at)
               SELECT 's'||i,'workspace','T','claude','{\"state\":\"new\"}',0,0 FROM n;
             WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<600)
             INSERT INTO engine_permissions (thread_id,override,effective)
               SELECT 's'||i,'plan','plan' FROM n;",
        )
        .expect("legacy rows");
        let mapped = || -> i64 {
            stmt_cache::get_row(
                &conn,
                "SELECT COUNT(*) AS n FROM engine_permissions WHERE override='read-only'",
                vec![],
            )
            .expect("count")
            .and_then(|row| match row.get("n") {
                Some(Cell::Integer(value)) => Some(*value),
                _ => None,
            })
            .unwrap_or(0)
        };
        let (_, shell) = Shell::store_with_controls(&conn);
        let engine = crate::Engine::new(
            shell.clone(),
            shell,
            crate::Inputs::default(),
            "[]",
            Box::new(ManualPump),
            &conn,
            Rc::new(ActorDeps::production(Rc::new(UnportedLive), 0.0)),
        )
        .expect("engine");
        // Nothing ran at construction; the fill is idle work after readiness.
        assert_eq!(mapped(), 0);
        for _ in 0..400 {
            engine.pump(&mut Turn);
        }
        assert_eq!(mapped(), 600, "the owned fill task ran to completion");
    }
}

// SPDX-License-Identifier: Apache-2.0
//! The moved cases' home: a temp `ace-store` database created from the opener's schema
//! (`tests/fixtures/engine-schema.sql`, dumped once from a TypeScript-opened home: the schema,
//! not a behaviour vector), plus the one transaction shell a repository case needs.
//!
//! The shell runs the store's job on the real connection: `BEGIN` on open, `COMMIT` on success,
//! `ROLLBACK` and a bumped generation on failure. Nothing here is thread behaviour.

use std::cell::{Cell, RefCell};
use std::sync::Arc;

use ace_store::{Connection, OpenOptions};

use crate::ports::{OpenFrame, PortError, Ports, Timer};
use crate::{EngineStack, EngineStore};

pub(crate) const HEADER: &str = r#"{"engineSnapshot":9,"threadId":"t","config":{"provider":"codex","silenceMs":1000},"initialRoot":{"agent":"root","fidelity":"full","native":{"provider":"codex","nativeId":"native-root"},"cwd":"/tmp"},"agents":{},"runs":{},"items":{},"interactions":{},"tasks":{},"interactionHistory":{},"taskHistory":{},"indexes":{"liveTools":{},"pendingInteractions":{},"runningTasks":{},"agentKeysById":{},"childrenByParent":{},"pendingSpawnLinks":{},"pendingItemLinks":{}},"outcomeOrder":0,"pendingNotices":[],"itemLinks":{},"queueCount":0,"queueSources":{"engine":0,"provider":0},"hasRun":false,"status":{"state":"new"}}"#;

/// A unique suffix per home: the clock alone collides between parallel cases.
fn next_home() -> u128 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let counter = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_nanos())
        .unwrap_or(0);
    now * 64 + u128::from(counter)
}

/// A fresh home with the opener's schema, and one thread whose state is `header`.
pub(crate) fn home(thread: &str, header: &str) -> Arc<Connection> {
    let path = std::env::temp_dir().join(format!(
        "ace-engine-home-{}-{}-{}.sqlite",
        std::process::id(),
        thread,
        next_home(),
    ));
    let conn = Connection::open(
        path.to_str().unwrap_or_default(),
        OpenOptions {
            read_only: false,
            timeout_ms: 1_000,
        },
    )
    .unwrap();
    let schema = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/engine-schema.sql"
    ))
    .expect("the opener's schema fixture");
    conn.exec(&schema).unwrap();
    conn.exec("INSERT INTO workspaces VALUES ('workspace', '/tmp', 'Workspace', 0)")
        .unwrap();
    conn.exec(&format!(
        "INSERT INTO threads (id, workspace_id, title, provider, status, created_at, updated_at) \
         VALUES ('{thread}', 'workspace', 'Thread', 'claude', '{{\"state\":\"new\"}}', 0, 0)"
    ))
    .unwrap();
    conn.exec(&format!(
        "INSERT INTO thread_state VALUES ('{thread}', {}, 0)",
        sql_text(header)
    ))
    .unwrap();
    conn
}

/// The same header for a named thread: the snapshot's records are keyed by its `threadId`.
pub(crate) fn header(thread: &str) -> String {
    HEADER.replace("\"threadId\":\"t\"", &format!("\"threadId\":\"{thread}\""))
}

/// A message item with one text part, in the stored shape.
pub(crate) fn message(id: &str, thread: &str, text: &str) -> ace_core::items::Item {
    ace_json::from_value(
        &ace_json::parse(&format!(
            r#"{{"id":"{id}","threadId":"{thread}","agentId":"root","createdAt":1,"complete":true,"type":"message","role":"assistant","parts":[{{"type":"text","text":"{text}"}}]}}"#
        ))
        .unwrap(),
    )
    .unwrap()
}

/// One SQL text literal.
pub(crate) fn sql_text(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// The store seam over a real connection: the shell's transaction lifecycle, nothing else.
pub(crate) struct Shell {
    conn: Arc<Connection>,
    depth: Cell<u32>,
    generation: Cell<f64>,
    seq: Cell<f64>,
    ids: Cell<u64>,
    /// The shell refuses to open a frame: a pending live batch whose flush fails.
    fail_open: Cell<bool>,
    /// Whether a live write is pending for every thread (the pin a sync must respect).
    pinned: Cell<bool>,
    /// Each buffered live write: thread, events, time and callback token.
    pub buffered: RefCell<Vec<(String, String, f64, u64)>>,
    rolled_back: RefCell<Vec<String>>,
}

impl Shell {
    /// A store whose transaction frame cannot open: the read must surface it, not skip it.
    pub fn failing_store(conn: &Arc<Connection>) -> EngineStore {
        Shell::make(conn, true).0
    }

    pub fn store(conn: &Arc<Connection>) -> EngineStore {
        Shell::make(conn, false).0
    }

    /// The store and its controls: a test pins a thread's live write and bumps the generation.
    pub fn store_with_controls(conn: &Arc<Connection>) -> (EngineStore, std::rc::Rc<Shell>) {
        Shell::make(conn, false)
    }

    /// A live write pending for every thread, as a buffered batch's pin.
    pub fn pin(&self, pinned: bool) {
        self.pinned.set(pinned);
    }

    /// A rollback: the store bumps the generation.
    pub fn rollback(&self) {
        self.generation.set(self.generation.get() + 1.0);
    }

    fn make(conn: &Arc<Connection>, fail_open: bool) -> (EngineStore, std::rc::Rc<Shell>) {
        let shell = std::rc::Rc::new(Shell {
            conn: Arc::clone(conn),
            depth: Cell::new(0),
            generation: Cell::new(0.0),
            seq: Cell::new(0.0),
            ids: Cell::new(0),
            fail_open: Cell::new(fail_open),
            pinned: Cell::new(false),
            buffered: RefCell::new(Vec::new()),
            rolled_back: RefCell::new(Vec::new()),
        });
        let store = EngineStore {
            ports: shell.clone(),
            stack: shell.clone(),
            outermost: Cell::new(true),
            conn: Arc::clone(conn),
        };
        (store, shell)
    }
}

impl Ports for Shell {
    fn now(&self) -> f64 {
        0.0
    }
    fn set_timer(&self, _ms: f64) -> Timer {
        let (_sender, fired) = futures::channel::oneshot::channel();
        Timer { key: 0, fired }
    }
    fn cancel_timer(&self, _key: u64) {}
    fn cancel_all_timers(&self) {}
    fn set_batch_timer(&self, ms: f64) -> Timer {
        self.set_timer(ms)
    }
    fn thread_id(&self) -> String {
        "t".to_owned()
    }
    fn command_id(&self) -> String {
        "command".to_owned()
    }
    fn next_id(&self, kind: &str) -> String {
        // Distinct per allocation: a reused id would hide a second run for the same turn.
        let next = self.ids.get() + 1;
        self.ids.set(next);
        format!("{kind}-{next}")
    }
    fn report(&self, _error: String) {}
    fn providers_activated(
        &self,
    ) -> futures::future::LocalBoxFuture<'static, Result<(), PortError>> {
        Box::pin(async { Ok(()) })
    }
    fn wait_for_provider(
        &self,
        _provider: &str,
    ) -> futures::future::LocalBoxFuture<'static, Result<(), PortError>> {
        Box::pin(async { Ok(()) })
    }
    fn resolve_ready(&self, _error: Option<String>) {}
    fn resolve_close(&self, _error: Option<String>) {}
    fn is_transaction_open(&self) -> bool {
        self.depth.get() > 0
    }
    fn open_transaction(&self) -> Result<OpenFrame, PortError> {
        if self.fail_open.get() {
            return Err(PortError::Threw("database is locked".to_owned()));
        }
        let conn = &self.conn;
        let depth = self.depth.get();
        // A nested frame is a savepoint, as the store's stack makes it.
        let open = if depth == 0 {
            "BEGIN".to_owned()
        } else {
            format!("SAVEPOINT s{depth}")
        };
        conn.exec(&open).map_err(store)?;
        self.depth.set(depth + 1);
        Ok(OpenFrame {
            token: u64::from(depth),
            outermost: depth == 0,
        })
    }
    fn close_transaction(&self, _frame: u64, threw: Option<String>) -> Result<(), PortError> {
        let conn = &self.conn;
        let depth = self.depth.get().saturating_sub(1);
        self.depth.set(depth);
        match threw {
            Some(message) => {
                let rollback = if depth == 0 {
                    "ROLLBACK".to_owned()
                } else {
                    format!("ROLLBACK TO s{depth}; RELEASE s{depth}")
                };
                conn.exec(&rollback).map_err(store)?;
                // A nested rollback bumps the generation too (`store.ts:624`, `:629`).
                self.generation.set(self.generation.get() + 1.0);
                self.rolled_back.borrow_mut().push(message);
            }
            None => {
                let commit = if depth == 0 {
                    "COMMIT".to_owned()
                } else {
                    format!("RELEASE s{depth}")
                };
                conn.exec(&commit).map_err(store)?;
            }
        }
        Ok(())
    }
    fn append_events(&self, _json: &str) -> Result<(), PortError> {
        Ok(())
    }
    fn get_thread(&self, _thread: &str) -> Result<Option<String>, PortError> {
        // The shell's thread row is not what a repository case reads; no row is the answer a
        // store with no such thread gives.
        Ok(None)
    }
    fn settle_call(&self, _call: u64, _error: Option<String>) {}
    fn reject_pending(&self) {}
    fn finish_close(&self) {}
    fn write_events(&self, _thread: &str, _payloads: &str, _at: f64) -> Result<(), PortError> {
        Ok(())
    }
    fn head_seq(&self) -> Result<f64, PortError> {
        Ok(self.seq.get())
    }
    /// The test shell caps nothing: the convention is the same text back.
    fn cap_raw(&self, _thread: &str, raw: &str) -> Result<String, PortError> {
        Ok(raw.to_owned())
    }
    fn has_live_write(&self, _thread: &str) -> Result<bool, PortError> {
        Ok(self.pinned.get() || !self.buffered.borrow().is_empty())
    }
    fn prepare_live_write(&self, _bytes: f64) -> Result<(), PortError> {
        Ok(())
    }
    fn buffer_live_write(
        &self,
        thread: &str,
        events: &str,
        at: f64,
        token: u64,
    ) -> Result<(), PortError> {
        self.buffered
            .borrow_mut()
            .push((thread.to_owned(), events.to_owned(), at, token));
        Ok(())
    }
    fn rollback_generation(&self) -> Result<f64, PortError> {
        Ok(self.generation.get())
    }
}

fn store(error: ace_store::Error) -> PortError {
    PortError::Threw(error.to_string())
}

impl EngineStack for Shell {
    fn is_open(&self) -> bool {
        self.depth.get() > 0
    }
    fn after_commit(&self, _token: u64) -> bool {
        false
    }
    fn detach(&self) -> Vec<u64> {
        Vec::new()
    }
}

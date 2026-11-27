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

/// A fresh home with the opener's schema, and one thread whose state is `header`.
pub(crate) fn home(thread: &str, header: &str) -> Arc<Connection> {
    // A counter as well as the clock: parallel cases in one process can read the same instant.
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "ace-engine-home-{}-{}-{}-{}.sqlite",
        std::process::id(),
        thread,
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
    /// Every `writeEvents` batch, in call order, so a case can read the status it published.
    events: RefCell<Vec<(String, String, f64)>>,
    rolled_back: RefCell<Vec<String>>,
    /// Whether `after_commit` defers: off by default, so `Core::defer` releases at once as the
    /// binding does outside a transaction. A case that needs a commit or rollback to take effect
    /// turns it on and hands the tokens to the engine's sink with `take_released`/`take_dropped`.
    defer_commits: Cell<bool>,
    /// The after-commit tokens this frame deferred: released by an outermost commit, dropped by a
    /// rollback, while `defer_commits` is on.
    deferred: RefCell<Vec<u64>>,
    released: RefCell<Vec<u64>>,
    dropped: RefCell<Vec<u64>>,
    /// Armed timers, by key: the sender a test fires, or drops to cancel.
    timers: RefCell<Vec<(u64, Option<futures::channel::oneshot::Sender<()>>)>>,
    next_timer: Cell<u64>,
    /// Keys a test (or the engine) cancelled.
    cancelled: RefCell<Vec<u64>>,
    /// What `onError` was told.
    reports: RefCell<Vec<String>>,
    /// `admits`'s answer, the calls it saw, and the call number it starts throwing at.
    admits_answer: Cell<Option<bool>>,
    admits_calls: Cell<u32>,
    admits_throw_from: Cell<Option<u32>>,
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

    /// Defers after-commit tokens to the frame, for a case that drives the commit itself.
    pub fn defer_commits(&self) {
        self.defer_commits.set(true);
    }

    /// A rollback: the store bumps the generation.
    pub fn rollback(&self) {
        self.generation.set(self.generation.get() + 1.0);
    }

    /// The head sequence `headSeq` answers, so a case can read history through a cutoff.
    pub fn head(&self, seq: f64) {
        self.seq.set(seq);
    }

    /// The tokens a committed frame released, out of the shell so the engine's sink can run them.
    #[allow(dead_code)]
    pub fn take_released(&self) -> Vec<u64> {
        std::mem::take(&mut self.released.borrow_mut())
    }

    /// The tokens a rolled-back frame dropped, out of the shell so the engine's sink can drop them.
    pub fn take_dropped(&self) -> Vec<u64> {
        std::mem::take(&mut self.dropped.borrow_mut())
    }

    fn finish_frame(&self, outer: bool, committed: bool) {
        if !outer {
            return;
        }
        let mut deferred = self.deferred.borrow_mut();
        let target = if committed {
            &self.released
        } else {
            &self.dropped
        };
        target.borrow_mut().append(&mut deferred);
    }

    /// Fires one armed timer, as the clock would.
    pub fn fire(&self, key: u64) {
        let mut timers = self.timers.borrow_mut();
        if let Some(slot) = timers.iter_mut().find(|(armed, _)| *armed == key)
            && let Some(sender) = slot.1.take()
        {
            let _ = sender.send(());
        }
    }

    /// The keys still armed (fired and cancelled ones are gone).
    pub fn armed(&self) -> Vec<u64> {
        self.timers
            .borrow()
            .iter()
            .filter(|(_, sender)| sender.is_some())
            .map(|(key, _)| *key)
            .collect()
    }

    pub fn cancelled(&self) -> Vec<u64> {
        self.cancelled.borrow().clone()
    }

    /// Every event batch the engine wrote, in call order.
    pub fn events(&self) -> Vec<(String, String, f64)> {
        self.events.borrow().clone()
    }

    pub fn reports(&self) -> Vec<String> {
        self.reports.borrow().clone()
    }

    /// What `admits` answers; `None` is yes, as the port's default is.
    pub fn answer_admits(&self, answer: Option<bool>) {
        self.admits_answer.set(answer);
    }

    /// `admits` starts throwing from its `nth` call (1-based).
    pub fn throw_admits_from(&self, nth: u32) {
        self.admits_throw_from.set(Some(nth));
    }

    pub fn admits_calls(&self) -> u32 {
        self.admits_calls.get()
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
            events: RefCell::new(Vec::new()),
            rolled_back: RefCell::new(Vec::new()),
            defer_commits: Cell::new(false),
            deferred: RefCell::new(Vec::new()),
            released: RefCell::new(Vec::new()),
            dropped: RefCell::new(Vec::new()),
            timers: RefCell::new(Vec::new()),
            next_timer: Cell::new(0),
            cancelled: RefCell::new(Vec::new()),
            reports: RefCell::new(Vec::new()),
            admits_answer: Cell::new(None),
            admits_calls: Cell::new(0),
            admits_throw_from: Cell::new(None),
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
        let next = self.next_timer.get() + 1;
        self.next_timer.set(next);
        let (sender, fired) = futures::channel::oneshot::channel();
        self.timers.borrow_mut().push((next, Some(sender)));
        Timer { key: next, fired }
    }
    fn cancel_timer(&self, key: u64) {
        self.cancelled.borrow_mut().push(key);
        let mut timers = self.timers.borrow_mut();
        if let Some(slot) = timers.iter_mut().find(|(armed, _)| *armed == key) {
            slot.1 = None;
        }
    }
    fn cancel_all_timers(&self) {
        let keys: Vec<u64> = self.armed();
        for key in keys {
            self.cancel_timer(key);
        }
    }
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
    fn report(&self, error: String) {
        self.reports.borrow_mut().push(error);
    }

    /// The maintenance gate: a test answers it, and can make a later call throw.
    fn admits(&self) -> Result<bool, PortError> {
        let calls = self.admits_calls.get() + 1;
        self.admits_calls.set(calls);
        if self
            .admits_throw_from
            .get()
            .is_some_and(|from| calls >= from)
        {
            return Err(PortError::Threw("maintenance gate threw".to_owned()));
        }
        Ok(self.admits_answer.get().unwrap_or(true))
    }
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
                // Whatever this frame deferred never fires, nested or outer.
                self.finish_frame(true, false);
            }
            None => {
                let commit = if depth == 0 {
                    "COMMIT".to_owned()
                } else {
                    format!("RELEASE s{depth}")
                };
                conn.exec(&commit).map_err(store)?;
                self.finish_frame(depth == 0, true);
            }
        }
        Ok(())
    }
    fn append_events(&self, _json: &str) -> Result<(), PortError> {
        Ok(())
    }
    fn get_thread(&self, thread: &str) -> Result<Option<String>, PortError> {
        // The row as `store.getThread` shapes it: the columns the engine reads, and the JSON
        // columns parsed so `lineage`/`details`/`live` are objects, never strings.
        let Some(row) = ace_store::stmt_cache::get_row(
            &self.conn,
            "SELECT * FROM threads WHERE id=?",
            vec![ace_store::Value::Text(thread.to_owned())],
        )
        .map_err(|error| PortError::Threw(error.to_string()))?
        else {
            return Ok(None);
        };
        let mut value = ace_json::Map::new();
        value.insert("id", ace_json::Value::from(thread));
        if let Some(workspace) = row
            .get("workspace_id")
            .and_then(crate::repository::residency::cell_text)
        {
            value.insert("workspaceId", ace_json::Value::from(workspace));
        }
        if let Some(title) = row
            .get("title")
            .and_then(crate::repository::residency::cell_text)
        {
            value.insert("title", ace_json::Value::from(title));
        }
        if let Some(provider) = row
            .get("provider")
            .and_then(crate::repository::residency::cell_text)
        {
            value.insert("provider", ace_json::Value::from(provider));
        }
        for (column, key) in [
            ("status", "status"),
            ("imported", "imported"),
            ("acp", "acp"),
            ("transitions", "transitions"),
            ("provider_metadata", "providerMetadata"),
            ("client", "client"),
        ] {
            if let Some(text) = row
                .get(column)
                .and_then(crate::repository::residency::cell_text)
                && let Ok(parsed) = ace_json::parse(text)
            {
                value.insert(key, parsed);
            }
        }
        if let Some(root) = row
            .get("root_agent_id")
            .and_then(crate::repository::residency::cell_text)
        {
            value.insert("rootAgentId", ace_json::Value::from(root));
        }
        // The TypeScript's `details`, `deletedAt` and `live` live in the client JSON.
        if let Some(client) = value.get("client").cloned()
            && let Some(object) = client.as_object()
        {
            for key in [
                "details",
                "deletedAt",
                "live",
                "lineage",
                "switch",
                "continuation",
                "movedTo",
            ] {
                if let Some(entry) = object.get(key) {
                    value.insert(key, entry.clone());
                }
            }
        }
        Ok(Some(ace_json::to_string(&ace_json::Value::Object(value))))
    }
    fn settle_call(&self, _call: u64, _error: Option<String>) {}
    fn reject_pending(&self) {}
    fn finish_close(&self) {}
    fn write_events(&self, thread: &str, payloads: &str, at: f64) -> Result<(), PortError> {
        self.events
            .borrow_mut()
            .push((thread.to_owned(), payloads.to_owned(), at));
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
    fn after_commit(&self, token: u64) -> bool {
        if !self.defer_commits.get() || self.depth.get() == 0 {
            return false;
        }
        self.deferred.borrow_mut().push(token);
        true
    }
    fn detach(&self) -> Vec<u64> {
        std::mem::take(&mut self.deferred.borrow_mut())
    }
}

// SPDX-License-Identifier: Apache-2.0
//! The transaction stack (docs/store/porting-guide.md, task 5.5). Ports `Store.transaction`
//! and its `recoverSavepoint`, `rollBack` and settlement helpers: depth, numbered savepoints,
//! `BEGIN IMMEDIATE`, `RELEASE`, savepoint recovery, the doomed flag, rollback, settlement
//! positions and the publication order.
//!
//! A JavaScript closure cannot run inside a Rust call, so a caller opens a [`Frame`], runs its
//! work, then calls exactly one of [`TransactionStack::succeed`] or
//! [`TransactionStack::fail`]. The returned [`Finish`] lists, in order, the steps the caller
//! runs after the SQL is done. The stack owns depth, the doomed flag, the event positions and
//! the pending settlement list; the caller owns the event objects and the settlement callbacks.

use crate::{Connection, Error, ErrorKind};
use ace_json::{JsString, Map, Number};
use std::fmt;

/// Identifies a caller-owned settlement callback (the TypeScript `TransactionOutcome`).
pub type SettlementId = u64;

/// How a settlement ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Settled {
    Committed,
    RolledBack,
}

/// What the caller runs, in order, after the stack has finished its SQL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Publish the caller's events in `from..to`.
    Publish { from: usize, to: usize },
    /// Run one settlement callback.
    Settle { id: SettlementId, how: Settled },
}

/// How the frame's SQL ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ending {
    Released,
    Committed,
    RolledBackToSavepoint,
    RolledBack,
}

/// Why a frame could not finish.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FinishError {
    /// COMMIT, RELEASE or a statement failed; the SQLite error, untranslated.
    Sqlite(Error),
    /// "A failed step could not be undone, so the transaction rolled back".
    ///
    /// The payload is for the binding's shape; the caller keeps the JavaScript exception it
    /// threw, because Rust never saw it (`fail` takes no error).
    Doomed(Error),
}

/// What the stack did, and what the caller does next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finish {
    pub ending: Ending,
    /// The caller truncates its event list to this length before running `steps`.
    pub events_len: usize,
    pub steps: Vec<Step>,
    /// Recovery failures (a failed ROLLBACK, a failed ROLLBACK TO): report, never throw.
    pub reports: Vec<Error>,
    /// The error the caller throws after running `steps`; None for Released and Committed.
    /// When the caller's own `run` threw, it throws that instead and this stays None.
    pub error: Option<FinishError>,
    /// Bump `rollbackGeneration` and drop the read and sidebar caches.
    pub rolled_back: bool,
}

/// One open frame: its depth, savepoint, and the positions it began at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    depth: u32,
    savepoint: Option<String>,
    events_len: usize,
    settlements_len: usize,
    own: Option<SettlementId>,
}

impl Frame {
    /// Whether this frame is a savepoint inside an open transaction.
    pub fn nested(&self) -> bool {
        self.savepoint.is_some()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Settlement {
    at: usize,
    id: SettlementId,
}

/// The stack's own state: depth, the doomed error, the event position and the pending
/// settlements, in the order they joined.
#[derive(Debug, Default)]
pub struct TransactionStack {
    open: bool,
    depth: u32,
    doomed: Option<Error>,
    events_len: usize,
    settlements: Vec<Settlement>,
}

impl TransactionStack {
    pub fn new() -> TransactionStack {
        TransactionStack::default()
    }

    /// Whether a top-level transaction is open.
    pub fn is_open(&self) -> bool {
        self.open
    }

    /// `BEGIN IMMEDIATE` at depth 0, else `SAVEPOINT nested_<n>`. Err: nothing was opened and
    /// there is nothing to clean up.
    ///
    /// The TypeScript bumps its depth before `SAVEPOINT`; a failed `SAVEPOINT` leaves that
    /// number used up, so this does the same. A failed `BEGIN IMMEDIATE` changes nothing.
    pub fn begin(&mut self, conn: &Connection, own: Option<SettlementId>) -> Result<Frame, Error> {
        if self.open {
            let depth = self.depth + 1;
            self.depth = depth;
            let savepoint = format!("nested_{depth}");
            conn.exec(&format!("SAVEPOINT {savepoint}"))?;
            return Ok(Frame {
                depth,
                savepoint: Some(savepoint),
                events_len: self.events_len,
                settlements_len: self.settlements.len(),
                own,
            });
        }
        conn.exec("BEGIN IMMEDIATE")?;
        self.open = true;
        self.events_len = 0;
        Ok(Frame {
            depth: 0,
            savepoint: None,
            events_len: 0,
            settlements_len: self.settlements.len(),
            own,
        })
    }

    /// The caller's event list grew to `len` (events written inside the open transaction).
    pub fn note_events(&mut self, len: usize) {
        if self.open {
            self.events_len = len;
        }
    }

    /// `run` returned. Never returns Err: every failure is in `Finish`, and on any failure the
    /// stack has already rolled back (to the savepoint, or the whole transaction).
    pub fn succeed(&mut self, conn: &Connection, frame: Frame) -> Finish {
        if frame.depth == 0 {
            self.succeed_top(conn, frame)
        } else {
            self.succeed_nested(conn, frame)
        }
    }

    /// `run` threw. Never returns Err.
    pub fn fail(&mut self, conn: &Connection, frame: Frame) -> Finish {
        if frame.depth == 0 {
            self.fail_top(conn, frame)
        } else {
            self.fail_nested(conn, frame)
        }
    }

    fn succeed_top(&mut self, conn: &Connection, frame: Frame) -> Finish {
        if let Some(doomed) = self.doomed.take() {
            let mut reports = Vec::new();
            self.roll_back(conn, &mut reports);
            return self.top_rolled_back(reports, Some(FinishError::Doomed(doomed)));
        }
        match conn.exec("COMMIT") {
            Ok(()) => {
                let events_len = self.events_len;
                let steps = commit_steps(frame.own, events_len, &mut self.settlements);
                self.open = false;
                self.depth = 0;
                self.events_len = 0;
                Finish {
                    ending: Ending::Committed,
                    events_len,
                    steps,
                    reports: Vec::new(),
                    error: None,
                    rolled_back: false,
                }
            }
            Err(error) => {
                let mut reports = Vec::new();
                self.roll_back(conn, &mut reports);
                self.top_rolled_back(reports, Some(FinishError::Sqlite(error)))
            }
        }
    }

    fn succeed_nested(&mut self, conn: &Connection, frame: Frame) -> Finish {
        let released = match frame.savepoint.as_deref() {
            Some(savepoint) => conn.exec(&format!("RELEASE {savepoint}")),
            None => Ok(()),
        };
        self.depth = frame.depth.saturating_sub(1);
        match released {
            Ok(()) => {
                if let Some(own) = frame.own {
                    self.events_len = frame.events_len;
                    self.settlements.push(Settlement {
                        at: frame.events_len,
                        id: own,
                    });
                }
                Finish {
                    ending: Ending::Released,
                    events_len: self.events_len,
                    steps: Vec::new(),
                    reports: Vec::new(),
                    error: None,
                    rolled_back: false,
                }
            }
            Err(error) => {
                // The release failed after `run` returned: the caller has no exception of its
                // own, so the SQLite error is what it throws. The frame still recovers, and
                // dooms the outer transaction when it cannot.
                let mut reports = Vec::new();
                let recovered = self.recover_savepoint(conn, &frame, &mut reports);
                if !recovered {
                    self.doom(error.clone());
                }
                let steps = self.settle_since(frame.settlements_len);
                self.events_len = frame.events_len;
                Finish {
                    ending: nested_ending(recovered),
                    events_len: frame.events_len,
                    steps,
                    reports,
                    error: Some(FinishError::Sqlite(error)),
                    rolled_back: true,
                }
            }
        }
    }

    fn fail_top(&mut self, conn: &Connection, _frame: Frame) -> Finish {
        let mut reports = Vec::new();
        self.roll_back(conn, &mut reports);
        self.doomed = None;
        self.top_rolled_back(reports, None)
    }

    fn fail_nested(&mut self, conn: &Connection, frame: Frame) -> Finish {
        let mut reports = Vec::new();
        let recovered = self.recover_savepoint(conn, &frame, &mut reports);
        if !recovered {
            // The caller's own exception is the TypeScript's cause; Rust never sees it, so
            // the shell keeps it. The payload here only says "doomed" to the binding.
            let cause = reports.last().cloned().unwrap_or_else(no_transaction_error);
            self.doom(cause);
        }
        let steps = self.settle_since(frame.settlements_len);
        self.events_len = frame.events_len;
        self.depth = frame.depth.saturating_sub(1);
        Finish {
            ending: nested_ending(recovered),
            events_len: frame.events_len,
            steps,
            reports,
            error: None,
            rolled_back: true,
        }
    }

    /// The whole transaction failed: every pending settlement rolls back, in order.
    fn top_rolled_back(&mut self, reports: Vec<Error>, error: Option<FinishError>) -> Finish {
        let steps = self.settle_since(0);
        self.open = false;
        self.depth = 0;
        self.events_len = 0;
        Finish {
            ending: Ending::RolledBack,
            events_len: 0,
            steps,
            reports,
            error,
            rolled_back: true,
        }
    }

    /// Drain the settlements registered at or after `from`, each as one rollback step.
    fn settle_since(&mut self, from: usize) -> Vec<Step> {
        self.settlements
            .drain(from..)
            .map(|settlement| Step::Settle {
                id: settlement.id,
                how: Settled::RolledBack,
            })
            .collect()
    }

    fn doom(&mut self, error: Error) {
        if self.doomed.is_none() {
            self.doomed = Some(error);
        }
    }

    /// `recoverSavepoint`: undo a savepoint; false when it could not be (the failure is
    /// reported, not thrown).
    fn recover_savepoint(
        &self,
        conn: &Connection,
        frame: &Frame,
        reports: &mut Vec<Error>,
    ) -> bool {
        let Some(savepoint) = frame.savepoint.as_deref() else {
            return false;
        };
        if !matches!(conn.is_transaction(), Ok(true)) {
            return false;
        }
        match conn.exec(&format!("ROLLBACK TO {savepoint}; RELEASE {savepoint}")) {
            Ok(()) => true,
            Err(error) => {
                reports.push(error);
                false
            }
        }
    }

    /// `rollBack`: roll back the open transaction unless SQLite already did. A failure is
    /// reported; the caller's own error is the one thrown.
    fn roll_back(&self, conn: &Connection, reports: &mut Vec<Error>) {
        if !matches!(conn.is_transaction(), Ok(true)) {
            return;
        }
        if let Err(error) = conn.exec("ROLLBACK") {
            reports.push(error);
        }
    }
}

fn nested_ending(recovered: bool) -> Ending {
    if recovered {
        Ending::RolledBackToSavepoint
    } else {
        Ending::RolledBack
    }
}

fn no_transaction_error() -> Error {
    Error {
        kind: ErrorKind::Sqlite,
        code: 0,
        message: "no open transaction to roll back".to_owned(),
        errstr: String::new(),
    }
}

/// The committed frame's steps, in the TypeScript's order: its own outcome first; then each
/// pending settlement's events, then its commit; the tail of the events; and no publication at
/// all when the frame has its own outcome (outer-outcome suppression).
fn commit_steps(
    own: Option<SettlementId>,
    events_len: usize,
    settlements: &mut Vec<Settlement>,
) -> Vec<Step> {
    let mut steps = Vec::new();
    if let Some(id) = own {
        steps.push(Step::Settle {
            id,
            how: Settled::Committed,
        });
    }
    let mut from = 0;
    for settlement in settlements.drain(..) {
        if own.is_none() {
            steps.push(Step::Publish {
                from,
                to: settlement.at,
            });
        }
        from = settlement.at;
        steps.push(Step::Settle {
            id: settlement.id,
            how: Settled::Committed,
        });
    }
    if own.is_none() {
        steps.push(Step::Publish {
            from,
            to: events_len,
        });
    }
    steps
}

/// For Rust callers: begin, run, then succeed or fail, returning the Finish. The caller that
/// appends events calls `note_events` through the stack; this helper cannot while `run` runs.
pub fn atomic<T>(
    stack: &mut TransactionStack,
    conn: &Connection,
    own: Option<SettlementId>,
    run: impl FnOnce(&Connection) -> Result<T, Error>,
) -> (Option<T>, Finish) {
    let frame = match stack.begin(conn, own) {
        Ok(frame) => frame,
        Err(error) => {
            return (
                None,
                Finish {
                    ending: Ending::RolledBack,
                    events_len: 0,
                    steps: Vec::new(),
                    reports: Vec::new(),
                    error: Some(FinishError::Sqlite(error)),
                    rolled_back: false,
                },
            );
        }
    };
    match run(conn) {
        Ok(value) => (Some(value), stack.succeed(conn, frame)),
        Err(error) => {
            let mut finish = stack.fail(conn, frame);
            // `fail` never sees the caller's error; a Rust caller has no exception to throw,
            // so its SQLite error travels in the Finish.
            finish.error = Some(FinishError::Sqlite(error));
            (None, finish)
        }
    }
}

/// The finish as the JSON the shell reads. Every error is the shape `fail()` puts after
/// `ace-store:`; a doomed finish names its kind so the shell uses its own exception as cause.
pub fn finish_json(finish: &Finish) -> String {
    let mut map = Map::new();
    map.insert(
        "ending",
        ace_json::Value::String(JsString::from(ending_name(finish.ending))),
    );
    map.insert(
        "eventsLen",
        ace_json::Value::Number(Number::from(finish.events_len as u64)),
    );
    let steps: Vec<ace_json::Value> = finish.steps.iter().map(step_value).collect();
    map.insert("steps", ace_json::Value::Array(steps.into()));
    let reports: Vec<ace_json::Value> = finish.reports.iter().map(error_value).collect();
    map.insert("reports", ace_json::Value::Array(reports.into()));
    map.insert(
        "error",
        match &finish.error {
            Some(FinishError::Sqlite(error)) => error_value(error),
            Some(FinishError::Doomed(_)) => doomed_value(),
            None => ace_json::Value::Null,
        },
    );
    map.insert("rolledBack", ace_json::Value::Bool(finish.rolled_back));
    ace_json::to_string(&ace_json::Value::Object(map))
}

fn ending_name(ending: Ending) -> &'static str {
    match ending {
        Ending::Released => "released",
        Ending::Committed => "committed",
        Ending::RolledBackToSavepoint => "rolledBackToSavepoint",
        Ending::RolledBack => "rolledBack",
    }
}

fn step_value(step: &Step) -> ace_json::Value {
    let mut map = Map::new();
    match step {
        Step::Publish { from, to } => {
            map.insert("kind", ace_json::Value::String(JsString::from("publish")));
            map.insert("from", ace_json::Value::Number(Number::from(*from as u64)));
            map.insert("to", ace_json::Value::Number(Number::from(*to as u64)));
        }
        Step::Settle { id, how } => {
            map.insert("kind", ace_json::Value::String(JsString::from("settle")));
            map.insert("id", ace_json::Value::Number(Number::from(*id)));
            map.insert(
                "how",
                ace_json::Value::String(JsString::from(match how {
                    Settled::Committed => "committed",
                    Settled::RolledBack => "rolledBack",
                })),
            );
        }
    }
    ace_json::Value::Object(map)
}

fn error_value(error: &Error) -> ace_json::Value {
    let mut map = Map::new();
    map.insert(
        "kind",
        ace_json::Value::String(JsString::from(error_kind(&error.kind))),
    );
    map.insert(
        "errcode",
        ace_json::Value::Number(Number::from(error.code as i64)),
    );
    map.insert(
        "message",
        ace_json::Value::String(JsString::from(error.message.as_str())),
    );
    map.insert(
        "errstr",
        ace_json::Value::String(JsString::from(error.errstr.as_str())),
    );
    ace_json::Value::Object(map)
}

fn doomed_value() -> ace_json::Value {
    let mut map = Map::new();
    map.insert("kind", ace_json::Value::String(JsString::from("doomed")));
    map.insert("errcode", ace_json::Value::Number(Number::from(0i64)));
    map.insert("message", ace_json::Value::String(JsString::from("")));
    map.insert("errstr", ace_json::Value::String(JsString::from("")));
    ace_json::Value::Object(map)
}

fn error_kind(kind: &ErrorKind) -> &'static str {
    match kind {
        ErrorKind::Sqlite => "sqlite",
        ErrorKind::NoStatement => "no-statement",
        ErrorKind::Closed => "closed",
        ErrorKind::Finalized => "finalized",
    }
}

impl fmt::Display for FinishError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FinishError::Sqlite(error) | FinishError::Doomed(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for FinishError {}

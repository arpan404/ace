// SPDX-License-Identifier: Apache-2.0
//! The startup candidate scan (E5.3 step 9, `repository.ts:255`-`:282`), in 64-candidate pages
//! that stop only on an empty page.
//!
//! The set is `repository.ts:259`-`:266`'s union with its dedup: threads whose status is not
//! `new`, `done` or `failed`; threads with a `pending`/`queued`/`running` intent, or
//! `awaiting=1` or `uncertain=1`; threads with an `engine_queue` row carrying a continuation, a
//! trigger, `limited=1` or `paused=1`. Each must have a `thread_state` row and `thread_id > ''`.
//!
//! The order is the TypeScript's: ascending `thread_id` under SQLite's `BINARY` collation, each
//! candidate once. Every source is read **in `thread_id` order** and merged by a watermark, so
//! nothing is sorted after the fact. A source's page is at most 256 rows scanned and its cursor
//! advances to the last row scanned, matched or not; a short page exhausts it. Matches at or
//! below the watermark and above the last emitted id are emitted in order, each checked against
//! `thread_state`; matches above it are held (at most 3 x 256).

use ace_store::{Connection, Value, stmt_cache};
use std::collections::BTreeSet;
use std::sync::Arc;

use crate::{EngineError, ThreadId};

const THREADS: &str = "SELECT id AS thread_id FROM threads WHERE json_extract(status,'$.state') NOT IN ('new','done','failed') AND id > ? ORDER BY id LIMIT 256";
const INTENTS: &str = "SELECT thread_id, status, awaiting, uncertain, id FROM intents WHERE (thread_id, status, id) > (?, ?, ?) ORDER BY thread_id, status, id LIMIT 256";
const QUEUES: &str = "SELECT thread_id FROM engine_queue WHERE thread_id > ? AND (continuation IS NOT NULL OR trigger IS NOT NULL OR limited=1 OR paused=1) ORDER BY thread_id LIMIT 256";
const HAS_STATE: &str = "SELECT 1 FROM thread_state WHERE thread_id=?";

/// One scan step: a page closed with candidates, still building, or the scan's end.
pub struct Step {
    pub threads: Vec<ThreadId>,
    pub done: bool,
}

/// One source's cursor: the last row scanned, matched or not.
#[derive(Default)]
struct Source {
    last: String,
    /// The intent cursor's status and id, for the row-value comparison.
    status: String,
    id: i64,
    exhausted: bool,
}

/// One page being built.
pub struct Scan {
    /// The page re-queries from here: the last recovered id of the previous page (`:256`).
    after: String,
    page: Vec<ThreadId>,
    held: BTreeSet<ThreadId>,
    emitted: String,
    threads: Source,
    intents: Source,
    queues: Source,
}

impl Default for Scan {
    fn default() -> Scan {
        Scan::new(String::new())
    }
}

impl Scan {
    /// A scan whose next page starts above `after`.
    pub fn new(after: impl Into<String>) -> Scan {
        Scan {
            after: after.into(),
            page: Vec::new(),
            held: BTreeSet::new(),
            emitted: String::new(),
            threads: Source {
                last: String::new(),
                ..Source::default()
            },
            intents: Source {
                last: String::new(),
                ..Source::default()
            },
            queues: Source {
                last: String::new(),
                ..Source::default()
            },
        }
    }

    /// Start the next page from `after`, discarding every cursor and held match: exactly the
    /// TypeScript's next query (`:256`).
    pub fn restart(&mut self, after: impl Into<String>) {
        *self = Scan::new(after);
    }

    /// The scan's own cursor, for the next page's re-query.
    pub fn after(&self) -> &str {
        &self.after
    }

    /// One pump step: scan one page from each source at the watermark and emit what is final.
    /// Returns the page when it closes (64 candidates, or exhaustion), else `None`.
    pub fn step(&mut self, conn: &Arc<Connection>) -> Result<Option<Step>, EngineError> {
        if self.page.len() >= 64 {
            return Ok(Some(self.close(false)));
        }
        if self.exhausted() && self.held.is_empty() {
            return Ok(Some(Step {
                threads: Vec::new(),
                done: true,
            }));
        }
        let watermark = self.watermark();
        if !self.threads.exhausted && self.threads.last <= watermark {
            self.pump_threads(conn)?;
        }
        if !self.intents.exhausted && self.intents.last <= watermark {
            self.pump_intents(conn)?;
        }
        if !self.queues.exhausted && self.queues.last <= watermark {
            self.pump_queues(conn)?;
        }
        self.emit(conn)?;
        if self.page.len() >= 64 {
            return Ok(Some(self.close(false)));
        }
        if self.exhausted() && self.held.is_empty() {
            return Ok(Some(self.close(true)));
        }
        Ok(None)
    }

    fn close(&mut self, _exhausted: bool) -> Step {
        let threads = std::mem::take(&mut self.page);
        let last = threads
            .last()
            .cloned()
            .unwrap_or_else(|| self.after.clone());
        if !threads.is_empty() {
            self.after = last;
        }
        let done = threads.is_empty();
        Step { threads, done }
    }

    fn exhausted(&self) -> bool {
        self.threads.exhausted && self.intents.exhausted && self.queues.exhausted
    }

    /// The smallest last-scanned id over the sources not yet exhausted.
    fn watermark(&self) -> String {
        let mut watermark: Option<&str> = None;
        for source in [&self.threads, &self.intents, &self.queues] {
            if source.exhausted {
                continue;
            }
            watermark = Some(match watermark {
                Some(current) => current.min(source.last.as_str()),
                None => source.last.as_str(),
            });
        }
        watermark.unwrap_or("\u{10ffff}").to_owned()
    }

    fn pump_threads(&mut self, conn: &Arc<Connection>) -> Result<(), EngineError> {
        let rows =
            stmt_cache::all_rows(conn, THREADS, vec![Value::Text(self.threads.last.clone())])?;
        let short = rows.len() < 256;
        for row in &rows {
            if let Some(id) = row.get("thread_id").and_then(cell_text) {
                self.threads.last = id.to_owned();
                self.offer(id);
            }
        }
        self.threads.exhausted = short;
        Ok(())
    }

    fn pump_intents(&mut self, conn: &Arc<Connection>) -> Result<(), EngineError> {
        let rows = stmt_cache::all_rows(
            conn,
            INTENTS,
            vec![
                Value::Text(self.intents.last.clone()),
                Value::Text(self.intents.status.clone()),
                Value::Integer(self.intents.id),
            ],
        )?;
        let short = rows.len() < 256;
        for row in &rows {
            let thread = row.get("thread_id").and_then(cell_text).unwrap_or_default();
            let status = row.get("status").and_then(cell_text).unwrap_or_default();
            let id = row.get("id").and_then(cell_int).unwrap_or(0);
            self.intents.last = thread.to_owned();
            self.intents.status = status.to_owned();
            self.intents.id = id;
            let awaiting = row.get("awaiting").and_then(cell_int) == Some(1);
            let uncertain = row.get("uncertain").and_then(cell_int) == Some(1);
            if matches!(status, "pending" | "queued" | "running") || awaiting || uncertain {
                self.offer(thread);
            }
        }
        self.intents.exhausted = short;
        Ok(())
    }

    fn pump_queues(&mut self, conn: &Arc<Connection>) -> Result<(), EngineError> {
        let rows = stmt_cache::all_rows(conn, QUEUES, vec![Value::Text(self.queues.last.clone())])?;
        let short = rows.len() < 256;
        for row in &rows {
            if let Some(id) = row.get("thread_id").and_then(cell_text) {
                self.queues.last = id.to_owned();
                self.offer(id);
            }
        }
        self.queues.exhausted = short;
        Ok(())
    }

    fn offer(&mut self, id: &str) {
        if id.is_empty() || id <= self.emitted.as_str() {
            return;
        }
        if self.held.len() < 3 * 256 {
            self.held.insert(id.to_owned());
        }
    }

    /// Emit every held match at or below the new watermark, above the last emitted id, in
    /// order, each only if it has a `thread_state` row (`:265`).
    fn emit(&mut self, conn: &Arc<Connection>) -> Result<(), EngineError> {
        let watermark = self.watermark();
        let ready: Vec<String> = self
            .held
            .range(..=watermark.clone())
            .filter(|id| id.as_str() > self.emitted.as_str())
            .cloned()
            .collect();
        for id in ready {
            self.held.remove(&id);
            if self.page.len() >= 64 {
                break;
            }
            if stmt_cache::get_row(conn, HAS_STATE, vec![Value::Text(id.clone())])?.is_none() {
                self.emitted = id;
                continue;
            }
            self.emitted = id.clone();
            self.page.push(id);
        }
        Ok(())
    }
}

/// A row cell as text.
fn cell_text(value: &Value) -> Option<&str> {
    match value {
        Value::Text(text) => Some(text.as_str()),
        _ => None,
    }
}

/// A row cell as an integer.
fn cell_int(value: &Value) -> Option<i64> {
    match value {
        Value::Integer(number) => Some(*number),
        _ => None,
    }
}

/// A whole scan for a test that only needs the pages.
pub fn pages(conn: &Arc<Connection>) -> Result<Vec<Vec<ThreadId>>, EngineError> {
    let mut scan = Scan::new(String::new());
    let mut pages = Vec::new();
    loop {
        match scan.step(conn)? {
            Some(step) if step.threads.is_empty() => break,
            Some(step) => {
                let last = step.threads.last().cloned().unwrap_or_default();
                pages.push(step.threads);
                scan.restart(last);
            }
            None => continue,
        }
    }
    Ok(pages)
}

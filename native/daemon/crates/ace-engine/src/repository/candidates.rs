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

// Each source scans at most 256 rows by its cursor and the predicate is evaluated here, so a
// home with a million finished threads never scans them all in one step (E5.3 step 9). The
// predicates and the order are the TypeScript union's (`repository.ts:259`-`:266`).
const THREADS: &str = "SELECT id AS thread_id, json_extract(status,'$.state') AS state FROM threads WHERE id > ? ORDER BY id LIMIT 256";
const INTENTS: &str = "SELECT thread_id, status, awaiting, uncertain, id FROM intents WHERE (thread_id, status, id) > (?, ?, ?) ORDER BY thread_id, status, id LIMIT 256";
const QUEUES: &str = "SELECT thread_id, continuation, trigger, limited, paused FROM engine_queue WHERE thread_id > ? ORDER BY thread_id LIMIT 256";
const HAS_STATE: &str = "SELECT 1 FROM thread_state WHERE thread_id=?";

/// Sorts after every status a row can carry (U+10FFFF is the highest code point).
const MAX_STATUS: &str = "\u{10ffff}";

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
    /// A scan whose next page starts above `after`: every source cursor begins at `after`, as
    /// the TypeScript's next query does (`WHERE thread_id > after`).
    pub fn new(after: impl Into<String>) -> Scan {
        let after = after.into();
        Scan {
            after: after.clone(),
            page: Vec::new(),
            held: BTreeSet::new(),
            emitted: after.clone(),
            threads: Source {
                last: after.clone(),
                ..Source::default()
            },
            // The intent cursor is a `(thread_id, status, id)` row value: the sentinel pair
            // sorts after every row whose thread id is `after`, so the page starts strictly
            // above it.
            intents: Source {
                last: after.clone(),
                status: MAX_STATUS.to_owned(),
                id: i64::MAX,
                ..Source::default()
            },
            queues: Source {
                last: after,
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
            return Ok(Some(self.close()));
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
            return Ok(Some(self.close()));
        }
        if self.exhausted() && self.held.is_empty() {
            return Ok(Some(self.close()));
        }
        Ok(None)
    }

    fn close(&mut self) -> Step {
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
            let Some(id) = row.get("thread_id").and_then(cell_text) else {
                continue;
            };
            self.threads.last = id.to_owned();
            // `json_extract(status,'$.state') NOT IN ('new','done','failed')`: a null state is
            // SQL's NULL, which the TypeScript's NOT IN does not match either.
            match row.get("state").and_then(cell_text) {
                Some(state) if !matches!(state, "new" | "done" | "failed") => self.offer(id),
                _ => {}
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
            let Some(id) = row.get("thread_id").and_then(cell_text) else {
                continue;
            };
            self.queues.last = id.to_owned();
            let set = |key: &str| {
                row.get(key)
                    .is_some_and(|value| !matches!(value, Value::Null))
            };
            let one = |key: &str| row.get(key).and_then(cell_int) == Some(1);
            if set("continuation") || set("trigger") || one("limited") || one("paused") {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A temp store with only the tables the scan reads: the scan's own SQL is what is under
    /// test, and the opener's full schema is proven by the seam tests.
    fn database() -> Arc<Connection> {
        // A counter, not the clock: two parallel tests can read the same nanosecond.
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "ace-engine-scan-{}-{}.sqlite",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let conn = Connection::open(
            path.to_str().unwrap_or_default(),
            ace_store::OpenOptions {
                read_only: false,
                timeout_ms: 5_000,
            },
        )
        .unwrap();
        conn.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, status TEXT)")
            .unwrap();
        conn.exec("CREATE TABLE thread_state (thread_id TEXT PRIMARY KEY, state TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0)").unwrap();
        conn.exec("CREATE TABLE intents (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, status TEXT NOT NULL, awaiting INTEGER NOT NULL DEFAULT 0, uncertain INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'thread.send')").unwrap();
        conn.exec("CREATE TABLE engine_queue (thread_id TEXT PRIMARY KEY, continuation TEXT, trigger TEXT, limited INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0)").unwrap();
        conn
    }

    fn text(value: &str) -> Value {
        Value::Text(value.to_owned())
    }

    /// One thread row, its engine state, and the status the scan reads.
    fn thread(conn: &Arc<Connection>, id: &str, status: &str) {
        stmt_cache::run(
            conn,
            "INSERT INTO threads VALUES (?, ?)",
            vec![text(id), text(&format!("{{\"state\":\"{status}\"}}"))],
        )
        .unwrap();
        stmt_cache::run(
            conn,
            "INSERT INTO thread_state VALUES (?, '{}', 0)",
            vec![text(id)],
        )
        .unwrap();
    }

    fn intent(conn: &Arc<Connection>, id: &str, status: &str) {
        stmt_cache::run(
            conn,
            "INSERT INTO intents (thread_id, status) VALUES (?, ?)",
            vec![text(id), text(status)],
        )
        .unwrap();
    }

    fn queue(conn: &Arc<Connection>, id: &str) {
        stmt_cache::run(
            conn,
            "INSERT INTO engine_queue (thread_id, continuation) VALUES (?, 'go')",
            vec![text(id)],
        )
        .unwrap();
    }

    /// Runs one page's steps until it closes.
    fn page(scan: &mut Scan, conn: &Arc<Connection>) -> Step {
        loop {
            if let Some(step) = scan.step(conn).unwrap() {
                return step;
            }
        }
    }

    #[test]
    fn a_page_that_matches_nothing_does_not_end_the_scan() {
        let conn = database();
        // Rows the intent source reads and the predicate refuses: a page can scan 256 of them,
        // match none, and have candidates after it.
        for index in 0..300 {
            intent(&conn, &format!("t{index:04}"), "done");
        }
        thread(&conn, "t0300", "working");
        intent(&conn, "t0300", "pending");
        let mut scan = Scan::new(String::new());
        // The first 256 rows match nothing, and their page is still open: a step that matched
        // nothing does not end the scan.
        assert!(
            scan.step(&conn).unwrap().is_none(),
            "a step that matches nothing neither closes a page nor ends the scan"
        );
        let first = page(&mut scan, &conn);
        assert_eq!(first.threads, vec!["t0300".to_owned()]);
        assert!(!first.done, "a page with candidates is not the end");
        scan.restart("t0300");
        assert!(page(&mut scan, &conn).done, "the empty page ends the scan");
    }

    #[test]
    fn candidates_found_by_different_sources_come_out_once_in_thread_id_order() {
        let conn = database();
        thread(&conn, "b", "working");
        thread(&conn, "c", "done");
        // One thread in all three sources, and one only in the queue.
        intent(&conn, "b", "pending");
        queue(&conn, "b");
        queue(&conn, "c");
        thread(&conn, "a", "done");
        intent(&conn, "a", "running");
        let pages = pages(&conn).unwrap();
        assert_eq!(
            pages,
            vec![vec!["a".to_owned(), "b".to_owned(), "c".to_owned()]]
        );
    }

    #[test]
    fn a_thread_an_earlier_recovery_made_a_candidate_is_recovered_in_the_same_pass() {
        let conn = database();
        thread(&conn, "a", "working");
        for index in 0..80 {
            thread(&conn, &format!("i{index:03}"), "done");
        }
        thread(&conn, "z", "done");
        let mut scan = Scan::new(String::new());
        let first = page(&mut scan, &conn);
        assert_eq!(first.threads, vec!["a".to_owned()]);
        // The recovery of `a` inserted a pending intent for a later thread.
        intent(&conn, "z", "pending");
        scan.restart("a");
        let second = page(&mut scan, &conn);
        assert_eq!(second.threads, vec!["z".to_owned()]);
        assert!(!second.done);
        scan.restart("z");
        assert!(page(&mut scan, &conn).done);
    }

    #[test]
    fn a_thread_a_recovery_makes_eligible_behind_an_advanced_cursor_is_recovered_in_the_next_page()
    {
        let conn = database();
        for index in 0..64 {
            thread(&conn, &format!("t{index:02}"), "working");
        }
        // Idle, and scanned past by every source while the first page is built.
        thread(&conn, "u", "done");
        let mut scan = Scan::new(String::new());
        let first = page(&mut scan, &conn);
        assert_eq!(first.threads.len(), 64);
        assert!(!first.threads.contains(&"u".to_owned()));
        // The probe's recovery of t00 inserts a pending intent for `u`, behind the cursors.
        intent(&conn, "u", "pending");
        scan.restart("t63");
        let second = page(&mut scan, &conn);
        assert_eq!(
            second.threads,
            vec!["u".to_owned()],
            "the re-query starts at t63, not at the cursors"
        );
    }

    #[test]
    fn pages_close_at_64_candidates_as_the_typescripts_do() {
        let conn = database();
        for index in 0..2000 {
            let status = if index < 130 { "working" } else { "done" };
            thread(&conn, &format!("t{index:04}"), status);
        }
        let mut scan = Scan::new(String::new());
        let mut sizes = Vec::new();
        loop {
            let step = page(&mut scan, &conn);
            if step.done {
                break;
            }
            let last = step.threads.last().cloned().unwrap_or_default();
            sizes.push(step.threads.len());
            scan.restart(last);
        }
        assert_eq!(sizes, vec![64, 64, 2]);
    }

    #[test]
    fn a_partial_last_page_whose_recovery_makes_a_later_thread_eligible_is_followed_by_another_page()
     {
        let conn = database();
        thread(&conn, "a", "working");
        thread(&conn, "b", "working");
        thread(&conn, "c", "working");
        thread(&conn, "z", "done");
        let mut scan = Scan::new(String::new());
        let first = page(&mut scan, &conn);
        assert_eq!(
            first.threads,
            vec!["a".to_owned(), "b".to_owned(), "c".to_owned()],
            "the page closes at exhaustion, not at an empty step"
        );
        assert!(!first.done);
        intent(&conn, "z", "pending");
        scan.restart("c");
        let second = page(&mut scan, &conn);
        assert_eq!(second.threads, vec!["z".to_owned()]);
        scan.restart("z");
        let third = page(&mut scan, &conn);
        assert!(third.done, "only the empty page ends the scan");
        assert!(third.threads.is_empty());
    }

    #[test]
    fn an_empty_thread_id_is_never_a_candidate() {
        let conn = database();
        thread(&conn, "", "working");
        queue(&conn, "");
        intent(&conn, "", "pending");
        assert!(pages(&conn).unwrap().is_empty());
    }
}

#[cfg(test)]
mod scan_tests {
    use super::*;
    use ace_store::OpenOptions;

    fn home() -> Arc<Connection> {
        let path = std::env::temp_dir().join(format!(
            "ace-engine-scan-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|since| since.as_nanos())
                .unwrap_or(0)
        ));
        let conn = Connection::open(
            path.to_str().unwrap_or_default(),
            OpenOptions {
                read_only: false,
                timeout_ms: 0,
            },
        )
        .unwrap();
        conn.exec(
            "CREATE TABLE threads (id TEXT PRIMARY KEY, status JSON NOT NULL); \
             CREATE TABLE thread_state (thread_id TEXT PRIMARY KEY, state JSON NOT NULL, seq INTEGER NOT NULL); \
             CREATE TABLE intents (id INTEGER PRIMARY KEY, thread_id TEXT, status TEXT, awaiting INTEGER, uncertain INTEGER); \
             CREATE TABLE engine_queue (thread_id TEXT PRIMARY KEY, continuation TEXT, trigger TEXT, limited INTEGER, paused INTEGER);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn one_step_scans_at_most_a_page_of_rows_however_sparse_the_matches_are() {
        // 256 finished threads before the first candidate: one step may scan only those 256, so
        // it finds no candidate and the page does not close. Scanning the whole table in one
        // step would find all 64 and close the page immediately.
        let conn = home();
        for index in 0..256 {
            let id = format!("done-{index:04}");
            stmt_cache::run(
                &conn,
                "INSERT INTO threads VALUES (?, ?)",
                vec![
                    Value::Text(id.clone()),
                    Value::Text(r#"{"state":"done"}"#.to_owned()),
                ],
            )
            .unwrap();
            stmt_cache::run(
                &conn,
                "INSERT INTO thread_state VALUES (?, ?, 0)",
                vec![
                    Value::Text(id),
                    Value::Text(r#"{"engineSnapshot":9}"#.to_owned()),
                ],
            )
            .unwrap();
        }
        for index in 0..64 {
            let id = format!("live-{index:04}");
            stmt_cache::run(
                &conn,
                "INSERT INTO threads VALUES (?, ?)",
                vec![
                    Value::Text(id.clone()),
                    Value::Text(r#"{"state":"working"}"#.to_owned()),
                ],
            )
            .unwrap();
            stmt_cache::run(
                &conn,
                "INSERT INTO thread_state VALUES (?, ?, 0)",
                vec![
                    Value::Text(id),
                    Value::Text(r#"{"engineSnapshot":9}"#.to_owned()),
                ],
            )
            .unwrap();
        }
        let mut scan = Scan::new(String::new());
        assert!(
            scan.step(&conn).unwrap().is_none(),
            "the first step scanned only the first 256 rows"
        );
        let page = scan
            .step(&conn)
            .unwrap()
            .expect("the second step closes the page");
        assert_eq!(page.threads.len(), 64);
    }
}

// SPDX-License-Identifier: Apache-2.0

//! The crash ledger across reader deaths: what is struck, what is read alone, what is refused.

#![cfg(feature = "test-hooks")]
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod support;

use serde_json::{Value, json};
use support::*;

const DAY: f64 = 86_400_000.0;
const FAILED: &str = "This saved conversation stopped the history reader several times and is no longer read. Open it in its original app.";

/// One scanned Claude session, and readers started on it a day apart: far past the ledger's
/// wait after each strike.
struct Scenario {
    root: tempfile::TempDir,
    opts: Value,
    source: String,
    day: i32,
}

impl Scenario {
    fn new() -> Scenario {
        let root = tempfile::tempdir().unwrap();
        let home = claude_home(root.path(), &session("import me"));
        let opts = options(root.path(), vec![home]);
        let mut reader = Reader::start(opts.clone());
        reader.next();
        reader.call(1, json!({ "op": "scan" }));
        let source = Scenario::listed(&mut reader);
        Scenario {
            root,
            opts,
            source,
            day: 0,
        }
    }

    fn listed(reader: &mut Reader) -> String {
        let listed = reader.call(
            2,
            json!({ "op": "list", "request": { "type": "history.list", "cwd": "/w" } }),
        );
        listed.value["value"]["sessions"][0]["id"]
            .as_str()
            .unwrap_or_default()
            .to_owned()
    }

    fn import(&self, n: i64) -> Value {
        json!({ "op": "import.persist", "init": {
            "sourceId": self.source, "threadId": format!("t{n}"), "agentId": format!("a{n}"),
            "workspaceId": "w", "at": 1,
        } })
    }

    /// A reader started after one that ended with `last_exit` (as the daemon passes it), its
    /// clock a day on, with `hooks`.
    fn restart(&mut self, last_exit: Option<&str>, hooks: Value) -> Reader {
        self.day += 1;
        let mut opts = self.opts.clone();
        if let Some(exit) = last_exit {
            opts["lastExit"] = json!(exit);
        }
        let mut hooks = hooks;
        hooks["clockShiftMs"] = json!(DAY * f64::from(self.day));
        let mut reader = Reader::start_with(opts, &hooks);
        reader.next();
        reader
    }

    /// The reader dies while importing, as `crash` hooks make it.
    fn die_importing(&mut self, last_exit: Option<&str>, n: i64) {
        let mut dying = self.restart(last_exit, json!({ "crash": { "at": "import-member" } }));
        dying.send(&json!({ "id": 3, "request": self.import(n) }));
        assert!(!dying.child.wait().unwrap().success());
    }

    /// A start that only applies the last exit to the ledger, then ends cleanly enough.
    fn settle(&mut self, last_exit: &str) {
        drop(self.restart(Some(last_exit), json!({})));
    }
}

#[cfg(feature = "test-hooks")]
#[test]
fn a_transcript_that_kills_the_reader_while_importing_is_refused_after_the_third_time() {
    let mut s = Scenario::new();
    s.die_importing(None, 0);
    for n in 1..3 {
        s.settle("crash");
        s.die_importing(Some("crash"), n);
    }
    s.settle("crash");
    let mut reader = s.restart(Some("crash"), json!({}));
    assert_eq!(reader.call(4, s.import(9)).value["error"], FAILED);
}

#[cfg(feature = "test-hooks")]
#[test]
fn a_transcript_that_goes_over_the_memory_limit_on_every_import_is_refused_in_the_end() {
    // After a memory-limit kill only a source read alone is struck: the first kill makes the
    // transcript a suspect, and each retry, read alone, is struck until it is refused.
    let mut s = Scenario::new();
    s.die_importing(None, 0);
    // The suspect, then three strikes.
    for n in 1..4 {
        s.settle("memory-limit");
        s.die_importing(Some("memory-limit"), n);
    }
    s.settle("memory-limit");
    let mut reader = s.restart(Some("memory-limit"), json!({}));
    assert_eq!(reader.call(4, s.import(9)).value["error"], FAILED);
}

#[cfg(feature = "test-hooks")]
#[test]
fn a_refused_transcript_that_is_replaced_is_read_and_imported_again() {
    let mut s = Scenario::new();
    s.die_importing(None, 0);
    for n in 1..3 {
        s.settle("crash");
        s.die_importing(Some("crash"), n);
    }
    s.settle("crash");
    // The provider rewrites the transcript: its strikes were for other content.
    let path = s
        .root
        .path()
        .join("claude/projects/p/11111111-1111-4111-8111-111111111111.jsonl");
    std::fs::write(&path, session("a fresh start")).unwrap();
    let mut reader = s.restart(Some("crash"), json!({}));
    let scan = reader.call(5, json!({ "op": "scan" }));
    assert_eq!(
        scan.value["value"]["unsupported"],
        json!([]),
        "{}",
        scan.value
    );
    s.source = Scenario::listed(&mut reader);
    let imported = reader.call(6, s.import(10));
    assert!(imported.value.get("error").is_none(), "{}", imported.value);
}

#[test]
fn an_import_that_ends_clears_its_crash_mark() {
    let root = tempfile::tempdir().unwrap();
    let home = claude_home(root.path(), &session("import me"));
    let opts = options(root.path(), vec![home]);
    let mut reader = Reader::start(opts.clone());
    reader.next();
    reader.call(1, json!({ "op": "scan" }));
    let listed = reader.call(
        2,
        json!({ "op": "list", "request": { "type": "history.list", "cwd": "/w" } }),
    );
    let source = listed.value["value"]["sessions"][0]["id"].clone();
    let done = reader.call(
        3,
        json!({ "op": "import.persist", "init": {
            "sourceId": source, "threadId": "t", "agentId": "a", "workspaceId": "w", "at": 1,
        } }),
    );
    assert!(done.value.get("error").is_none(), "{}", done.value);
    drop(reader);
    let db = rusqlite::Connection::open(root.path().join("ace/index.sqlite")).unwrap();
    let marks: i64 = db
        .query_row("SELECT count(*) FROM scan_crashes", [], |r| r.get(0))
        .unwrap();
    assert_eq!(marks, 0);
}

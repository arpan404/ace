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
    /// Every session listed, roots of their trees.
    sources: Vec<String>,
    day: i32,
    /// Where the dying readers die.
    crash: Value,
}

impl Scenario {
    fn new() -> Scenario {
        let root = tempfile::tempdir().unwrap();
        let home = claude_home(root.path(), &session("import me"));
        Scenario::with(root, vec![home])
    }

    fn with(root: tempfile::TempDir, homes: Vec<Value>) -> Scenario {
        let opts = options(root.path(), homes);
        let mut reader = Reader::start(opts.clone());
        reader.next();
        reader.call(1, json!({ "op": "scan" }));
        let sources = Scenario::listed(&mut reader);
        Scenario {
            root,
            opts,
            source: sources.first().cloned().unwrap_or_default(),
            sources,
            day: 0,
            crash: json!({ "at": "import-member" }),
        }
    }

    fn listed(reader: &mut Reader) -> Vec<String> {
        let listed = reader.call(
            2,
            json!({ "op": "list", "request": { "type": "history.list", "cwd": "/w" } }),
        );
        listed.value["value"]["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["id"].as_str().unwrap_or_default().to_owned())
            .collect()
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
        let mut dying = self.restart(last_exit, json!({ "crash": self.crash.clone() }));
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
    s.source = Scenario::listed(&mut reader).remove(0);
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
    let db = rusqlite::Connection::open(root.path().join("ace/index-crashes.sqlite")).unwrap();
    let marks: i64 = db
        .query_row("SELECT count(*) FROM scan_crashes", [], |r| r.get(0))
        .unwrap();
    assert_eq!(marks, 0);
}

const ROOT: &str = "11111111-1111-4111-8111-111111111111";

/// A Claude session with a subagent transcript, and readers that die reading the subagent.
fn with_child(child: &str) -> Scenario {
    let root = tempfile::tempdir().unwrap();
    let home = claude_home(root.path(), &session("import me"));
    let dir = root
        .path()
        .join(format!("claude/projects/p/{ROOT}/subagents"));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("agent-1.jsonl"), child).unwrap();
    let mut s = Scenario::with(root, vec![home]);
    s.crash = json!({ "at": "import-member", "match": "subagents" });
    s
}

fn child(prompt: &str) -> String {
    format!(
        "{}\n",
        json!({ "type": "user", "sessionId": ROOT, "isSidechain": true, "cwd": "/w",
            "message": { "role": "user", "content": prompt } })
    )
}

#[test]
fn a_subagent_that_kills_the_reader_is_struck_itself_and_once_repaired_its_tree_imports_again() {
    let mut s = with_child(&child("look around"));
    s.die_importing(None, 0);
    for n in 1..3 {
        s.settle("crash");
        s.die_importing(Some("crash"), n);
    }
    s.settle("crash");
    let mut reader = s.restart(Some("crash"), json!({}));
    assert_eq!(reader.call(4, s.import(9)).value["error"], FAILED);
    // The subagent's transcript is rewritten: its strikes were for other content, and nothing
    // was ever wrong with the root.
    let path = s
        .root
        .path()
        .join(format!("claude/projects/p/{ROOT}/subagents/agent-1.jsonl"));
    std::fs::write(&path, child("a repaired subagent")).unwrap();
    reader.call(5, json!({ "op": "scan" }));
    let imported = reader.call(6, s.import(10));
    assert!(imported.value.get("error").is_none(), "{}", imported.value);
}

/// The source id of a Codex rollout in the scenario's home: `sha256(instance\0path\0native)`.
fn codex_source(s: &Scenario, dir: &str, native: &str) -> String {
    use sha2::Digest;
    let path = s
        .root
        .path()
        .join("codex")
        .join(dir)
        .join(format!("rollout-{native}.jsonl"));
    let mut hash = sha2::Sha256::new();
    hash.update(b"codex\0");
    hash.update(path.to_string_lossy().as_bytes());
    hash.update(b"\0");
    hash.update(native.as_bytes());
    hash.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// A Codex rollout line.
fn codex(record: Value) -> String {
    format!("{record}\n")
}

#[test]
fn a_subagent_reached_from_two_roots_keeps_one_count() {
    const PARENT: &str = "22222222-2222-4222-8222-222222222222";
    const CHILD: &str = "33333333-3333-4333-8333-333333333333";
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("codex");
    let meta = |id: &str, extra: Value| {
        let mut payload = json!({ "id": id, "cwd": "/w" });
        if let (Some(p), Some(e)) = (payload.as_object_mut(), extra.as_object()) {
            p.extend(e.clone());
        }
        codex(json!({ "type": "session_meta", "payload": payload }))
    };
    let said = codex(
        json!({ "type": "response_item", "payload": { "type": "message", "role": "user",
        "content": [{ "type": "input_text", "text": "hello" }] } }),
    );
    // The same session saved twice, live and archived: two roots of one subagent.
    for dir in ["sessions", "archived_sessions"] {
        std::fs::create_dir_all(home.join(dir)).unwrap();
        std::fs::write(
            home.join(dir).join(format!("rollout-{PARENT}.jsonl")),
            meta(PARENT, json!({})) + &said,
        )
        .unwrap();
    }
    std::fs::write(
        home.join("sessions").join(format!("rollout-{CHILD}.jsonl")),
        meta(CHILD, json!({ "parent_thread_id": PARENT })) + &said,
    )
    .unwrap();
    let homes = vec![json!({ "id": "codex", "provider": "codex", "homeDir": home })];
    let mut s = Scenario::with(root, homes);
    // Lists show one of two copies of a session; both are roots of the subagent all the same.
    s.sources = ["sessions", "archived_sessions"]
        .map(|dir| codex_source(&s, dir, PARENT))
        .to_vec();
    s.source = s.sources[0].clone();
    s.crash = json!({ "at": "import-member", "match": CHILD });
    // Strikes through the first root...
    s.die_importing(None, 0);
    for n in 1..3 {
        s.settle("crash");
        s.die_importing(Some("crash"), n);
    }
    s.settle("crash");
    // ...count for the subagent wherever it is reached from.
    s.source = s.sources[1].clone();
    let mut reader = s.restart(Some("crash"), json!({}));
    assert_eq!(reader.call(4, s.import(9)).value["error"], FAILED);
}

// SPDX-License-Identifier: Apache-2.0

//! ace-history driven as the daemon drives it: framed messages on its stdin and stdout.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod support;

use serde_json::json;
use support::*;

#[test]
fn a_scanned_claude_session_is_listed_under_its_first_prompt() {
    let root = tempfile::tempdir().unwrap();
    let home = claude_home(
        root.path(),
        &session("<system-reminder>hidden</system-reminder>Fix the retries"),
    );
    let mut reader = Reader::start(options(root.path(), vec![home]));
    assert_eq!(reader.next().value, json!({ "id": 0, "value": "ready" }));
    let scan = reader.call(1, json!({ "op": "scan" }));
    assert_eq!(scan.value["value"]["files"], 1);
    assert_eq!(scan.value["value"]["reads"], 1);
    let list = reader.call(
        2,
        json!({ "op": "list", "request": { "type": "history.list", "cwd": "/w", "limit": 50 } }),
    );
    let sessions = list.value["value"]["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["title"], "Fix the retries");
    // Unchanged, the next scan reads nothing.
    let warm = reader.call(3, json!({ "op": "scan" }));
    assert_eq!(
        (
            warm.value["value"]["reads"].clone(),
            warm.value["value"]["skipped"].clone()
        ),
        (json!(0), json!(1))
    );
}

#[test]
fn an_index_of_another_format_is_refused_and_left_as_it_was() {
    let root = tempfile::tempdir().unwrap();
    let index = root.path().join("ace/index.sqlite");
    {
        let mut reader = Reader::start(options(root.path(), vec![]));
        assert_eq!(reader.next().value["value"], "ready");
    }
    rusqlite::Connection::open(&index)
        .unwrap()
        .execute(
            "UPDATE catalog_settings SET value='4' WHERE key='format'",
            [],
        )
        .unwrap();
    let mut reader = Reader::start(options(root.path(), vec![]));
    let refused = reader.next().value;
    assert_eq!(refused["refused"]["code"], "incompatible-data");
    assert!(
        refused["refused"]["message"]
            .as_str()
            .unwrap()
            .contains("format 4")
    );
    let db = rusqlite::Connection::open(&index).unwrap();
    let format: String = db
        .query_row(
            "SELECT value FROM catalog_settings WHERE key='format'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(format, "4");
}

#[test]
fn a_record_over_the_decode_limit_imports_as_bounded_blob_chunks() {
    let root = tempfile::tempdir().unwrap();
    let big = line(
        json!({ "type": "assistant", "message": { "role": "assistant", "content": "x".repeat(3 * 1024 * 1024) } }),
    );
    let home = claude_home(root.path(), &format!("{}{big}", session("question")));
    let mut reader = Reader::start(options(root.path(), vec![home]));
    reader.next();
    reader.call(1, json!({ "op": "scan" }));
    let list = reader.call(
        2,
        json!({ "op": "list", "request": { "type": "history.list", "cwd": "/w", "limit": 50 } }),
    );
    let source = list.value["value"]["sessions"][0]["id"].clone();
    let init =
        json!({ "sourceId": source, "threadId": "t", "workspaceId": "w", "agentId": "a", "at": 1 });
    let mut message = reader.call(3, json!({ "op": "import", "init": init }));
    let (mut chunks, mut bytes, mut opaque) = (0, 0, 0);
    let mut id = 4;
    loop {
        let reply = &message.value["value"];
        for packet in reply["values"].as_array().unwrap() {
            if packet["type"] == "blob.chunk" {
                let body = &message.bodies[packet["bytes"]["$body"].as_u64().unwrap() as usize];
                assert!(body.len() <= 64 * 1024);
                chunks += 1;
                bytes += body.len();
            }
            if packet["type"] == "item" && packet["item"]["code"] == "history.raw-only" {
                opaque += 1;
            }
        }
        if reply["done"] == true {
            break;
        }
        message = reader.call(id, json!({ "op": "next" }));
        id += 1;
    }
    assert_eq!(bytes, big.len() - 1);
    assert!(chunks >= 48);
    assert_eq!(opaque, 1);
}

#[test]
fn a_second_operation_while_one_runs_is_refused_not_queued() {
    let root = tempfile::tempdir().unwrap();
    let home = claude_home(root.path(), &session("q"));
    let mut reader = Reader::start(options(root.path(), vec![home]));
    reader.next();
    reader.send(&json!({ "id": 1, "request": { "op": "scan" } }));
    reader.send(&json!({ "id": 2, "request": { "op": "scan" } }));
    let mut answers = Vec::new();
    while answers.len() < 2 {
        let message = reader.next().value;
        if message.get("id").is_some() {
            answers.push(message);
        }
    }
    let refused = answers.iter().find(|a| a["id"] == 2).unwrap();
    assert_eq!(refused["error"], "History operation already in progress");
}

#[cfg(feature = "test-hooks")]
#[test]
fn a_request_sent_the_moment_the_last_reply_arrives_is_never_refused_as_in_progress() {
    let root = tempfile::tempdir().unwrap();
    let home = claude_home(root.path(), &session("q"));
    // The reader lingers after each reply, as a loaded machine can make it.
    let hooks = json!({ "delay": { "at": "reply-sent", "ms": 30 } });
    let mut reader = Reader::start_with(options(root.path(), vec![home]), &hooks);
    reader.next();
    for id in 1..=10 {
        let reply = reader.call(id, json!({ "op": "archive.thread", "id": "missing" }));
        assert!(
            reply.value.get("error").is_none(),
            "request {id} was refused: {}",
            reply.value
        );
    }
}

#[cfg(feature = "test-hooks")]
#[test]
fn a_reader_that_dies_while_creating_a_fresh_index_leaves_one_the_next_start_opens() {
    let root = tempfile::tempdir().unwrap();
    let home = claude_home(root.path(), &session("q"));
    let opts = options(root.path(), vec![home]);
    let hooks = json!({ "crash": { "at": "index-schema" } });
    let mut dying = Reader::start_with(opts.clone(), &hooks);
    let status = dying.child.wait().unwrap();
    assert!(!status.success());
    drop(dying);
    let mut reader = Reader::start(opts);
    let ready = reader.next().value;
    assert_eq!(ready, json!({ "id": 0, "value": "ready" }));
}

#[cfg(feature = "test-hooks")]
#[test]
fn a_transcript_replaced_after_it_was_opened_streams_its_raw_bytes_from_the_file_it_decoded() {
    let root = tempfile::tempdir().unwrap();
    // A first record over the inline limit, so its raw bytes travel as a blob.
    let big = format!(
        "{}\n",
        json!({ "type": "user", "sessionId": "11111111-1111-4111-8111-111111111111", "cwd": "/w",
            "message": { "role": "user", "content": format!("original {}", "o".repeat(80 * 1024)) } })
    );
    let home = claude_home(root.path(), &big);
    let path = root
        .path()
        .join("claude/projects/p/11111111-1111-4111-8111-111111111111.jsonl");
    let pause = root.path().join("pause");
    std::fs::create_dir(&pause).unwrap();
    let hooks = json!({ "pause": { "at": "records-opened", "dir": pause } });
    let mut reader = Reader::start_with(options(root.path(), vec![home]), &hooks);
    reader.next();
    reader.call(1, json!({ "op": "scan" }));
    let listed = reader.call(
        2,
        json!({ "op": "list", "request": { "type": "history.list", "cwd": "/w" } }),
    );
    let source = listed.value["value"]["sessions"][0]["id"].clone();
    let init =
        json!({ "sourceId": source, "threadId": "t", "agentId": "a", "workspaceId": "w", "at": 1 });
    reader.call(3, json!({ "op": "import", "init": init }));
    reader.send(&json!({ "id": 4, "request": { "op": "next" } }));
    while !pause.join("paused").exists() {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    // Renamed away and replaced by other content of the same size, after the reader opened it.
    std::fs::rename(&path, root.path().join("moved.jsonl")).unwrap();
    std::fs::write(&path, big.replace("original", "REPLACED")).unwrap();
    std::fs::write(pause.join("continue"), "").unwrap();
    let mut bodies = Vec::new();
    let mut id = 4;
    loop {
        let message = reader.next();
        if message.value.get("id") != Some(&json!(id)) {
            continue;
        }
        bodies.extend(message.bodies);
        if message.value.get("error").is_some() || message.value["value"]["done"] == json!(true) {
            break;
        }
        id += 1;
        reader.send(&json!({ "id": id, "request": { "op": "next" } }));
    }
    let raw: Vec<u8> = bodies.concat();
    let raw = String::from_utf8_lossy(&raw);
    assert!(
        raw.contains("original"),
        "the raw blob came from another file"
    );
    assert!(
        !raw.contains("REPLACED"),
        "the raw blob came from the replacement"
    );
}

#[cfg(all(feature = "test-hooks", unix))]
/// An OpenCode v1 database with one session, `title`: in WAL mode with its writer closed, the kind
/// that used to be read in place.
fn opencode_db(path: &std::path::Path, title: &str) {
    let db = rusqlite::Connection::open(path).unwrap();
    db.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,title TEXT,time_updated INTEGER,parent_id TEXT);
         CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT);
         CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,data TEXT);",
    )
    .unwrap();
    db.execute("INSERT INTO session VALUES('s1','/w',?1,1,NULL)", [title])
        .unwrap();
    db.execute_batch(
        r#"INSERT INTO message VALUES('m1','s1',1,'{"role":"user"}');
           INSERT INTO part VALUES('p1','m1','{"type":"text","text":"hello"}');"#,
    )
    .unwrap();
}

#[cfg(all(feature = "test-hooks", unix))]
#[test]
fn a_database_redirected_outside_its_home_after_its_check_is_never_read() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("opencode");
    std::fs::create_dir(&home).unwrap();
    let path = home.join("opencode.db");
    opencode_db(&path, "checked");
    let other = root.path().join("other.db");
    opencode_db(&other, "swapped in");
    let pause = root.path().join("pause");
    std::fs::create_dir(&pause).unwrap();
    let hooks = json!({ "pause": { "at": "snapshot-source-opened", "dir": pause } });
    let opts = options(
        root.path(),
        vec![json!({ "id": "oc", "provider": "opencode", "homeDir": home })],
    );
    let mut reader = Reader::start_with(opts, &hooks);
    reader.next();
    reader.send(&json!({ "id": 1, "request": { "op": "scan" } }));
    while !pause.join("paused").exists() {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    // After the reader checked and opened it, the path becomes a link to a database outside the
    // home.
    std::fs::rename(&path, home.join("moved.db.bak")).unwrap();
    std::os::unix::fs::symlink(&other, &path).unwrap();
    std::fs::write(pause.join("continue"), "").unwrap();
    loop {
        if reader.next().value.get("id") == Some(&json!(1)) {
            break;
        }
    }
    let listed = reader.call(
        2,
        json!({ "op": "list", "request": { "type": "history.list", "cwd": "/w" } }),
    );
    assert!(!path.with_extension("db-wal").exists());
    let titles: Vec<serde_json::Value> = listed.value["value"]["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["title"].clone())
        .collect();
    // The checked file's rows, or none at all: never the file outside the home.
    assert!(!titles.contains(&json!("swapped in")), "{titles:?}");
}

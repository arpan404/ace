// SPDX-License-Identifier: Apache-2.0
//! `history.rs`'s cases, named by the TypeScript file each came from.

use super::*;

use crate::repository::testsupport::{Shell, header, home};

/// One message revision in the history index.
fn history(conn: &Arc<Connection>, id: &str, seq: i64, ordinal: i64, value: &str) {
    conn.exec(&format!(
        "INSERT INTO history_items VALUES ('{id}', 't', {seq}, {ordinal});
             INSERT INTO history_item_revisions VALUES ('{id}', {seq}, {});",
        crate::repository::testsupport::sql_text(value)
    ))
    .expect("history");
}

#[test]
fn a_historical_page_reads_as_of_a_sequence_oldest_first() {
    let conn = home("t", &header("t"));
    for (id, seq, ordinal) in [("m1", 10, 1), ("m2", 20, 2), ("m3", 30, 3)] {
        let item = format!(
            r#"{{"id":"{id}","agentId":"root","type":"message","role":"assistant","complete":true,"createdAt":1,"parts":[{{"type":"text","text":"{id}"}}]}}"#
        );
        history(&conn, id, seq, ordinal, &item);
    }
    assert_eq!(item_count(&conn, "t", 20).expect("count"), 2);
    let page = page(&conn, "t", 20, 21, 10, 1024 * 1024).expect("page");
    assert_eq!(
        page.items.iter().map(|item| item.id()).collect::<Vec<_>>(),
        ["m1", "m2"]
    );
    assert_eq!(page.item_seqs.get("m2"), Some(&20));
    // The completed revision is the first complete one at or before any later sequence.
    let (through, item) = completion(&conn, "t", "m2").expect("completion");
    assert_eq!(through, 20);
    assert_eq!(item.id(), "m2");
}

#[test]
fn a_preview_fills_text_from_the_frozen_stream_and_a_page_keeps_its_byte_budget() {
    let conn = home("t", &header("t"));
    let item = r#"{"id":"m","agentId":"root","type":"message","role":"assistant","complete":true,"createdAt":1,"parts":[{"type":"text","text":"","source":{"streamId":"s","bytes":0,"encoding":"utf-16le"}}]}"#;
    history(&conn, "m", 10, 1, item);
    let text: Vec<u16> = "hello".encode_utf16().collect();
    let bytes: Vec<u8> = text.iter().flat_map(|unit| unit.to_le_bytes()).collect();
    let blob = format!(
        "X'{}'",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    conn.exec(&format!(
        "INSERT INTO item_text_streams VALUES ('s', 't', 'm', 0, {});
             INSERT INTO item_source_chunks VALUES ('s', 0, {blob});
             INSERT INTO history_stream_versions VALUES ('s', 't', 'm', 10, {}, 'utf-16le');",
        bytes.len(),
        bytes.len()
    ))
    .expect("stream");
    let read = page(&conn, "t", 10, 11, 1, 4096).expect("page");
    let Item::Message { parts, .. } = &read.items[0] else {
        panic!("a message")
    };
    let ContentPart::Text { text, source, .. } = &parts[0] else {
        panic!("text")
    };
    assert_eq!(text.as_str(), "hello");
    assert_eq!(source.as_ref().map(|source| source.bytes), Some(10));
    // A page with no room for the item refuses to start; the bounded page shows it cut.
    assert!(page(&conn, "t", 10, 11, 1, 512).is_err());
    // With no room even for the clipped item, the bounded page omits it rather than failing.
    let bounded = bounded_page(&conn, "t", 10, 11, 1, 700).expect("a bounded page");
    assert!(bounded.items.is_empty());
    let bounded = bounded_page(&conn, "t", 10, 11, 1, 4096).expect("a page that fits");
    assert_eq!(bounded.items.len(), 1);
}

#[test]
fn a_handoff_leaves_out_pending_input_and_counts_only_what_it_carries() {
    let conn = home("t", &header("t"));
    let store = Shell::store(&conn);
    for (id, seq, ordinal) in [("m1", 10, 1), ("m2", 20, 2), ("m3", 30, 3)] {
        let item = format!(
            r#"{{"id":"{id}","agentId":"root","type":"message","role":"user","complete":true,"createdAt":{seq},"origin":{{"kind":"person"}},"parts":[{{"type":"text","text":"{id} words"}}]}}"#
        );
        history(&conn, id, seq, ordinal, &item);
    }
    let mut state = State::default();
    let carried = handoff(
        &store,
        &mut state,
        "t",
        30,
        4096,
        "codex",
        HandoffOptions {
            since: None,
            exclude: &["m3".to_owned()],
        },
    )
    .expect("handoff");
    assert_eq!(
        carried
            .excerpts
            .iter()
            .map(|excerpt| excerpt.item_id.as_str())
            .collect::<Vec<_>>(),
        ["m1", "m2"]
    );
    assert_eq!(carried.omitted_items, 0);
    // A returning session carries only what happened after its cutoff.
    let resumed = handoff(
        &store,
        &mut state,
        "t",
        30,
        4096,
        "codex",
        HandoffOptions {
            since: Some(20),
            exclude: &[],
        },
    )
    .expect("handoff");
    assert_eq!(
        resumed
            .excerpts
            .iter()
            .map(|excerpt| excerpt.item_id.as_str())
            .collect::<Vec<_>>(),
        ["m3"]
    );
    assert_eq!(resumed.since, Some(20));
}

#[test]
fn a_finished_turn_names_the_run_its_agent_and_its_native_point() {
    let mut head = header("t");
    head = head.replace(
        "\"initialRoot\":{\"agent\":\"root\"",
        "\"rootKey\":\"root\",\"initialRoot\":{\"agent\":\"root\"",
    );
    head = head.replace(
            "\"agents\":{}",
            "\"agents\":{\"root\":{\"agent\":{\"id\":\"root\",\"threadId\":\"t\",\"origin\":\"root\",\"native\":{\"provider\":\"claude\"},\"fidelity\":\"full\",\"cwd\":\"/w\",\"status\":{\"state\":\"idle\"},\"createdAt\":1},\"activity\":\"idle\",\"lastSignalAt\":1,\"lastRun\":\"run-1\"}}",
        );
    let conn = home("t", &head);
    let store = Shell::store(&conn);
    conn.exec(&format!(
            "INSERT INTO view_entities VALUES ('t', 'runs', 'run-1', {})",
            crate::repository::testsupport::sql_text(
                r#"{"id":"run-1","threadId":"t","agentId":"root","trigger":"person","state":"done","startedAt":1,"endedAt":2,"nativeId":"native-turn"}"#
            )
        ))
        .expect("run");
    conn.exec("INSERT INTO events VALUES (42, 'e1', 't', 2, 'run.ended', '{\"runId\":\"run-1\"}')")
        .expect("event");
    let mut state = State::default();
    let point = boundary(
        &store,
        &mut state,
        "t",
        &ace_json::json!({ "type": "turn", "runId": "run-1" }),
    )
    .expect("boundary");
    assert_eq!(point.get("throughSeq").and_then(Value::as_f64), Some(42.0));
    assert_eq!(
        point.get("parentAgentId").and_then(Value::as_str),
        Some("root")
    );
    assert_eq!(
        point
            .get("native")
            .and_then(|native| native.get("nativeId"))
            .and_then(Value::as_str),
        Some("native-turn")
    );
    assert_eq!(
        point.get("atSessionEnd").and_then(Value::as_bool),
        Some(false)
    );
}

#[test]
fn a_fork_opens_on_the_sources_messages_as_copies() {
    let conn = home("t", &header("t"));
    let store = Shell::store(&conn);
    for (id, seq, ordinal) in [("m1", 10, 1), ("m2", 20, 2)] {
        let item = format!(
            r#"{{"id":"{id}","agentId":"root","type":"message","role":"user","complete":true,"createdAt":{seq},"origin":{{"kind":"person"}},"parts":[{{"type":"text","text":"{id} words"}}]}}"#
        );
        history(&conn, id, seq, ordinal, &item);
        conn.exec(&format!(
            "INSERT INTO items VALUES ('{id}', 't', {seq}, '{}')",
            item.replace('\'', "''")
        ))
        .expect("item");
        conn.exec(&format!(
                "INSERT INTO item_heads (id, thread_id, created_seq, size, item_type, text_prefix, agent_id) VALUES ('{id}', 't', {seq}, 10, 'message', 0, 'root')"
            ))
            .expect("head");
    }
    let facts = fork_history_facts(&store, "t", 20, "root").expect("facts");
    assert_eq!(facts.len(), 2);
    assert_eq!(
        facts[0].get("item").and_then(Value::as_str),
        Some("inherited:m1")
    );
    assert_eq!(
        facts[0]
            .get("draft")
            .and_then(|draft| draft.get("inherited"))
            .and_then(|inherited| inherited.get("threadId"))
            .and_then(Value::as_str),
        Some("t")
    );
    assert_eq!(
        facts[0].get("type").and_then(Value::as_str),
        Some("item.upsert")
    );
    // The copies point at the source item and time.
    assert_eq!(
        facts[1]
            .get("draft")
            .and_then(|draft| draft.get("inherited"))
            .and_then(|inherited| inherited.get("itemId"))
            .and_then(Value::as_str),
        Some("m2")
    );
}

#[test]
fn a_citation_must_belong_to_the_fork_and_not_be_the_sources_own() {
    let conn = home("t", &header("t"));
    let store = Shell::store(&conn);
    for (seq, (id, inherited)) in [("own", "null"), ("copied", r#"{"threadId":"src"}"#)]
        .into_iter()
        .enumerate()
    {
        conn.exec(&format!(
                "INSERT INTO items VALUES ('{id}', 't', {seq}, '{{\"id\":\"{id}\",\"agentId\":\"root\",\"type\":\"message\",\"role\":\"user\",\"complete\":true,\"createdAt\":1,\"parts\":[],\"inherited\":{inherited}}}')"
            ))
            .expect("item");
    }
    assert!(
        validate_citations(&store, "t", &["own".to_owned()]).is_ok(),
        "the fork's own item is citable"
    );
    assert_eq!(
        validate_citations(&store, "t", &["copied".to_owned()])
            .unwrap_err()
            .to_string(),
        "Citation is the source's own message"
    );
    assert_eq!(
        validate_citations(&store, "t", &["missing".to_owned()])
            .unwrap_err()
            .to_string(),
        "Citation does not belong to fork"
    );
}

#[test]
fn a_finished_item_names_its_completion_point_and_run() {
    let mut head = header("t");
    head = head.replace(
        "\"initialRoot\":{\"agent\":\"root\"",
        "\"rootKey\":\"root\",\"initialRoot\":{\"agent\":\"root\"",
    );
    head = head.replace(
        "\"agents\":{}",
        "\"agents\":{\"root\":{\"agent\":{\"id\":\"root\",\"threadId\":\"t\",\"origin\":\"root\",\"native\":{\"provider\":\"claude\"},\"fidelity\":\"full\",\"cwd\":\"/w\",\"status\":{\"state\":\"idle\"},\"createdAt\":1},\"activity\":\"idle\",\"lastSignalAt\":1}}",
    );
    let conn = home("t", &head);
    let store = Shell::store(&conn);
    conn.exec(&format!(
        "INSERT INTO view_entities VALUES ('t', 'runs', 'run-1', {})",
        crate::repository::testsupport::sql_text(
            r#"{"id":"run-1","threadId":"t","agentId":"root","trigger":"person","state":"done","startedAt":1,"endedAt":2}"#
        )
    ))
    .expect("run");
    let item = r#"{"id":"m1","agentId":"root","runId":"run-1","nativeId":"native-item","type":"message","role":"assistant","complete":true,"createdAt":1,"parts":[{"type":"text","text":"answer"}]}"#;
    history(&conn, "m1", 15, 1, item);
    let mut state = State::default();
    let point = boundary(
        &store,
        &mut state,
        "t",
        &ace_json::json!({ "type": "item", "itemId": "m1" }),
    )
    .expect("boundary");
    assert_eq!(point.get("throughSeq").and_then(Value::as_f64), Some(15.0));
    assert_eq!(
        point.get("parentAgentId").and_then(Value::as_str),
        Some("root")
    );
    assert_eq!(
        point
            .get("native")
            .and_then(|native| native.get("type"))
            .and_then(Value::as_str),
        Some("item")
    );
    // An unfinished run refuses the item point, as an active turn does.
    conn.exec(&format!(
        "INSERT INTO view_entities VALUES ('t', 'runs', 'run-2', {})",
        crate::repository::testsupport::sql_text(
            r#"{"id":"run-2","threadId":"t","agentId":"root","trigger":"person","state":"active","startedAt":1}"#
        )
    ))
    .expect("run");
    let running = r#"{"id":"m2","agentId":"root","runId":"run-2","type":"message","role":"assistant","complete":true,"createdAt":2,"parts":[{"type":"text","text":"partial"}]}"#;
    history(&conn, "m2", 16, 2, running);
    assert_eq!(
        boundary(
            &store,
            &mut state,
            "t",
            &ace_json::json!({ "type": "item", "itemId": "m2" }),
        )
        .unwrap_err()
        .to_string(),
        "Fork point belongs to an unfinished run"
    );
}

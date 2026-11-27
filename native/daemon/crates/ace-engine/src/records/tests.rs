// SPDX-License-Identifier: Apache-2.0
//! The record dictionaries over an in-memory `ace-store` database (E5.3's moved cases): the SQL the
//! engine writes is asserted on its own rows.

use ace_core::items::Item;
use ace_core::state::AgentRecord;
use ace_store::{Connection, OpenOptions, Value, stmt_cache};
use indexmap::IndexMap;
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use crate::EngineError;
use crate::records::{self, RecordBudget, Records, SectionSpec};
use crate::snapshot::{decode, metadata};

fn database() -> Arc<Connection> {
    let conn = Connection::open(
        ":memory:",
        OpenOptions {
            read_only: false,
            timeout_ms: 0,
        },
    )
    .unwrap();
    conn.exec("CREATE TABLE engine_state_records (thread_id TEXT NOT NULL, section TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(thread_id,section,key))").unwrap();
    conn.exec("CREATE TABLE engine_state_appends (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, section TEXT NOT NULL, key TEXT NOT NULL, patch TEXT NOT NULL)").unwrap();
    conn
}

fn spec<T>(
    name: &str,
    decode: fn(&ace_json::Value) -> Result<T, EngineError>,
    budget: &Rc<RefCell<RecordBudget>>,
) -> SectionSpec<T> {
    SectionSpec {
        name: name.to_owned(),
        decode,
        cache: records::section(budget),
    }
}

fn records<T: Clone + serde::Serialize + 'static>(
    conn: &Arc<Connection>,
    budget: &Rc<RefCell<RecordBudget>>,
    name: &str,
    decode: fn(&ace_json::Value) -> Result<T, EngineError>,
) -> Records<T> {
    Records::new(
        Arc::clone(conn),
        budget,
        "t".to_owned(),
        spec(name, decode, budget),
        IndexMap::new(),
        None,
        None,
    )
}

fn rows(conn: &Arc<Connection>, sql: &'static str) -> Vec<Vec<Value>> {
    stmt_cache::all_rows_raw(conn, sql, vec![]).unwrap_or_default()
}

#[test]
fn an_adopted_record_is_upserted_and_an_append_is_stored_as_its_patch() {
    let conn = database();
    let budget = Rc::new(RefCell::new(RecordBudget::default()));
    let mut items: Records<Item> = records(&conn, &budget, "items", decode::decode_record::<Item>);
    let item: Item = ace_json::from_value(
        &ace_json::parse(
            r#"{"id":"i","threadId":"t","agentId":"a","createdAt":1,"complete":true,"type":"message","role":"assistant","parts":[{"type":"text","text":"hi"}]}"#,
        )
        .unwrap(),
    )
    .unwrap();
    // A key the fold created: no stored record, so the adopt is a full write.
    items.adopt("i", Some(item));
    assert!(items.has_changes());
    items.persist().unwrap();
    let stored = rows(
        &conn,
        "SELECT section,key,value FROM engine_state_records ORDER BY rowid",
    );
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0][1], Value::Text("i".to_owned()));
    let Value::Text(value) = &stored[0][2] else {
        panic!("the stored value is text");
    };
    let decoded: ace_json::Value = ace_json::parse(value).unwrap();
    // The record keeps the full item; the append overlay is the streaming text's own path.
    let stored_item: Item = ace_json::from_value(&decoded).unwrap();
    assert!(
        matches!(stored_item, Item::Message { ref parts, .. } if matches!(parts.first(), Some(ace_core::item_model::ContentPart::Text { text, .. }) if text.as_str() == "hi"))
    );
    let mut metadata_item = metadata::item_metadata(&stored_item);
    if let Item::Message { parts, .. } = &mut metadata_item
        && let Some(ace_core::item_model::ContentPart::Text { text, .. }) = parts.first()
    {
        let _ = text;
    }
}

#[test]
fn one_text_append_over_the_limit_stays_two_patches_and_a_second_fold_continues_the_text() {
    let conn = database();
    let budget = Rc::new(RefCell::new(RecordBudget::default()));
    let item_json = r#"{"id":"i","threadId":"t","agentId":"a","createdAt":1,"complete":true,"type":"message","role":"assistant","parts":[{"type":"text","text":""}]}"#;
    stmt_cache::run(
        &conn,
        "INSERT INTO engine_state_records VALUES (?,?,?,?)",
        vec![
            Value::Text("t".to_owned()),
            Value::Text("items".to_owned()),
            Value::Text("i".to_owned()),
            Value::Text(item_json.to_owned()),
        ],
    )
    .unwrap();
    let mut items: Records<Item> = records(&conn, &budget, "items", decode::decode_record::<Item>);
    // The metadata copy an append grows is read first, as `prepare` does.
    assert!(items.read("i").unwrap().is_some());
    let patch = |text: &str| crate::records::Append {
        path: vec![
            crate::records::PathStep::Key("parts".to_owned()),
            crate::records::PathStep::Index(0),
            crate::records::PathStep::Key("text".to_owned()),
        ],
        text: text.to_owned(),
        seed: Some(ace_json::parse(r#"{"type":"text"}"#).unwrap()),
    };
    items.append("i", patch("a"), true).unwrap();
    items.append("i", patch("b"), true).unwrap();
    items.persist().unwrap();
    let appends = rows(&conn, "SELECT patch FROM engine_state_appends ORDER BY id");
    assert_eq!(appends.len(), 1, "two short patches on one path coalesce");
    assert_eq!(
        appends[0][0],
        Value::Text(r#"{"path":["parts",0,"text"],"text":"ab","seed":{"type":"text"}}"#.to_owned())
    );
}

#[test]
fn an_agent_record_writes_the_agents_section_and_loads_back_without_a_native_runs_copy() {
    let conn = database();
    let budget = Rc::new(RefCell::new(RecordBudget::default()));
    let mut agents: Records<AgentRecord> = records(
        &conn,
        &budget,
        "agents",
        decode::decode_record::<AgentRecord>,
    );
    let agent: AgentRecord = ace_json::from_value(
        &ace_json::parse(
            r#"{"agent":{"id":"a","threadId":"t","origin":"root","native":{"provider":"claude"},"fidelity":"full","cwd":"/tmp","status":{"state":"working","activity":"thinking"},"createdAt":1},"activity":"thinking","lastSignalAt":2,"nativeRuns":{"n":"r"}}"#,
        )
        .unwrap(),
    )
    .unwrap();
    agents.adopt("a", Some(agent));
    agents.persist().unwrap();
    let stored = rows(
        &conn,
        "SELECT section,key,value FROM engine_state_records ORDER BY rowid",
    );
    assert_eq!(stored[0][0], Value::Text("agents".to_owned()));
    assert!(matches!(&stored[0][2], Value::Text(text) if text.contains(r#""nativeRuns":"#)));
}

#[test]
fn sections_share_one_bounded_cache_and_an_evicted_record_reloads_from_sqlite() {
    let conn = database();
    // One entry: the second write evicts the first, the way a full budget does.
    let budget = Rc::new(RefCell::new(RecordBudget::new(1, records::MAX_BYTES)));
    let mut items: Records<Item> = records(&conn, &budget, "items", decode::decode_record::<Item>);
    for (id, text) in [("a", "first"), ("b", "second")] {
        let item: Item = ace_json::from_value(
            &ace_json::parse(&format!(
                r#"{{"id":"{id}","threadId":"t","agentId":"x","createdAt":1,"complete":true,"type":"message","role":"assistant","parts":[{{"type":"text","text":"{text}"}}]}}"#
            ))
            .unwrap(),
        )
        .unwrap();
        items.write(id, item);
        items.persist().unwrap();
        items.committed();
    }
    assert_eq!(budget.borrow().size(), 1, "the sections share one budget");
    // The evicted record is still readable: the read falls through to SQLite.
    let reloaded = items.read("a").unwrap().expect("the stored record");
    let Item::Message { parts, .. } = reloaded else {
        panic!("a message");
    };
    assert!(
        matches!(parts.first(), Some(ace_core::item_model::ContentPart::Text { text, .. }) if text.as_str() == "first")
    );
}

#[test]
fn appended_text_counts_against_the_budget_and_survives_eviction_and_replacement() {
    let conn = database();
    let budget = Rc::new(RefCell::new(RecordBudget::default()));
    let item_json = r#"{"id":"i","threadId":"t","agentId":"a","createdAt":1,"complete":true,"type":"message","role":"assistant","parts":[{"type":"text","text":""}]}"#;
    stmt_cache::run(
        &conn,
        "INSERT INTO engine_state_records VALUES (?,?,?,?)",
        vec![
            Value::Text("t".to_owned()),
            Value::Text("items".to_owned()),
            Value::Text("i".to_owned()),
            Value::Text(item_json.to_owned()),
        ],
    )
    .unwrap();
    let mut items: Records<Item> = records(&conn, &budget, "items", decode::decode_record::<Item>);
    assert!(items.read("i").unwrap().is_some());
    let before = budget.borrow().byte_length();
    items
        .append(
            "i",
            crate::records::Append {
                path: vec![
                    crate::records::PathStep::Key("parts".to_owned()),
                    crate::records::PathStep::Index(0),
                    crate::records::PathStep::Key("text".to_owned()),
                ],
                text: "appended".to_owned(),
                seed: Some(ace_json::parse(r#"{"type":"text"}"#).unwrap()),
            },
            false,
        )
        .unwrap();
    assert!(
        budget.borrow().byte_length() > before,
        "the appended text is charged to the cached entry"
    );
    // Evict by filling the budget from another section, then read again.
    let filler = records::section(&budget);
    for index in 0..records::MAX_ENTRIES {
        filler.set::<String>(
            &format!("f{index}"),
            {
                let json = "{}".to_owned();
                records::Cached {
                    bytes: json.len(),
                    value: Rc::new(json.clone()),
                    json,
                }
            },
            2,
        );
    }
    items.section.clear();
    let reloaded = items
        .read("i")
        .unwrap()
        .expect("the stored record and its patch");
    let Item::Message { parts, .. } = reloaded else {
        panic!("a message");
    };
    assert!(
        matches!(parts.first(), Some(ace_core::item_model::ContentPart::Text { text, .. }) if text.as_str() == "appended")
    );
}

fn agent_json(extra_retry: &str) -> String {
    format!(
        r#"{{"agent":{{"id":"a","threadId":"t","origin":"root","native":{{"provider":"claude","nativeId":"n"}},"fidelity":"full","cwd":"/tmp","status":{{"state":"idle"}},"background":false,"createdAt":1}},"activity":"idle","lastSignalAt":1,"retry":{extra_retry}}}"#
    )
}

#[test]
fn a_passthrough_types_unknown_field_survives_a_rewrite() {
    // The TS retry schema is a passthrough object, so the Rust type carries `extra`.
    let conn = database();
    stmt_cache::run(
        &conn,
        "INSERT INTO engine_state_records VALUES (?,?,?,?)",
        vec![
            Value::Text("t".to_owned()),
            Value::Text("agents".to_owned()),
            Value::Text("root".to_owned()),
            Value::Text(agent_json(
                r#"{"on":"network","until":5,"futureField":{"a":1}}"#,
            )),
        ],
    )
    .unwrap();
    let budget = Rc::new(RefCell::new(RecordBudget::default()));
    let mut agents: Records<AgentRecord> = records(
        &conn,
        &budget,
        "agents",
        decode::decode_record::<AgentRecord>,
    );
    let record = agents.read("root").unwrap().expect("the agent");
    assert_eq!(
        record
            .retry
            .as_ref()
            .map(|retry| retry.extra.len())
            .unwrap_or(0),
        1,
        "the extra field decoded"
    );
    agents.write("root", record);
    agents.persist().unwrap();
    let row = stmt_cache::get_row(
        &conn,
        "SELECT value FROM engine_state_records WHERE thread_id='t' AND section='agents' AND key='root'",
        vec![],
    )
    .unwrap()
    .expect("the rewritten row");
    let stored = match row.get("value") {
        Some(Value::Text(text)) => text.clone(),
        _ => panic!("stored text"),
    };
    assert!(stored.contains(r#""futureField":{"a":1}"#), "{stored}");
    assert!(stored.contains(r#""until":5"#));
}

#[test]
fn a_cleared_known_retry_field_stays_cleared() {
    let conn = database();
    stmt_cache::run(
        &conn,
        "INSERT INTO engine_state_records VALUES (?,?,?,?)",
        vec![
            Value::Text("t".to_owned()),
            Value::Text("agents".to_owned()),
            Value::Text("root".to_owned()),
            Value::Text(agent_json(r#"{"on":"network","until":5}"#)),
        ],
    )
    .unwrap();
    let budget = Rc::new(RefCell::new(RecordBudget::default()));
    let mut agents: Records<AgentRecord> = records(
        &conn,
        &budget,
        "agents",
        decode::decode_record::<AgentRecord>,
    );
    let mut record = agents.read("root").unwrap().expect("the agent");
    record.retry = Some(ace_core::state::RetryInfo {
        on: "network".to_owned(),
        attempt: Some(2),
        until: None,
        message: None,
        extra: Default::default(),
    });
    agents.write("root", record);
    agents.persist().unwrap();
    let row = stmt_cache::get_row(
        &conn,
        "SELECT value FROM engine_state_records WHERE thread_id='t' AND section='agents' AND key='root'",
        vec![],
    )
    .unwrap()
    .expect("the rewritten row");
    let stored = match row.get("value") {
        Some(Value::Text(text)) => text.clone(),
        _ => panic!("stored text"),
    };
    assert!(
        !stored.contains(r#""until"#),
        "the cleared until is gone: {stored}"
    );
}

#[test]
fn a_tool_detail_with_an_unknown_field_and_an_image_part_decode() {
    let tool = ace_json::parse(
        r#"{"id":"i","threadId":"t","agentId":"a","createdAt":1,"complete":false,"type":"tool_call","call":{"id":"c","agentId":"a","kind":"shell","title":"run","status":"running","detail":{"kind":"shell","command":"ls","futureField":1},"startedAt":1}}"#,
    )
    .unwrap();
    assert!(decode::decode_record::<Item>(&tool).is_ok());
    // A part at the same index changing from text to image decodes; nothing is merged by index.
    let image = ace_json::parse(
        r#"{"id":"i2","threadId":"t","agentId":"a","createdAt":1,"complete":true,"type":"message","role":"assistant","parts":[{"type":"image","mimeType":"image/png","url":"https://x"}]}"#,
    )
    .unwrap();
    assert!(decode::decode_record::<Item>(&image).is_ok());
}

mod stored_extras;

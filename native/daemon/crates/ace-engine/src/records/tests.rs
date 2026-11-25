// SPDX-License-Identifier: Apache-2.0
//! The record dictionaries over a temp `ace-store` database (E5.3's moved cases): the SQL the
//! engine writes is asserted on its own rows.

use ace_core::items::Item;
use ace_core::state::AgentRecord;
use ace_store::{Connection, OpenOptions, Value, stmt_cache};
use indexmap::IndexMap;
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use crate::records::{self, RecordBudget, Records, SectionSpec};
use crate::snapshot::{decode, metadata};
use crate::EngineError;

fn database() -> Arc<Connection> {
    let path = std::env::temp_dir().join(format!(
        "ace-engine-records-{}-{}.sqlite",
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
    let mut items: Records<Item> = records(
        &conn,
        &budget,
        "items",
        decode::decode_record::<Item>,
    );
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
    assert!(matches!(stored_item, Item::Message { ref parts, .. } if matches!(parts.first(), Some(ace_core::item_model::ContentPart::Text { text, .. }) if text.as_str() == "hi")));
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
    let appends = rows(
        &conn,
        "SELECT patch FROM engine_state_appends ORDER BY id",
    );
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

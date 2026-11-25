// SPDX-License-Identifier: Apache-2.0

use super::{database, records};
use crate::records::RecordBudget;
use crate::snapshot::decode;
use ace_core::items::Item;
use ace_store::{Value, stmt_cache};
use std::{cell::RefCell, rc::Rc};

#[test]
fn an_items_unknown_field_survives_an_in_place_write_and_a_reload() {
    let input = r#"{"id":"i","threadId":"t","agentId":"a","createdAt":1,"complete":false,"type":"message","role":"assistant","parts":[{"type":"text","text":"hi"}],"futureItem":{"a":1}}"#;
    let (reloaded, json) = rewrite_record("items", input, |item: &mut Item| {
        let Item::Message { base, .. } = item else {
            panic!("expected a message");
        };
        base.complete = true;
    });
    let Item::Message { base, .. } = reloaded else {
        panic!("expected a message");
    };
    assert!(base.complete);
    assert_eq!(
        base.extra.get("futureItem"),
        Some(&serde_json::json!({"a": 1}))
    );
    assert_eq!(json.matches(r#""id":"#).count(), 1, "{json}");
}

#[test]
fn a_tool_calls_unknown_field_survives_an_in_place_write_and_a_reload() {
    let input = r#"{"id":"tool","threadId":"t","agentId":"a","createdAt":1,"complete":false,"type":"tool_call","call":{"id":"c","agentId":"a","kind":"shell","title":"run","status":"running","detail":{"kind":"shell","command":"ls"},"startedAt":1,"raw":[],"futureCall":{"a":1}}}"#;
    let (reloaded, _) = rewrite_record("items", input, |item: &mut Item| {
        let Item::ToolCall { call, .. } = item else {
            panic!("expected a tool call");
        };
        call.status = "succeeded".to_owned();
    });
    let Item::ToolCall { call, .. } = reloaded else {
        panic!("expected a tool call");
    };
    assert_eq!(
        call.extra.get("futureCall"),
        Some(&serde_json::json!({"a": 1}))
    );
    assert_eq!(call.status, "succeeded");
}

/// Rewrite a known field and read the resulting SQLite row through a fresh dictionary.
fn rewrite_record<T>(section: &str, json: &str, change: impl FnOnce(&mut T)) -> (T, String)
where
    T: Clone + serde::Serialize + serde::de::DeserializeOwned + 'static,
{
    let conn = database();
    stmt_cache::run(
        &conn,
        "INSERT INTO engine_state_records VALUES (?,?,?,?)",
        vec![
            Value::Text("t".to_owned()),
            Value::Text(section.to_owned()),
            Value::Text("record".to_owned()),
            Value::Text(json.to_owned()),
        ],
    )
    .unwrap();
    let budget = Rc::new(RefCell::new(RecordBudget::default()));
    let mut writer = records(&conn, &budget, section, decode::decode_record::<T>);
    let mut value = writer.read("record").unwrap().expect("the original record");
    change(&mut value);
    writer.write("record", value);
    writer.persist().unwrap();

    let reload_budget = Rc::new(RefCell::new(RecordBudget::default()));
    let mut reader = records(&conn, &reload_budget, section, decode::decode_record::<T>);
    let value = reader.read("record").unwrap().expect("the stored record");
    let row = stmt_cache::get_row(
        &conn,
        "SELECT value FROM engine_state_records WHERE thread_id='t' AND section=? AND key='record'",
        vec![Value::Text(section.to_owned())],
    )
    .unwrap()
    .expect("the rewritten row");
    let Some(Value::Text(json)) = row.get("value") else {
        panic!("expected stored JSON");
    };
    (value, json.clone())
}

#[test]
fn an_agent_records_unknown_top_level_field_survives_a_rewrite() {
    let input = r#"{"agent":{"id":"a","threadId":"t","origin":"root","native":{"provider":"claude","nativeId":"n"},"fidelity":"full","cwd":"/tmp","status":{"state":"idle"},"createdAt":1},"activity":"thinking","lastSignalAt":1,"futureAgentRecord":{"a":1}}"#;
    let (record, json) = rewrite_record(
        "agents",
        input,
        |record: &mut ace_core::state::AgentRecord| {
            record.last_signal_at = 2;
        },
    );
    assert_eq!(record.last_signal_at, 2);
    assert!(json.contains(r#""futureAgentRecord":{"a":1}"#), "{json}");
}

#[test]
fn interaction_extras_survive_rewrites_of_live_and_historical_rows() {
    let input = r#"{"id":"i","threadId":"t","agentId":"a","blocking":true,"request":{"kind":"question","questions":[]},"state":"pending","createdAt":1,"futureInteraction":[1,null]}"#;
    for section in ["interactions", "interactionHistory"] {
        let (interaction, json) = rewrite_record(
            section,
            input,
            |record: &mut ace_core::entity_model::Interaction| {
                record.state = "cancelled".to_owned();
                record.closed_at = Some(2);
            },
        );
        assert_eq!(interaction.closed_at, Some(2));
        assert!(
            json.contains(r#""futureInteraction":[1,null]"#),
            "{section}: {json}"
        );
    }
}

#[test]
fn task_extras_survive_rewrites_of_live_and_historical_rows() {
    let input = r#"{"id":"b","agentId":"a","kind":"shell","title":"worker","status":"running","ambient":false,"stoppable":true,"startedAt":1,"futureTask":"keep"}"#;
    for section in ["tasks", "taskHistory"] {
        let (task, json) = rewrite_record(
            section,
            input,
            |record: &mut ace_core::entity_model::BackgroundTask| {
                record.status = "completed".to_owned();
                record.ended_at = Some(2);
            },
        );
        assert_eq!(task.ended_at, Some(2));
        assert!(json.contains(r#""futureTask":"keep""#), "{section}: {json}");
    }
}

#[test]
fn an_artifacts_unknown_field_survives_a_rewrite_without_an_agent() {
    let input = r#"{"id":"i","createdAt":1,"complete":false,"type":"artifact","source":"browser","path":"/tmp/item","mimeType":"text/plain","bytes":4,"futureArtifact":{"a":1}}"#;
    let (artifact, json) = rewrite_record("items", input, |item: &mut Item| {
        let Item::Artifact { base, .. } = item else {
            panic!("expected an artifact");
        };
        base.complete = true;
    });
    assert!(artifact.complete());
    assert!(json.contains(r#""futureArtifact":{"a":1}"#), "{json}");
    assert!(!json.contains(r#""agentId""#), "{json}");
}

#[test]
fn a_started_delegation_writes_known_and_unknown_fields_once() {
    let input = r#"{"id":"i","agentId":"a","createdAt":1,"type":"delegation.started","origin":"ace","childThreadId":"child","provider":"claude","title":"Child","role":"worker","phase":"created","status":{"state":"new"},"updatedAt":1,"generation":0,"outcome":null,"futureDelegation":{"a":1}}"#;
    let (item, json) = rewrite_record("items", input, |item: &mut Item| {
        let Item::DelegationStarted { delegation, .. } = item else {
            panic!("expected a started delegation");
        };
        delegation.phase = "running".to_owned();
    });
    for key in [
        r#""id":"#,
        r#""type":"#,
        r#""origin":"#,
        r#""phase":"#,
        r#""status":"#,
        r#""futureDelegation":"#,
    ] {
        assert_eq!(json.matches(key).count(), 1, "{key}: {json}");
    }
    let Item::DelegationStarted { delegation, .. } = item else {
        panic!("expected a started delegation");
    };
    assert_eq!(delegation.phase, "running");
    assert!(json.contains(r#""futureDelegation":{"a":1}"#), "{json}");
}

#[test]
fn a_settled_delegation_writes_known_and_unknown_fields_once() {
    let input = r#"{"id":"i","agentId":"a","createdAt":1,"type":"delegation.settled","origin":"ace","results":[{"threadId":"child","outcome":"completed","result":"done","truncated":false,"before":null}],"delivery":"tool","futureDelegation":null}"#;
    let (item, json) = rewrite_record("items", input, |item: &mut Item| {
        let Item::DelegationSettled { delegation, .. } = item else {
            panic!("expected a settled delegation");
        };
        delegation.delivery = "ace-input".to_owned();
    });
    for key in [
        r#""id":"#,
        r#""type":"#,
        r#""origin":"#,
        r#""results":"#,
        r#""delivery":"#,
        r#""futureDelegation":"#,
    ] {
        assert_eq!(json.matches(key).count(), 1, "{key}: {json}");
    }
    let Item::DelegationSettled { delegation, .. } = item else {
        panic!("expected a settled delegation");
    };
    assert_eq!(delegation.delivery, "ace-input");
    assert!(json.contains(r#""futureDelegation":null"#), "{json}");
}

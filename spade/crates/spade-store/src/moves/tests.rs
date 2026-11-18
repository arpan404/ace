//! A move's import refuses anything that isn't the moving bot's (ADR 0187), as a compromised
//! machine of the fleet would send it, and keeps nothing then.

use std::collections::BTreeMap;

use serde_json::{Value, json};
use spade_core::Event;
use spade_core::event::Known;

use super::{Arriving, Import, MOVE_TABLES, Row, RowSums, Selection, TableSum};
use crate::{NewAgent, ROUTINE, Store, StoredRoutine};

type Rows = Vec<(String, Vec<Row>)>;

fn store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let store = Store::open(&dir.path().join("spade.sqlite")).unwrap_or_else(|e| panic!("{e}"));
    (dir, store)
}

fn bot(store: &Store, id: &str) {
    let conversation = format!("c_{id}");
    store
        .create_agent(
            NewAgent {
                id,
                kind: "bot",
                name: id,
                task: "",
                avatar: "{}",
                model: "e/m",
                conversation: &conversation,
            },
            &[Event::user_message("hello")],
            1,
        )
        .unwrap_or_else(|e| panic!("{e}"));
}

/// The bot `a_1` with a webhook routine and a setting of its own, on its machine.
fn source() -> (tempfile::TempDir, Store) {
    let (dir, store) = store();
    bot(&store, "a_1");
    store
        .insert_routine(&StoredRoutine {
            id: "r_1".into(),
            agent_id: "a_1".into(),
            kind: ROUTINE.into(),
            name: "Hook".into(),
            instruction: "Run.".into(),
            trigger: json!({ "kind": "webhook" }).to_string(),
            time_zone: "UTC".into(),
            paused: false,
            secret: Some("whsec-very-secret".into()),
            next_due_ms: None,
            created_by: "person".into(),
            created_ms: 1,
            updated_ms: 1,
            untrusted: false,
        })
        .unwrap_or_else(|e| panic!("{e}"));
    store
        .set_setting("oversight:a_1", Some("{}"))
        .unwrap_or_else(|e| panic!("{e}"));
    (dir, store)
}

/// Every row of `a_1`, table by table, and what each table sums to.
fn export(store: &Store) -> (Rows, BTreeMap<String, TableSum>) {
    let selection = store
        .move_selection(&["a_1".to_owned()])
        .unwrap_or_else(|e| panic!("{e}"));
    let mut rows = Vec::new();
    let mut sums = BTreeMap::new();
    for table in MOVE_TABLES {
        let mut all = if table.paged() {
            let mut events = Vec::new();
            for conversation in &selection.conversations {
                events.extend(
                    store
                        .move_events(conversation, i64::MIN, 10_000)
                        .unwrap_or_else(|e| panic!("{e}")),
                );
            }
            events
        } else {
            store
                .move_rows(table, &selection)
                .unwrap_or_else(|e| panic!("{e}"))
        };
        let mut sum = RowSums::default();
        for row in &all {
            sum.add(row);
        }
        sums.insert(table.name.to_owned(), sum.finish());
        if !all.is_empty() {
            rows.push((table.name.to_owned(), std::mem::take(&mut all)));
        }
    }
    (rows, sums)
}

fn import(store: &Store, rows: Rows, sums: &BTreeMap<String, TableSum>) -> Result<(), String> {
    let agents = vec!["a_1".to_owned()];
    let mut parts = rows.into_iter().map(Ok);
    let marker = Event::Known(Known::Arrived {
        from: "Laptop".into(),
    });
    store
        .move_import(Import {
            agents: &agents,
            expected: sums,
            parts: &mut parts,
            main: false,
            arriving: Arriving {
                move_id: "mv_1",
                placing: "placing",
                now_ms: 5,
                from: "host-laptop",
                secret: &|| "new-secret".to_owned(),
                security_key: &|agent| format!("security:{agent}"),
                reset: &|text| (text.to_owned(), Vec::new()),
                marker: &marker,
                host: None,
                detail: &|_: &Selection, _| "{}".to_owned(),
            },
        })
        .unwrap_or_else(|e| panic!("{e}"))
        .map(|_| ())
}

fn row(value: Value) -> Row {
    value.as_object().cloned().unwrap_or_default()
}

/// The target already has its own bot `a_9`, and a global setting.
fn target() -> (tempfile::TempDir, Store) {
    let (dir, store) = store();
    bot(&store, "a_9");
    store
        .set_setting("oversight:a_9", Some(r#"{"review":true}"#))
        .unwrap_or_else(|e| panic!("{e}"));
    (dir, store)
}

fn untouched(store: &Store) {
    assert!(
        store.agent("a_1").ok().flatten().is_none(),
        "nothing of the move kept"
    );
    assert_eq!(
        store.setting("oversight:a_9").ok().flatten().as_deref(),
        Some(r#"{"review":true}"#)
    );
    assert_eq!(store.setting("main_host").ok().flatten(), None);
}

#[test]
fn a_clean_move_imports_and_its_webhook_gets_a_new_secret_that_never_travelled() {
    let (_a, from) = source();
    let (rows, sums) = export(&from);
    let text = serde_json::to_string(&rows).unwrap_or_default();
    assert!(
        !text.contains("whsec-very-secret"),
        "a webhook secret travelled"
    );
    let (_b, to) = target();
    assert_eq!(import(&to, rows, &sums), Ok(()));
    let routine = to.routine("r_1").ok().flatten();
    assert_eq!(
        routine.as_ref().and_then(|r| r.secret.as_deref()),
        Some("new-secret")
    );
    assert!(routine.is_some_and(|r| r.paused));
}

#[test]
fn a_setting_for_another_bot_or_the_whole_machine_is_refused_and_nothing_kept() {
    for key in [
        "oversight:a_9",
        "main_host",
        "oversight",
        "security:a_9",
        "plugins.access",
    ] {
        let (_a, from) = source();
        let (mut rows, sums) = export(&from);
        rows.push((
            "settings".into(),
            vec![row(json!({ "key": key, "value": "{\"review\":false}" }))],
        ));
        let (_b, to) = target();
        let refused = import(&to, rows, &sums);
        assert!(refused.is_err(), "{key} was taken");
        untouched(&to);
    }
}

#[test]
fn a_row_that_belongs_to_no_moving_bot_is_refused_though_the_bots_own_rows_add_up() {
    // The bot's own rows match the sums sent; the extra rows lie outside what it owns, where
    // the sums never look.
    let extra = [
        (
            "conversations",
            json!({ "id": "c_stray", "title": null, "created_ms": 1, "updated_ms": 1 }),
        ),
        (
            "events",
            json!({ "conversation_id": "c_a_9", "seq": 99, "at_ms": 1, "body": "{}" }),
        ),
        (
            "routine_runs",
            json!({ "id": "run_x", "routine_id": "r_other", "slot_ms": null,
            "at_ms": 1, "cause": "c", "outcome": "o", "seq": null, "detail": null }),
        ),
    ];
    for (table, value) in extra {
        let (_a, from) = source();
        let (mut rows, sums) = export(&from);
        rows.push((table.into(), vec![row(value)]));
        let (_b, to) = target();
        let refused = import(&to, rows, &sums);
        assert!(refused.is_err(), "{table}: a stray row was kept");
        untouched(&to);
        assert_eq!(to.events("c_a_9", 0).map(|e| e.len()).unwrap_or(0), 1);
    }
}

#[test]
fn a_helper_or_club_pointing_at_another_bots_conversation_is_refused() {
    let helper = json!({ "conversation_id": "c_a_9", "parent_id": "c_a_1", "job": "j",
        "reply": "r", "profile": "p", "system": "s", "reads_only": 1, "tools": null,
        "model": "e/m", "created_ms": 1 });
    let club = json!({ "id": "g_1", "name": "Launch", "lead_id": "a_1",
        "conversation_id": "c_a_9", "created_ms": 1, "updated_ms": 1, "pinned_ms": null });
    for (table, value) in [("helpers", helper), ("groups", club)] {
        let (_a, from) = source();
        let (mut rows, sums) = export(&from);
        rows.push((table.into(), vec![row(value)]));
        let (_b, to) = target();
        assert!(import(&to, rows, &sums).is_err(), "{table} was taken");
        untouched(&to);
    }
}

#[test]
fn a_row_with_a_missing_extra_or_mistyped_column_is_refused() {
    for change in ["extra", "missing", "type", "main"] {
        let (_a, from) = source();
        let (mut rows, sums) = export(&from);
        if let Some((_, agents)) = rows.iter_mut().find(|(name, _)| name == "agents")
            && let Some(agent) = agents.first_mut()
        {
            match change {
                "extra" => {
                    agent.insert("secret".into(), json!("x"));
                }
                "missing" => {
                    agent.remove("model");
                }
                "type" => {
                    agent.insert("created_ms".into(), json!("yesterday"));
                }
                _ => {
                    agent.insert("kind".into(), json!("main"));
                }
            }
        }
        let (_b, to) = target();
        assert!(import(&to, rows, &sums).is_err(), "{change} was taken");
        untouched(&to);
    }
}

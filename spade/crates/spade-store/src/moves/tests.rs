//! A move's import refuses anything that isn't the moving bot's (ADR 0187), as a compromised
//! machine of the fleet would send it, and keeps nothing then.

use std::collections::BTreeMap;

use serde_json::{Value, json};
use spade_core::Event;
use spade_core::event::Known;

use super::{Activation, Arriving, MOVE_TABLES, Row, RowSums, Selection, Stage, TableSum};
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

/// Every row of `a_1`, table by table, a page at a time, and what each table sums to.
fn export(store: &Store) -> (Rows, BTreeMap<String, TableSum>) {
    let selection = store
        .move_selection(&["a_1".to_owned()])
        .unwrap_or_else(|e| panic!("{e}"));
    let mut rows = Vec::new();
    let mut sums = BTreeMap::new();
    for table in MOVE_TABLES {
        let mut all = Vec::new();
        let mut cursor = None;
        loop {
            let (page, next) = store
                .move_page(table, &selection, &cursor)
                .unwrap_or_else(|e| panic!("{e}"));
            all.extend(page);
            match next {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        let mut sum = RowSums::default();
        for row in &all {
            sum.add(row);
        }
        sums.insert(table.name.to_owned(), sum.finish());
        if !all.is_empty() {
            rows.push((table.name.to_owned(), all));
        }
    }
    (rows, sums)
}

/// Stages `rows`, checks them there, then writes them into `store` as a move does.
fn import_as(
    store: &Store,
    rows: Rows,
    sums: &BTreeMap<String, TableSum>,
    main: bool,
    main_active: bool,
) -> Result<(), String> {
    let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    let agents = vec!["a_1".to_owned()];
    let mut stage = Stage::create(&dir.path().join("stage.sqlite"), &agents, main)
        .map_err(|e| e.to_string())?;
    for (table, rows) in rows {
        stage.add(&table, rows).map_err(|e| e.to_string())??;
    }
    let selection = stage.verify(sums).map_err(|e| e.to_string())??;
    let marker = Event::Known(Known::Arrived {
        from: "Laptop".into(),
    });
    let active = move |_: &dyn Fn(&str) -> Option<String>| main_active;
    store
        .move_activate(
            &stage,
            Activation {
                selection: &selection,
                main,
                main_active: &active,
                after_batch: &|| {},
                arriving: Arriving {
                    move_id: "mv_1",
                    routines_paused: stage.running_routines().map_err(|e| e.to_string())?,
                    placing: "placing",
                    now_ms: 5,
                    from: "host-laptop",
                    secret: &|| "new-secret".to_owned(),
                    security_key: &|agent| format!("security:{agent}"),
                    reset: &|text| (format!("reset {text}"), Vec::new()),
                    marker: &marker,
                    host: None,
                    detail: &|_: &Selection, _| "{}".to_owned(),
                },
            },
        )
        .map_err(|e| e.to_string())?
        .map(|_| ())
}

fn import(store: &Store, rows: Rows, sums: &BTreeMap<String, TableSum>) -> Result<(), String> {
    import_as(store, rows, sums, false, false)
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
    // It brought no security settings: it gets the reset ones all the same.
    assert_eq!(
        to.setting("security:a_1").ok().flatten().as_deref(),
        Some("reset {}")
    );
    assert!(
        to.agents()
            .unwrap_or_default()
            .iter()
            .any(|a| a.id == "a_1")
    );
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

#[test]
fn spade_in_use_here_is_never_replaced_and_nothing_of_the_move_is_kept() {
    let (_a, from) = source();
    let (mut rows, sums) = export(&from);
    if let Some((_, agents)) = rows.iter_mut().find(|(name, _)| name == "agents")
        && let Some(agent) = agents.first_mut()
    {
        agent.insert("kind".into(), json!("main"));
    }
    let mut sums = sums;
    let agents_rows: Vec<Row> = rows
        .iter()
        .filter(|(name, _)| name == "agents")
        .flat_map(|(_, rows)| rows.clone())
        .collect();
    let mut sum = RowSums::default();
    for one in &agents_rows {
        sum.add(one);
    }
    sums.insert("agents".into(), sum.finish());
    let (_b, to) = target();
    let refused = import_as(&to, rows, &sums, true, true);
    assert!(refused.is_err_and(|why| why.contains("in use")));
    untouched(&to);
}

/// `a_1`'s rows, with every `from` in values that name a conversation or club made `to`.
fn renamed(rows: Rows, table: &str, column: &str, from: &str, to: &str) -> Rows {
    rows.into_iter()
        .map(|(name, list)| {
            let list = list
                .into_iter()
                .map(|mut row| {
                    if (name == table || table == "*")
                        && row.get(column).and_then(Value::as_str) == Some(from)
                    {
                        row.insert(column.into(), json!(to));
                    }
                    row
                })
                .collect();
            (name, list)
        })
        .collect()
}

fn sums_of(rows: &Rows) -> BTreeMap<String, TableSum> {
    MOVE_TABLES
        .iter()
        .map(|table| {
            let mut sum = RowSums::default();
            for (_, list) in rows.iter().filter(|(name, _)| name == table.name) {
                for row in list {
                    sum.add(row);
                }
            }
            (table.name.to_owned(), sum.finish())
        })
        .collect()
}

#[test]
fn a_move_bringing_a_conversation_id_this_machine_has_is_refused_and_that_conversation_is_untouched()
 {
    let (_a, from) = source();
    let (rows, _) = export(&from);
    // The moving bot's conversation carries the id of a conversation the target already has.
    let rows = renamed(rows, "conversations", "id", "c_a_1", "c_a_9");
    let rows = renamed(rows, "*", "conversation_id", "c_a_1", "c_a_9");
    let sums = sums_of(&rows);
    let (_b, to) = target();
    let before = to.events("c_a_9", 0).unwrap_or_default();
    let refused = import(&to, rows, &sums);
    assert!(refused.is_err_and(|why| why.contains("already has")));
    untouched(&to);
    assert_eq!(
        to.events("c_a_9", 0).unwrap_or_default(),
        before,
        "not a row of it went"
    );
    assert!(to.agent("a_9").ok().flatten().is_some());
}

#[test]
fn a_move_bringing_a_club_id_this_machine_has_is_refused_and_that_club_is_untouched() {
    let (_a, from) = source();
    let (mut rows, _) = export(&from);
    rows.push((
        "conversations".into(),
        vec![row(
            json!({ "id": "c_club", "title": null, "created_ms": 1, "updated_ms": 1 }),
        )],
    ));
    rows.push((
        "groups".into(),
        vec![row(
            json!({ "id": "g_1", "name": "Launch", "lead_id": "a_1",
            "conversation_id": "c_club", "created_ms": 1, "updated_ms": 1, "pinned_ms": null }),
        )],
    ));
    let sums = sums_of(&rows);
    let (_b, to) = target();
    // The target's own club with that id, led by its own bot.
    to.create_group(&crate::StoredGroup {
        id: "g_1".into(),
        name: "Mine".into(),
        lead_id: "a_9".into(),
        conversation: "c_mine".into(),
        members: Vec::new(),
        created_ms: 1,
        updated_ms: 1,
        pinned_ms: None,
    })
    .unwrap_or_else(|e| panic!("{e}"));
    let refused = import(&to, rows, &sums);
    assert!(refused.is_err_and(|why| why.contains("already has")));
    untouched(&to);
    let kept = to.group("g_1").ok().flatten();
    assert_eq!(
        kept.map(|g| g.name),
        Some("Mine".to_owned()),
        "the target's club stays"
    );
}

#[test]
fn a_page_holds_its_rows_or_its_bytes_whichever_comes_first() {
    let (_a, from) = source();
    let big = "x".repeat(3 * 1024 * 1024);
    let events: Vec<Event> = (0..3).map(|_| Event::user_message(big.clone())).collect();
    from.append_all("c_a_1", &events, 2)
        .unwrap_or_else(|e| panic!("{e}"));
    let selection = from
        .move_selection(&["a_1".to_owned()])
        .unwrap_or_else(|e| panic!("{e}"));
    let table = super::move_table(super::EVENTS).unwrap_or_else(|| panic!("events"));
    let (first, next) = from
        .move_page(table, &selection, &None)
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(first.len() < 4, "a page of {} rows of 3 MB", first.len());
    assert!(next.is_some(), "and more to read");
}

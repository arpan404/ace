// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
//! The stored `body` bytes must be the ones `JSON.stringify(normalizeAutomation(automation))`
//! writes in the TypeScript (`store.ts:145`), so a home either backend wrote opens in the other.
//! The fixtures are rows as the TypeScript writes them.

use ace_automations::{AutomationStore, Definition};
use ace_store::{Connection, OpenOptions, Value};

fn open(path: &std::path::Path) -> AutomationStore {
    AutomationStore::open(path.to_str().expect("utf8")).expect("store")
}

fn body_of(path: &std::path::Path, id: &str) -> String {
    let conn = Connection::open(
        path.to_str().expect("utf8"),
        OpenOptions {
            read_only: true,
            timeout_ms: 5000,
        },
    )
    .expect("raw");
    let statement = conn
        .prepare("SELECT body FROM automation_jobs WHERE id=?")
        .expect("prepare");
    statement
        .bind(&[Some(Value::Text(id.to_owned()))])
        .expect("bind");
    let row = statement.step().expect("step").expect("row");
    match row.first() {
        Some(Value::Text(body)) => body.clone(),
        other => panic!("no body: {other:?}"),
    }
}

#[test]
fn a_scheduled_definitions_body_is_byte_identical_to_the_typescripts_json() {
    let dir = tempfile::tempdir().expect("temp");
    let path = dir.path().join("auto.sqlite");
    let fixture = r#"{"id":"triage","title":"Triage","enabled":true,"workspace":"/project","provider":"codex","access":"read-only","model":"test-model","effort":"high","instance":"codex_work","prompt":"Triage {{subject}}","worktree":true,"trigger":{"kind":"schedule","schedule":{"kind":"rrule","expression":"FREQ=DAILY","timezone":"UTC","startAt":1704099600000}},"missedRun":"skip","concurrency":1,"jitterMs":0}"#;
    let definition: Definition =
        ace_json::from_value(&ace_json::parse(fixture).expect("fixture")).expect("definition");
    let store = open(&path);
    store
        .put(
            &definition,
            Some(1_704_099_600_000),
            Some(1_704_099_600_000),
            &ace_json::Value::Object(Default::default()),
            None,
        )
        .expect("put");
    assert_eq!(body_of(&path, "triage"), fixture);
    store.close().expect("close");
}

#[test]
fn a_github_definitions_body_is_byte_identical_to_the_typescripts_json() {
    let dir = tempfile::tempdir().expect("temp");
    let path = dir.path().join("auto.sqlite");
    let fixture = r#"{"id":"prs","title":"PRs","enabled":false,"workspace":"/project","provider":"claude","prompt":"Review","worktree":false,"trigger":{"kind":"github","repository":"user/project","event":"pr_changed","label":"bug","pullRequest":7,"pollIntervalMs":60000},"missedRun":"run_once","concurrency":2,"jitterMs":1500}"#;
    let definition: Definition =
        ace_json::from_value(&ace_json::parse(fixture).expect("fixture")).expect("definition");
    let store = open(&path);
    store
        .put(
            &definition,
            None,
            None,
            &ace_json::Value::Object(Default::default()),
            None,
        )
        .expect("put");
    assert_eq!(body_of(&path, "prs"), fixture);
    store.close().expect("close");
}

#[test]
fn the_finished_index_and_inbox_query_use_the_typescripts_max_safe_integer() {
    let dir = tempfile::tempdir().expect("temp");
    let path = dir.path().join("auto.sqlite");
    let store = open(&path);
    let plan = store.inbox_query_plan(0).expect("plan");
    assert!(
        plan.iter()
            .any(|step| step.contains("SEARCH") && step.contains("automation_finished")),
        "plan: {plan:?}"
    );
    assert!(
        !plan
            .iter()
            .any(|step| step.starts_with("SCAN automation_runs")),
        "plan: {plan:?}"
    );
    let conn = Connection::open(
        path.to_str().expect("utf8"),
        OpenOptions {
            read_only: true,
            timeout_ms: 5000,
        },
    )
    .expect("raw");
    let statement = conn
        .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='automation_finished'")
        .expect("prepare");
    statement.bind(&[]).expect("bind");
    let row = statement.step().expect("step").expect("row");
    assert!(
        matches!(row.first(), Some(Value::Text(sql)) if sql.contains("9007199254740991")),
        "{row:?}"
    );
    conn.close().expect("close");
    store.close().expect("close");
}

#[test]
fn an_older_home_without_the_finished_index_heals_in_idle() {
    let dir = tempfile::tempdir().expect("temp");
    let path = dir.path().join("auto.sqlite");
    let store = open(&path);
    let conn = Connection::open(
        path.to_str().expect("utf8"),
        OpenOptions {
            read_only: false,
            timeout_ms: 5000,
        },
    )
    .expect("raw");
    conn.exec("DROP INDEX IF EXISTS automation_finished")
        .expect("drop");
    conn.close().expect("close");
    assert_eq!(
        store.finished_index().expect("index"),
        ace_automations::store::FinishedIndex::Missing
    );
    assert!(
        store
            .inbox(50, None, None, Some(0))
            .expect("unindexed read")
            .0
            .is_empty()
    );
    // A small file heals in idle; the same threshold leaves large files to maintenance.
    store.backfill_finished_at(1).expect("idle");
    assert_eq!(
        store.finished_index().expect("index"),
        ace_automations::store::FinishedIndex::Current
    );
    let plan = store.inbox_query_plan(0).expect("plan");
    assert!(
        plan.iter()
            .any(|step| step.contains("SEARCH") && step.contains("automation_finished")),
        "plan: {plan:?}"
    );
    store.close().expect("close");
}

#[test]
fn idle_repairs_the_previous_rust_index_for_a_small_file() {
    let dir = tempfile::tempdir().expect("temp");
    let path = dir.path().join("auto.sqlite");
    let store = open(&path);
    let raw = Connection::open(
        path.to_str().expect("utf8"),
        OpenOptions {
            read_only: false,
            timeout_ms: 5000,
        },
    )
    .expect("raw");
    raw
    .exec("DROP INDEX automation_finished; CREATE INDEX automation_finished ON automation_runs(coalesce(finished_at, 9223372036854775807))")
    .expect("old index");
    raw.exec("BEGIN IMMEDIATE").expect("begin");
    for index in 0..20 {
        let body = format!(
            r#"{{"id":"old-{index}","finishedAt":{}}}"#,
            1_704_099_600_000i64 + index
        );
        let statement = raw
      .prepare("INSERT INTO automation_runs(id,automation_id,event_key,status,body,input,finished_at) VALUES(?,?,?,?,?,NULL,NULL)")
      .expect("prepare");
        statement
            .bind(&[
                Some(Value::Text(format!("old-{index}"))),
                Some(Value::Text("a".to_owned())),
                Some(Value::Text(format!("old-{index}"))),
                Some(Value::Text("succeeded".to_owned())),
                Some(Value::Text(body)),
            ])
            .expect("bind");
        statement.step().expect("insert");
    }
    raw.exec("COMMIT").expect("commit");
    raw.close().expect("close");
    assert_eq!(
        store.finished_index().expect("index"),
        ace_automations::store::FinishedIndex::Outdated
    );
    let plan = store.inbox_query_plan(0).expect("plan");
    assert!(
        !plan.iter().any(|step| step.contains("automation_finished")),
        "plan: {plan:?}"
    );
    assert_eq!(store.backfill_finished_at(5).expect("idle"), 5);
    assert!(store.idle_examined() <= 5);
    assert_eq!(
        store.finished_index().expect("index"),
        ace_automations::store::FinishedIndex::Current
    );
    let plan = store.inbox_query_plan(0).expect("plan");
    assert!(
        plan.iter()
            .any(|step| step.contains("SEARCH") && step.contains("automation_finished")),
        "plan: {plan:?}"
    );
    store.close().expect("close");
}

#[test]
fn idle_examines_and_updates_at_most_the_batch_over_a_large_legacy_history() {
    let dir = tempfile::tempdir().expect("temp");
    let path = dir.path().join("auto.sqlite");
    let store = open(&path);
    let raw = Connection::open(
        path.to_str().expect("utf8"),
        OpenOptions {
            read_only: false,
            timeout_ms: 5000,
        },
    )
    .expect("raw");
    raw.exec("BEGIN IMMEDIATE").expect("begin");
    for index in 0..500 {
        let body = format!(
            r#"{{"id":"old-{index}","finishedAt":{}}}"#,
            1_704_099_600_000i64 + index
        );
        let statement = raw
      .prepare("INSERT INTO automation_runs(id,automation_id,event_key,status,body,input,finished_at) VALUES(?,?,?,?,?,NULL,NULL)")
      .expect("prepare");
        statement
            .bind(&[
                Some(Value::Text(format!("old-{index}"))),
                Some(Value::Text("a".to_owned())),
                Some(Value::Text(format!("old-{index}"))),
                Some(Value::Text("succeeded".to_owned())),
                Some(Value::Text(body)),
            ])
            .expect("bind");
        statement.step().expect("insert");
    }
    raw.exec("COMMIT").expect("commit");
    raw.close().expect("close");
    let mut changed = 0;
    for _ in 0..50 {
        let batch = store.backfill_finished_at(10).expect("batch");
        assert!(store.idle_examined() <= 10);
        changed += batch;
    }
    assert_eq!(changed, 500);
    assert_eq!(store.backfill_finished_at(10).expect("caught up"), 0);
    assert_eq!(store.idle_examined(), 0);
    store.close().expect("close");
}

#[test]
fn a_huge_legacy_index_is_dropped_in_idle_not_rebuilt_over_history() {
    let dir = tempfile::tempdir().expect("temp");
    let path = dir.path().join("auto.sqlite");
    let store = open(&path);
    let raw = Connection::open(
        path.to_str().expect("utf8"),
        OpenOptions {
            read_only: false,
            timeout_ms: 5000,
        },
    )
    .expect("raw");
    raw
    .exec("DROP INDEX automation_finished; CREATE INDEX automation_finished ON automation_runs(coalesce(finished_at, 9223372036854775807))")
    .expect("old index");
    raw.exec("BEGIN IMMEDIATE").expect("begin");
    for index in 0..10_001 {
        let statement = raw
      .prepare("INSERT INTO automation_runs(id,automation_id,event_key,status,body,input,finished_at) VALUES(?,?,?,?,?,NULL,NULL)")
      .expect("prepare");
        statement
            .bind(&[
                Some(Value::Text(format!("bulk-{index}"))),
                Some(Value::Text("a".to_owned())),
                Some(Value::Text(format!("bulk-{index}"))),
                Some(Value::Text("running".to_owned())),
                Some(Value::Text(format!(r#"{{"id":"bulk-{index}"}}"#))),
            ])
            .expect("bind");
        statement.step().expect("insert");
    }
    raw.exec("COMMIT").expect("commit");
    raw.close().expect("close");
    assert_eq!(
        store.finished_index().expect("index"),
        ace_automations::store::FinishedIndex::Outdated
    );
    store.backfill_finished_at(1).expect("idle");
    assert_eq!(
        store.finished_index().expect("index"),
        ace_automations::store::FinishedIndex::Missing
    );
    assert!(store.idle_examined() <= 1);
    store.close().expect("close");
}

#[test]
fn idle_heals_a_typescript_home_that_lacks_the_finished_indexes() {
    let dir = tempfile::tempdir().expect("temp");
    let path = dir.path().join("auto.sqlite");
    let store = open(&path);
    let raw = Connection::open(
        path.to_str().expect("utf8"),
        OpenOptions {
            read_only: false,
            timeout_ms: 5000,
        },
    )
    .expect("raw");
    raw
    .exec(
      "DROP INDEX IF EXISTS automation_finished; DROP INDEX IF EXISTS automation_unfinished; DROP INDEX IF EXISTS automation_history; DROP INDEX IF EXISTS automation_active; DROP INDEX IF EXISTS automation_status",
    )
    .expect("old home");
    raw.close().expect("close");
    assert_eq!(
        store.finished_index().expect("index"),
        ace_automations::store::FinishedIndex::Missing
    );
    // A small file heals in idle, bounded by the same threshold as the rebuild.
    store.backfill_finished_at(1).expect("idle");
    assert_eq!(
        store.finished_index().expect("index"),
        ace_automations::store::FinishedIndex::Current
    );
    let plan = store.inbox_query_plan(0).expect("plan");
    assert!(
        plan.iter()
            .any(|step| step.contains("SEARCH") && step.contains("automation_finished")),
        "plan: {plan:?}"
    );
    store.close().expect("close");
}

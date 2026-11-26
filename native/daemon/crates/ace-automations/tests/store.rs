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
fn an_older_home_without_the_finished_index_still_reads_and_idle_creates_it() {
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
    assert!(!store.has_index("automation_finished").expect("index"));
    assert!(
        store
            .inbox(50, None, None, Some(0))
            .expect("unindexed read")
            .0
            .is_empty()
    );
    store.backfill_finished_at(1).expect("idle");
    assert!(store.has_index("automation_finished").expect("index"));
    assert!(
        store
            .inbox(50, None, None, Some(0))
            .expect("indexed read")
            .0
            .is_empty()
    );
    store.close().expect("close");
}

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
    // The indexed inbox path waits until the backfill has reached every row.
    while store.backfill_finished_at(5).expect("idle") > 0 {}
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
    // A small file heals in idle, bounded by the same threshold as the rebuild; every missing
    // run index is checked and built, not only the finish one.
    store.backfill_finished_at(1).expect("idle");
    assert_eq!(
        store.finished_index().expect("index"),
        ace_automations::store::FinishedIndex::Current
    );
    for name in [
        "automation_history",
        "automation_active",
        "automation_status",
        "automation_unfinished",
        "automation_finished",
    ] {
        assert!(store.has_index(name).expect("index"), "{name} is healed");
    }
    let plan = store.inbox_query_plan(0).expect("plan");
    assert!(
        plan.iter()
            .any(|step| step.contains("SEARCH") && step.contains("automation_finished")),
        "plan: {plan:?}"
    );
    store.close().expect("close");
}

fn legacy_runs(raw: &std::sync::Arc<Connection>, status: &str, count: i64, finished: bool) {
    raw.exec("BEGIN IMMEDIATE").expect("begin");
    for index in 0..count {
        let id = format!("{status}-{index}");
        let body = format!(
            r#"{{"id":"{id}","finishedAt":{}}}"#,
            1_704_099_600_000i64 + index
        );
        let statement = raw
      .prepare("INSERT INTO automation_runs(id,automation_id,event_key,status,body,input,finished_at) VALUES(?,?,?,?,?,'{}',?)")
      .expect("prepare");
        statement
            .bind(&[
                Some(Value::Text(id.clone())),
                Some(Value::Text(format!("auto-{status}"))),
                Some(Value::Text(id)),
                Some(Value::Text(status.to_owned())),
                Some(Value::Text(body)),
                finished.then_some(Value::Integer(1_704_099_600_000i64 + index)),
            ])
            .expect("bind");
        statement.step().expect("insert");
    }
    raw.exec("COMMIT").expect("commit");
}

#[test]
fn the_idle_backfill_resumes_from_its_persisted_cursor_after_a_restart() {
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
    legacy_runs(&raw, "succeeded", 20, false);
    raw.close().expect("close");
    assert_eq!(store.backfill_finished_at(10).expect("first batch"), 10);
    store.close().expect("close");

    // A restart resumes after the rows the last run went through instead of re-reading them.
    let store = open(&path);
    assert_eq!(store.backfill_finished_at(10).expect("second batch"), 10);
    assert_eq!(store.backfill_finished_at(10).expect("caught up"), 0);
    assert_eq!(store.idle_examined(), 0);
    for _ in 0..5 {
        assert_eq!(store.backfill_finished_at(10).expect("idle"), 0);
        assert_eq!(store.idle_examined(), 0);
    }
    store.close().expect("close");
}

#[test]
fn a_legacy_home_without_the_status_index_answers_startup_from_partial_indexes() {
    let dir = tempfile::tempdir().expect("temp");
    let path = dir.path().join("auto.sqlite");
    let _store = open(&path);
    let raw = Connection::open(
        path.to_str().expect("utf8"),
        OpenOptions {
            read_only: false,
            timeout_ms: 5000,
        },
    )
    .expect("raw");
    legacy_runs(&raw, "succeeded", 500, true);
    legacy_runs(&raw, "running", 1, false);
    legacy_runs(&raw, "queued", 1, false);
    raw.exec("DROP INDEX automation_status")
        .expect("drop status");
    raw.close().expect("close");

    let store = open(&path);
    assert_eq!(store.active().expect("active").len(), 1);
    assert_eq!(
        store.waiting_automations().expect("waiting"),
        vec!["auto-queued".to_owned()]
    );
    let active = store.startup_query_plan(false).expect("active plan");
    assert!(
        active.iter().any(|step| step.contains("automation_active")),
        "{active:?}"
    );
    assert!(
        !active.iter().any(|step| step == "SCAN automation_runs"),
        "{active:?}"
    );
    let waiting = store.startup_query_plan(true).expect("waiting plan");
    assert!(
        waiting
            .iter()
            .any(|step| step.contains("automation_unfinished")),
        "{waiting:?}"
    );
    assert!(
        !waiting.iter().any(|step| step == "SCAN automation_runs"),
        "{waiting:?}"
    );
    store.close().expect("close");
}

#[test]
fn a_full_batch_of_already_populated_rows_reports_progress_over_later_legacy_rows() {
    let dir = tempfile::tempdir().expect("temp");
    let path = dir.path().join("auto.sqlite");
    let _store = open(&path);
    let raw = Connection::open(
        path.to_str().expect("utf8"),
        OpenOptions {
            read_only: false,
            timeout_ms: 5000,
        },
    )
    .expect("raw");
    raw.exec("BEGIN IMMEDIATE").expect("begin");
    for (index, populated) in [(0, true), (1, true), (2, false)] {
        let statement = raw
      .prepare("INSERT INTO automation_runs(id,automation_id,event_key,status,body,input,finished_at) VALUES(?,?,?,?,?,NULL,?)")
      .expect("prepare");
        statement
            .bind(&[
                Some(Value::Text(format!("run-{index}"))),
                Some(Value::Text("a".to_owned())),
                Some(Value::Text(format!("run-{index}"))),
                Some(Value::Text("succeeded".to_owned())),
                Some(Value::Text(format!(
                    r#"{{"id":"run-{index}","finishedAt":{}}}"#,
                    1_704_099_600_000i64 + index
                ))),
                populated.then_some(Value::Integer(1_704_099_600_000i64 + index)),
            ])
            .expect("bind");
        statement.step().expect("insert");
    }
    raw.exec("COMMIT").expect("commit");
    raw.close().expect("close");

    let store = open(&path);
    assert_eq!(store.backfill_finished_at(2).expect("first batch"), 2);
    assert_eq!(
        store.idle_changed(),
        0,
        "the first two rows already had their finish time"
    );
    assert_eq!(store.backfill_finished_at(2).expect("second batch"), 1);
    assert_eq!(store.idle_changed(), 1);
    assert_eq!(store.backfill_finished_at(2).expect("done"), 0);
    store.close().expect("close");
}

#[test]
fn a_malformed_body_is_skipped_without_stopping_later_backfill_batches() {
    let dir = tempfile::tempdir().expect("temp");
    let path = dir.path().join("auto.sqlite");
    let _store = open(&path);
    let raw = Connection::open(
        path.to_str().expect("utf8"),
        OpenOptions {
            read_only: false,
            timeout_ms: 5000,
        },
    )
    .expect("raw");
    raw.exec("BEGIN IMMEDIATE").expect("begin");
    let statement = raw
    .prepare("INSERT INTO automation_runs(id,automation_id,event_key,status,body,input,finished_at) VALUES(?,?,?,?,?,NULL,NULL)")
    .expect("prepare");
    statement
        .bind(&[
            Some(Value::Text("broken".to_owned())),
            Some(Value::Text("a".to_owned())),
            Some(Value::Text("broken".to_owned())),
            Some(Value::Text("succeeded".to_owned())),
            Some(Value::Text("not json".to_owned())),
        ])
        .expect("bind");
    statement.step().expect("insert");
    let statement = raw
    .prepare("INSERT INTO automation_runs(id,automation_id,event_key,status,body,input,finished_at) VALUES(?,?,?,?,?,NULL,NULL)")
    .expect("prepare");
    statement
        .bind(&[
            Some(Value::Text("good".to_owned())),
            Some(Value::Text("a".to_owned())),
            Some(Value::Text("good".to_owned())),
            Some(Value::Text("succeeded".to_owned())),
            Some(Value::Text(
                r#"{"id":"good","finishedAt":1704099601000}"#.to_owned(),
            )),
        ])
        .expect("bind");
    statement.step().expect("insert");
    raw.exec("COMMIT").expect("commit");
    raw.close().expect("close");

    let store = open(&path);
    assert_eq!(store.backfill_finished_at(2).expect("batch"), 2);
    assert_eq!(store.idle_changed(), 1);
    assert_eq!(store.backfill_finished_at(2).expect("done"), 0);
    store.close().expect("close");
}

#[test]
fn a_legacy_finish_time_in_the_body_is_used_until_the_backfill_reaches_it() {
    let dir = tempfile::tempdir().expect("temp");
    let path = dir.path().join("auto.sqlite");
    let _store = open(&path);
    let raw = Connection::open(
        path.to_str().expect("utf8"),
        OpenOptions {
            read_only: false,
            timeout_ms: 5000,
        },
    )
    .expect("raw");
    raw.exec("BEGIN IMMEDIATE").expect("begin");
    let statement = raw
    .prepare("INSERT INTO automation_runs(id,automation_id,event_key,status,body,input,finished_at) VALUES(?,?,?,?,?,NULL,NULL)")
    .expect("prepare");
    statement
        .bind(&[
            Some(Value::Text("legacy".to_owned())),
            Some(Value::Text("a".to_owned())),
            Some(Value::Text("legacy".to_owned())),
            Some(Value::Text("succeeded".to_owned())),
            Some(Value::Text(
                r#"{"id":"legacy","finishedAt":1704099600000}"#.to_owned(),
            )),
        ])
        .expect("bind");
    statement.step().expect("insert");
    raw.exec("COMMIT").expect("commit");
    raw.close().expect("close");

    let store = open(&path);
    assert!(
        store
            .inbox(50, None, None, Some(1_704_099_600_001))
            .expect("before backfill")
            .0
            .is_empty(),
        "the body's finish time is honored before the column is filled"
    );
    assert_eq!(
        store
            .inbox(50, None, None, Some(1_704_099_599_999))
            .expect("after cutoff")
            .0
            .len(),
        1
    );
    store.backfill_finished_at(10).expect("backfill");
    assert!(
        store
            .inbox(50, None, None, Some(1_704_099_600_001))
            .expect("after backfill")
            .0
            .is_empty()
    );
    store.close().expect("close");
}

#[test]
fn a_current_finish_index_does_not_suppress_healing_the_other_run_indexes() {
    let dir = tempfile::tempdir().expect("temp");
    let path = dir.path().join("auto.sqlite");
    let _store = open(&path);
    let raw = Connection::open(
        path.to_str().expect("utf8"),
        OpenOptions {
            read_only: false,
            timeout_ms: 5000,
        },
    )
    .expect("raw");
    legacy_runs(&raw, "succeeded", 3, false);
    raw.close().expect("close");

    let store = open(&path);
    for name in [
        "automation_history",
        "automation_active",
        "automation_status",
        "automation_unfinished",
    ] {
        let raw = Connection::open(
            path.to_str().expect("utf8"),
            OpenOptions {
                read_only: false,
                timeout_ms: 5000,
            },
        )
        .expect("raw");
        raw.exec(&format!("DROP INDEX {name}")).expect("drop");
        raw.close().expect("close");
        assert!(!store.has_index(name).expect("index"), "{name} is gone");
        assert_eq!(
            store.finished_index().expect("index"),
            ace_automations::store::FinishedIndex::Current,
            "the finish index stays current while another is healed"
        );
        store.backfill_finished_at(10).expect("idle");
        assert!(store.has_index(name).expect("index"), "{name} is healed");
    }

    // Each index has a query it bounds.
    let active = store.startup_query_plan(false).expect("active plan");
    assert!(
        active.iter().any(|step| step.contains("automation_active")),
        "{active:?}"
    );
    let waiting = store.startup_query_plan(true).expect("waiting plan");
    assert!(
        waiting
            .iter()
            .any(|step| step.contains("automation_unfinished")),
        "{waiting:?}"
    );
    let inbox = store.inbox_query_plan(0).expect("inbox plan");
    assert!(
        inbox
            .iter()
            .any(|step| step.contains("automation_finished")),
        "{inbox:?}"
    );
    let raw = Connection::open(
        path.to_str().expect("utf8"),
        OpenOptions {
            read_only: true,
            timeout_ms: 5000,
        },
    )
    .expect("raw");
    let statement = raw
        .prepare(
            "EXPLAIN QUERY PLAN SELECT body FROM automation_runs WHERE automation_id='a' ORDER BY seq DESC LIMIT 1",
        )
        .expect("prepare");
    statement.bind(&[]).expect("bind");
    let mut steps = Vec::new();
    while let Some(row) = statement.step().expect("step") {
        if let Some(Value::Text(step)) = row.get(3) {
            steps.push(step.clone());
        }
    }
    assert!(
        steps.iter().any(|step| step.contains("automation_history")),
        "{steps:?}"
    );
    // With the unfinished index gone, the status index answers the waiting query.
    let writable = Connection::open(
        path.to_str().expect("utf8"),
        OpenOptions {
            read_only: false,
            timeout_ms: 5000,
        },
    )
    .expect("writable");
    writable
        .exec("DROP INDEX automation_unfinished")
        .expect("drop");
    writable.close().expect("close");
    let waiting = store.startup_query_plan(true).expect("waiting plan");
    assert!(
        waiting
            .iter()
            .any(|step| step.contains("automation_status")),
        "{waiting:?}"
    );
    raw.close().expect("close");
    store.close().expect("close");
}

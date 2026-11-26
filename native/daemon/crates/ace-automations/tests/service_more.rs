// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
//! Ports `github.process`'s service polling, `durability`'s watcher health and the idle
//! backfill from `packages/automations/src`.

mod support;

use std::cell::RefCell;

use ace_automations::service::{Action, Ports, Service};
use ace_automations::{Definition, Trigger};
use support::*;

// github.process.test.ts and monitoring.test.ts: polling decisions through the service's
// injected gh client, with the state and errors the store keeps.

type GhStep = (u16, Option<String>, Option<ace_json::Value>);

#[derive(Default)]
struct FakeGh {
    responses: RefCell<Vec<GhStep>>,
    etags: RefCell<Vec<Option<String>>>,
}

impl ace_automations::github::GhClient for FakeGh {
    fn get(
        &self,
        _endpoint: &str,
        etag: Option<&str>,
    ) -> ace_automations::Result<ace_automations::github::GhResponse> {
        self.etags.borrow_mut().push(etag.map(str::to_owned));
        let (status, next_etag, data) = self.responses.borrow_mut().remove(0);
        Ok(ace_automations::github::GhResponse {
            status,
            etag: next_etag,
            next: None,
            data,
        })
    }
}

fn github() -> Definition {
    Definition {
        id: "github".to_owned(),
        prompt: "Review {{number}}".to_owned(),
        trigger: Trigger::Github {
            repository: "user/project".to_owned(),
            event: "pr_changed".to_owned(),
            label: None,
            pull_request: None,
            poll_interval_ms: 60_000,
        },
        ..definition()
    }
}

fn pull(id: i64, version: &str) -> ace_json::Value {
    json(&format!(
        r#"{{"id":{id},"number":{id},"updated_at":"{version}","html_url":"https://github.com/user/project/pull/{id}"}}"#
    ))
}

#[test]
fn github_polls_establish_a_baseline_emit_changes_and_keep_etags_across_restart() {
    let h = Harness::new();
    let gh = FakeGh::default();
    {
        let mut service = h.started();
        service.put(&github(), None).expect("put");
        gh.responses.borrow_mut().push((
            200,
            Some("\"v1\"".to_owned()),
            Some(ace_json::Value::Array(
                vec![pull(1, "2024-01-01T00:00:00Z")].into(),
            )),
        ));
        assert!(
            service
                .poll_github_now("github", &gh)
                .expect("baseline")
                .is_empty()
        );
        gh.responses.borrow_mut().push((
            200,
            Some("\"v2\"".to_owned()),
            Some(ace_json::Value::Array(
                vec![pull(1, "2024-01-02T00:00:00Z")].into(),
            )),
        ));
        let runs = service.poll_github_now("github", &gh).expect("changed");
        assert_eq!(runs.len(), 1);
        let actions = service.take_actions();
        assert_eq!(inputs_prompt(&actions[0]), "Review 1");
        let (id, _) = execute(&actions[0]);
        service
            .complete(&id, "succeeded", Some("thread"), Some("done"))
            .expect("finish");
    }
    let store = h.reopen();
    let mut service = Service::new(
        &store,
        Ports {
            clock: &h.clock,
            random: &h.random,
            admission: &h.admission,
            timer: &h.timer,
            ids: &h.ids,
            workspace: Some(&h.workspace),
            model_loading: None,
        },
    );
    service.start().expect("start");
    gh.responses
        .borrow_mut()
        .push((304, Some("\"v2\"".to_owned()), None));
    assert!(
        service
            .poll_github_now("github", &gh)
            .expect("304")
            .is_empty()
    );
    assert_eq!(
        gh.etags.borrow().last().and_then(|etag| etag.as_deref()),
        Some("\"v2\"")
    );
    assert_eq!(
        service.inbox(50, None, None, None).expect("inbox").0.len(),
        1
    );
    assert!(service.take_actions().is_empty());
}

#[test]
fn a_failed_github_poll_keeps_the_cursor_and_records_health_until_a_success() {
    let h = Harness::new();
    let gh = FakeGh::default();
    let mut service = h.started();
    service.put(&github(), None).expect("put");
    gh.responses.borrow_mut().push((
        200,
        Some("v1".to_owned()),
        Some(ace_json::Value::Array(
            vec![pull(1, "2024-01-01T00:00:00Z")].into(),
        )),
    ));
    service.poll_github_now("github", &gh).expect("baseline");
    let before = h.store.read_state("github").expect("state");
    gh.responses.borrow_mut().push((
        200,
        Some("v2".to_owned()),
        Some(json(r#"[{"id":"invalid"}]"#)),
    ));
    assert!(service.poll_github_now("github", &gh).is_err());
    assert_eq!(h.store.read_state("github").expect("state"), before);
    let listed = service.handle(&json(r#"{"type":"automation.list","requestId":"list"}"#));
    assert_eq!(
        sv(
            at(&arr(&listed, "schedules")[0], "lastPollError").expect("poll error"),
            "message"
        ),
        Some("Invalid GitHub resource: \"id\"")
    );
    gh.responses.borrow_mut().push((304, None, None));
    service.poll_github_now("github", &gh).expect("recovered");
    let listed = service.handle(&json(r#"{"type":"automation.list","requestId":"list"}"#));
    assert!(at(&arr(&listed, "schedules")[0], "lastPollError").is_none());
}

// durability.test.ts: a watcher failure after install, health across restart, and a retry
// that only clears the error when it succeeds.

#[test]
fn a_watcher_failure_reaches_the_service_without_stopping_healthy_work() {
    let h = Harness::new();
    let mut service = h.started();
    let mut flaky = definition();
    flaky.id = "flaky".to_owned();
    flaky.workspace = "/flaky".to_owned();
    flaky.trigger = Trigger::File {
        paths: vec!["src/**".to_owned()],
    };
    let mut steady = definition();
    steady.id = "steady".to_owned();
    steady.workspace = "/steady".to_owned();
    steady.trigger = Trigger::File {
        paths: vec!["src/**".to_owned()],
    };
    service.put(&flaky, None).expect("flaky");
    service.put(&steady, None).expect("steady");
    let revision = service.watch_revision("flaky").expect("revision");
    service
        .watch_error("flaky", revision, "watcher lost")
        .expect("error");
    let listed = service.handle(&json(r#"{"type":"automation.list","requestId":"broken"}"#));
    let entries = arr(&listed, "schedules");
    let flaky_entry = entries
        .iter()
        .find(|entry| sv(entry, "id") == Some("flaky"))
        .expect("flaky entry");
    assert_eq!(
        sv(at(flaky_entry, "triggerError").expect("error"), "message"),
        Some("watcher lost")
    );
    let revision = service.watch_revision("steady").expect("revision");
    service
        .receive_file_event("steady", revision, "steady-1", variables("src/ok.ts"))
        .expect("steady");
    let actions = service.take_actions();
    assert_eq!(actions.len(), 1);
    let (id, input) = execute(&actions[0]);
    assert_eq!(sv(&input, "automationId"), Some("steady"));
    service
        .complete(&id, "succeeded", Some("thread"), Some("done"))
        .expect("finish");
}

#[test]
fn a_corrupted_count_cursor_parks_the_schedule_with_health_instead_of_hot_looping() {
    let h = Harness::new();
    let mut auto = scheduled("skip", 0);
    if let Trigger::Schedule { schedule } = &mut auto.trigger {
        schedule.expression = "FREQ=DAILY;COUNT=3".to_owned();
    }
    let mut service = h.started();
    service.put(&auto, None).expect("put");
    let raw = ace_store::Connection::open(
        h.path().to_str().expect("utf8"),
        ace_store::OpenOptions {
            read_only: false,
            timeout_ms: 5000,
        },
    )
    .expect("raw");
    raw.exec("UPDATE automation_state SET state='not json' WHERE id='triage'")
        .expect("corrupt");
    raw.close().expect("close");
    service.stop();
    service.start().expect("start");
    let job = h.store.metadata("triage").expect("get").expect("job");
    assert!(job.trigger_error.is_some());
    assert_eq!(job.due, None);
}

#[test]
fn idle_steps_drain_legacy_finish_times_in_bounded_batches() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    let raw = ace_store::Connection::open(
        h.path().to_str().expect("utf8"),
        ace_store::OpenOptions {
            read_only: false,
            timeout_ms: 5000,
        },
    )
    .expect("raw");
    for index in 0..3 {
        let finished = START + index * 1000;
        let body = format!(
            r#"{{"id":"legacy-{index}","automationId":"triage","title":"Triage","eventKey":"old-{index}","trigger":"manual","status":"succeeded","startedAt":{},"finishedAt":{finished},"result":"done"}}"#,
            START - 60_000
        );
        let statement = raw
            .prepare("INSERT INTO automation_runs(id,automation_id,event_key,status,body,input,finished_at) VALUES(?,?,?,?,?,NULL,NULL)")
            .expect("prepare");
        statement
            .bind(&[
                Some(ace_store::Value::Text(format!("legacy-{index}"))),
                Some(ace_store::Value::Text("triage".to_owned())),
                Some(ace_store::Value::Text(format!("old-{index}"))),
                Some(ace_store::Value::Text("succeeded".to_owned())),
                Some(ace_store::Value::Text(body)),
            ])
            .expect("bind");
        statement.step().expect("insert");
    }
    raw.close().expect("close");
    assert_eq!(service.idle_step(2).expect("first batch"), 2);
    assert_eq!(service.idle_step(2).expect("second batch"), 1);
    assert_eq!(service.idle_step(2).expect("drained"), 0);
    let (recent, _) = service
        .inbox(50, None, Some("triage"), Some(START + 500))
        .expect("inbox");
    assert_eq!(recent.len(), 2, "only runs finished after the cutoff stay");
    let (none, _) = service
        .inbox(50, None, Some("triage"), Some(START + 2500))
        .expect("inbox");
    assert!(
        none.is_empty(),
        "settled legacy runs leave the finished range"
    );
    assert_eq!(
        service
            .inbox(50, None, Some("triage"), None)
            .expect("all")
            .0
            .len(),
        3
    );
}

#[test]
fn a_file_retry_persists_the_new_failure_and_only_a_success_clears_it() {
    let h = Harness::new();
    h.workspace.fail.set(true);
    let mut service = h.started();
    let mut file = definition();
    file.trigger = Trigger::File {
        paths: vec!["src/**".to_owned()],
    };
    service.put(&file, None).expect("put");
    let metadata = h.store.metadata("triage").expect("meta").expect("job");
    assert_eq!(
        metadata
            .trigger_error
            .as_ref()
            .map(|error| error.message.as_str()),
        Some("Project folder unavailable")
    );
    assert!(service.retry("triage", None).is_err());
    h.workspace.fail.set(false);
    service.retry("triage", None).expect("healed");
    assert!(
        h.store
            .metadata("triage")
            .expect("meta")
            .expect("job")
            .trigger_error
            .is_none()
    );
    let revision = service.watch_revision("triage").expect("revision");
    service
        .receive_file_event("triage", revision, "after-retry", variables("src/main.ts"))
        .expect("event");
    assert_eq!(service.take_actions().len(), 1);
}

#[test]
fn a_due_github_automation_advances_before_io_and_reaches_the_one_timer() {
    let h = Harness::new();
    let mut service = h.started();
    let mut github = definition();
    github.trigger = Trigger::Github {
        repository: "user/project".to_owned(),
        event: "pr_changed".to_owned(),
        label: None,
        pull_request: None,
        poll_interval_ms: 60_000,
    };
    service.put(&github, None).expect("put");
    assert_eq!(service.arm_delay().expect("delay"), Some(0));
    assert!(service.tick().expect("tick").is_none());
    let actions = service.take_actions();
    assert!(matches!(actions.first(), Some(Action::PollGithub { .. })));
    assert_eq!(
        h.store
            .metadata("triage")
            .expect("meta")
            .and_then(|job| job.due),
        Some(START - 60_000 + 60_000)
    );
    assert_eq!(service.arm_delay().expect("delay"), Some(60_000));
}

#[test]
fn the_services_maintenance_call_heals_run_indexes() {
    let h = Harness::new();
    let mut service = h.started();
    let raw = ace_store::Connection::open(
        h.path().to_str().expect("utf8"),
        ace_store::OpenOptions {
            read_only: false,
            timeout_ms: 5000,
        },
    )
    .expect("raw");
    raw.exec("DROP INDEX IF EXISTS automation_finished")
        .expect("drop");
    raw.close().expect("close");
    assert_eq!(
        h.store.finished_index().expect("index"),
        ace_automations::store::FinishedIndex::Missing
    );
    service.maintenance().expect("maintenance");
    assert_eq!(
        h.store.finished_index().expect("index"),
        ace_automations::store::FinishedIndex::Current
    );
}

#[test]
fn a_populated_legacy_home_starts_its_running_and_queued_rows_and_idles_in_batches() {
    let h = Harness::new();
    let mut running = definition();
    running.id = "running-auto".to_owned();
    let mut queued = definition();
    queued.id = "queued-auto".to_owned();
    {
        let mut service = h.started();
        service.put(&running, None).expect("running");
        service.put(&queued, None).expect("queued");
    }
    let raw = ace_store::Connection::open(
        h.path().to_str().expect("utf8"),
        ace_store::OpenOptions {
            read_only: false,
            timeout_ms: 5000,
        },
    )
    .expect("raw");
    raw.exec("BEGIN IMMEDIATE").expect("begin");
    let insert = |id: &str, automation: &str, status: &str, finished: Option<i64>| {
        let body = finished.map_or_else(
            || format!(r#"{{"id":"{id}","automationId":"{automation}","status":"{status}"}}"#),
            |finished| {
                format!(
                    r#"{{"id":"{id}","automationId":"{automation}","status":"{status}","finishedAt":{finished}}}"#
                )
            },
        );
        let statement = raw
      .prepare("INSERT INTO automation_runs(id,automation_id,event_key,status,body,input,finished_at) VALUES(?,?,?,?,?,'{}',NULL)")
      .expect("prepare");
        statement
            .bind(&[
                Some(ace_store::Value::Text(id.to_owned())),
                Some(ace_store::Value::Text(automation.to_owned())),
                Some(ace_store::Value::Text(id.to_owned())),
                Some(ace_store::Value::Text(status.to_owned())),
                Some(ace_store::Value::Text(body)),
            ])
            .expect("bind");
        statement.step().expect("insert");
    };
    // Settled rows first: their finish times live only in their bodies, as the TypeScript left
    // them. The running and queued rows follow, with no finish time at all.
    for index in 0..4 {
        insert(
            &format!("settled-{index}"),
            "running-auto",
            "succeeded",
            Some(START + index * 1000),
        );
    }
    insert("legacy-running", "running-auto", "running", None);
    insert("legacy-queued", "queued-auto", "queued", None);
    raw.exec("COMMIT").expect("commit");
    raw.exec("DROP INDEX automation_status")
        .expect("drop status");
    raw.close().expect("close");

    let store = h.reopen();
    let mut service = h.service_on(&store);
    service.start().expect("start");
    let actions = service.take_actions();
    assert!(
        actions.iter().any(|action| matches!(
            action,
            Action::Recover { run_id, .. } if run_id == "legacy-running"
        )),
        "{actions:?}"
    );
    assert!(
        actions.iter().any(|action| matches!(
            action,
            Action::Execute { run_id, .. } if run_id == "legacy-queued"
        )),
        "{actions:?}"
    );

    // Idle heals the missing index and drains the legacy finish times in bounded batches.
    for _ in 0..4 {
        service.idle_step(2).expect("idle");
    }
    assert_eq!(service.idle_step(2).expect("drained"), 0);
    assert!(
        store.has_index("automation_status").expect("index"),
        "the missing status index heals once the file is small enough"
    );
    for _ in 0..3 {
        assert_eq!(service.idle_step(2).expect("idle"), 0);
        assert_eq!(store.idle_examined(), 0);
    }
    let (recent, _) = service
        .inbox(50, None, Some("running-auto"), Some(START + 500))
        .expect("inbox");
    assert_eq!(
        recent.len(),
        4,
        "three settled runs after the cutoff and the one still going stay"
    );
}

#[test]
fn a_failed_file_replacement_keeps_the_old_watcher_and_late_events_cannot_fire_the_new_one() {
    let h = Harness::new();
    let mut service = h.started();
    let mut file = definition();
    file.trigger = Trigger::File {
        paths: vec!["src/**".to_owned()],
    };
    service.put(&file, None).expect("first");
    let first_revision = service.watch_revision("triage").expect("watch");

    // The replacement's subscription fails: the stored definition and its watcher stay.
    h.workspace.fail.set(true);
    let mut replacement = file.clone();
    replacement.prompt = "Review {{subject}}".to_owned();
    if let Trigger::File { paths } = &mut replacement.trigger {
        paths.push("docs/**".to_owned());
    }
    assert!(service.put(&replacement, Some(Some(1))).is_err());
    assert_eq!(
        h.workspace.unsubscriptions.get(),
        0,
        "the working subscription is not dropped"
    );
    assert_eq!(service.watch_revision("triage"), Some(first_revision));

    // The old watcher still fires the definition that is actually stored.
    service
        .receive_file_event("triage", first_revision, "old-1", variables("src/a.ts"))
        .expect("old event");
    assert_eq!(input_prompt(&service.take_actions()[0]), "Triage src/a.ts");
    let runs = service
        .inbox(50, None, Some("triage"), None)
        .expect("inbox")
        .0;
    let running = runs
        .iter()
        .find(|run| sv(run, "status") == Some("running"))
        .expect("running");
    service
        .complete(&run_id(running), "succeeded", Some("thread"), Some("done"))
        .expect("finish");

    // The save now commits, the old subscription is released, and the new revision is current.
    h.workspace.fail.set(false);
    service
        .put(&replacement, Some(Some(1)))
        .expect("replacement");
    let new_revision = service.watch_revision("triage").expect("new watch");
    assert_ne!(new_revision, first_revision);
    assert_eq!(h.workspace.unsubscriptions.get(), 1);

    // A late event from the old watcher cannot fire the new definition.
    service
        .receive_file_event("triage", first_revision, "late", variables("src/late.ts"))
        .expect("late event");
    assert!(service.take_actions().is_empty());
    service
        .receive_file_event("triage", new_revision, "new-1", variables("src/new.ts"))
        .expect("new event");
    assert_eq!(
        input_prompt(&service.take_actions()[0]),
        "Review src/new.ts"
    );
}

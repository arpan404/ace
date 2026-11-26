// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
//! Ports the TypeScript cases from `packages/automations/src/`:
//! `queue`, `run-options`, `paused`, `admission`, `revision`, `service`, `monitoring`,
//! `startup`, `lifecycle`, `trigger-readiness`, `cas`, `jitter` and `metadata` where they are
//! service-level.

mod support;

use std::collections::BTreeMap;

use ace_automations::service::{Action, Ports, Service};
use ace_automations::{Definition, Trigger};
use ace_json::Value;
use support::*;

// queue.test.ts

#[test]
fn a_run_fired_while_the_last_one_works_waits_then_starts_when_it_finishes() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    let first = service
        .trigger("triage", "first", variables("first"), "manual", None)
        .expect("first");
    assert_eq!(run_status(&first), "running");
    let second = service
        .trigger("triage", "second", variables("second"), "manual", None)
        .expect("second");
    assert_eq!(run_status(&second), "queued");
    let third = service
        .trigger("triage", "third", variables("third"), "manual", None)
        .expect("third");
    assert_eq!(run_status(&third), "skipped");
    assert_eq!(sv(&third, "result"), Some("A run was already waiting"));
    let actions = service.take_actions();
    assert_eq!(actions.len(), 1);
    let (id, _) = execute(&actions[0]);
    service
        .complete(&id, "succeeded", Some("thread"), Some("Done"))
        .expect("finish");
    let actions = service.take_actions();
    assert_eq!(actions.len(), 1);
    assert_eq!(input_prompt(&actions[0]), "Triage second");
    let runs = service
        .inbox(50, None, Some("triage"), None)
        .expect("inbox")
        .0;
    let keys: Vec<&str> = runs.iter().filter_map(|run| sv(run, "eventKey")).collect();
    assert_eq!(keys, vec!["third", "second", "first"]);
}

#[test]
fn a_waiting_run_survives_a_restart_and_starts_after_the_run_it_waited_for() {
    let h = Harness::new();
    {
        let mut service = h.started();
        service.put(&definition(), None).expect("put");
        service
            .trigger("triage", "first", variables("first"), "manual", None)
            .expect("first");
        service
            .trigger("triage", "second", variables("second"), "manual", None)
            .expect("second");
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
            model_hold_ms: None,
            model_retry_ms: None,
        },
    );
    service.start().expect("start");
    let actions = service.take_actions();
    assert!(matches!(actions.first(), Some(Action::Recover { .. })));
    let first = match &actions[0] {
        Action::Recover { run_id, .. } => run_id.clone(),
        _ => unreachable!(),
    };
    service
        .complete(&first, "succeeded", Some("thread"), Some("Done"))
        .expect("finish");
    let actions = service.take_actions();
    assert_eq!(input_prompt(&actions[0]), "Triage second");
}

#[test]
fn pausing_skips_the_waiting_run_and_stops_the_one_in_progress() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    service
        .trigger("triage", "first", variables("first"), "manual", None)
        .expect("first");
    service
        .trigger("triage", "second", variables("second"), "manual", None)
        .expect("second");
    service.take_actions();
    service.set_enabled("triage", false, None).expect("pause");
    let actions = service.take_actions();
    assert!(matches!(actions.first(), Some(Action::Interrupt { .. })));
    assert_eq!(input_prompt(&actions[0]), "Triage first");
    let runs = service
        .inbox(50, None, Some("triage"), None)
        .expect("inbox")
        .0;
    let pairs: Vec<(String, String)> = runs
        .iter()
        .map(|run| {
            (
                sv(run, "status").unwrap_or("").to_owned(),
                sv(run, "result").unwrap_or("").to_owned(),
            )
        })
        .collect();
    assert_eq!(
        pairs,
        vec![
            ("skipped".to_owned(), "Paused before it started".to_owned()),
            ("running".to_owned(), "".to_owned())
        ]
    );
}

#[test]
fn deleting_an_automation_stops_its_work_the_same_way() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    service
        .trigger("triage", "first", variables("first"), "manual", None)
        .expect("first");
    service
        .trigger("triage", "second", variables("second"), "manual", None)
        .expect("second");
    service.remove("triage", None).expect("remove");
    let runs = service
        .inbox(50, None, Some("triage"), None)
        .expect("inbox")
        .0;
    assert_eq!(sv(&runs[0], "status"), Some("skipped"));
    assert_eq!(sv(&runs[0], "result"), Some("Deleted before it started"));
    assert!(
        service
            .take_actions()
            .iter()
            .any(|action| matches!(action, Action::Interrupt { .. }))
    );
}

// run-options.test.ts

#[test]
fn a_run_starts_on_the_automations_effort_and_account() {
    let h = Harness::new();
    let mut service = h.started();
    let mut auto = definition();
    auto.effort = Some("high".to_owned());
    auto.instance = Some("codex_work".to_owned());
    service.put(&auto, None).expect("put");
    service
        .trigger("triage", "start", variables("issues"), "manual", None)
        .expect("run");
    let (_, input) = execute(&service.take_actions()[0]);
    assert_eq!(sv(&input, "model"), Some("test-model"));
    assert_eq!(sv(&input, "effort"), Some("high"));
    assert_eq!(sv(&input, "instance"), Some("codex_work"));
}

#[test]
fn a_run_without_effort_or_account_leaves_both_to_the_providers_defaults() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    service
        .trigger("triage", "start", variables("issues"), "manual", None)
        .expect("run");
    let (_, input) = execute(&service.take_actions()[0]);
    assert!(input.get("effort").is_none());
    assert!(input.get("instance").is_none());
}

#[test]
fn a_run_note_follows_the_saved_prompt_after_a_blank_line() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    service
        .trigger(
            "triage",
            "noted",
            variables("issues"),
            "manual",
            Some("Only look at the checkout flow"),
        )
        .expect("run");
    assert_eq!(
        input_prompt(&service.take_actions()[0]),
        "Triage issues\n\nOnly look at the checkout flow"
    );
}

#[test]
fn a_note_is_taken_as_written_without_filling_trigger_variables() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    service
        .trigger(
            "triage",
            "literal",
            variables("issues"),
            "manual",
            Some("Leave {{subject}} alone"),
        )
        .expect("run");
    assert_eq!(
        input_prompt(&service.take_actions()[0]),
        "Triage issues\n\nLeave {{subject}} alone"
    );
}

#[test]
fn a_retried_noted_run_with_the_same_request_id_starts_once() {
    let h = Harness::new();
    let mut service = h.started();
    let mut auto = definition();
    auto.concurrency = 4;
    service.put(&auto, None).expect("put");
    let request = |message: &str| {
        let mut request = ace_json::Map::new();
        request.insert("type", Value::String("automation.run".into()));
        request.insert("requestId", Value::String("same-intent".into()));
        request.insert("id", Value::String("triage".into()));
        request.insert("variables", json(r#"{ "subject": "issues" }"#));
        request.insert("message", Value::String(message.into()));
        Value::Object(request)
    };
    let first = service.handle(&request("First note"));
    let retry = service.handle(&request("First note"));
    assert_eq!(
        sv(at(&first, "run").expect("run"), "id"),
        sv(at(&retry, "run").expect("run"), "id")
    );
    assert_eq!(service.take_actions().len(), 1);
}

#[test]
fn a_note_that_would_push_the_prompt_past_the_message_limit_fails_the_run() {
    let h = Harness::new();
    let mut service = h.started();
    let mut auto = definition();
    auto.prompt = "x".repeat(256 * 1024 - 4);
    service.put(&auto, None).expect("put");
    let run = service
        .trigger(
            "triage",
            "too-long",
            variables("issues"),
            "manual",
            Some("longer"),
        )
        .expect("run");
    assert_eq!(run_status(&run), "failed");
    assert!(service.take_actions().is_empty());
}

// paused.test.ts

#[test]
fn run_now_while_new_work_is_paused_is_refused_and_starts_nothing() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    h.admission.open.set(false);
    let response = service.handle(&json(
        r#"{
    "type": "automation.run",
    "requestId": "now",
    "id": "triage",
    "variables": { "subject": "bugs" }
  }"#,
    ));
    assert_eq!(bv(&response, "ok"), Some(false));
    assert_eq!(
        sv(&response, "error"),
        Some("New work is paused. Resume new work in ace to continue.")
    );
    assert!(service.take_actions().is_empty());
    let runs = service
        .inbox(50, None, Some("triage"), None)
        .expect("inbox")
        .0;
    assert!(runs.is_empty());
}

#[test]
fn a_run_waiting_behind_one_still_going_stays_waiting_while_paused_and_starts_on_resume() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    service
        .trigger("triage", "first", variables("one"), "manual", None)
        .expect("first");
    service
        .trigger("triage", "second", variables("two"), "manual", None)
        .expect("second");
    h.admission.open.set(false);
    let ids: Vec<String> = service
        .take_actions()
        .iter()
        .map(|action| execute(action).0)
        .collect();
    service
        .complete(&ids[0], "succeeded", Some("thread"), Some("done"))
        .expect("finish");
    let runs = service
        .inbox(50, None, Some("triage"), None)
        .expect("inbox")
        .0;
    assert_eq!(sv(&runs[0], "status"), Some("queued"));
    assert_eq!(sv(&runs[1], "status"), Some("succeeded"));
    assert!(service.take_actions().is_empty());
    h.admission.open.set(true);
    service.drain_waiting();
    let actions = service.take_actions();
    assert_eq!(input_prompt(&actions[0]), "Triage two");
}

// admission.test.ts

#[test]
fn rejects_invalid_trigger_keys_before_recording_or_executing_a_run() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    let error = service
        .trigger("triage", "", variables("issues"), "manual", None)
        .expect_err("empty key");
    assert!(!error.to_string().is_empty());
    assert!(
        service
            .inbox(50, None, None, None)
            .expect("inbox")
            .0
            .is_empty()
    );
    assert!(service.take_actions().is_empty());
}

#[test]
fn a_waiting_run_held_by_the_running_limit_starts_once_room_frees_anywhere() {
    let h = Harness::new();
    let mut service = h.started();
    for index in 0..257 {
        let mut auto = definition();
        auto.id = format!("job-{index}");
        service.put(&auto, None).expect("put");
    }
    for index in 0..256 {
        let run = service
            .trigger(
                &format!("job-{index}"),
                "event",
                variables("issues"),
                "manual",
                None,
            )
            .expect("run");
        assert_eq!(run_status(&run), "running");
    }
    let overflow = service
        .trigger("job-256", "overflow", variables("issues"), "manual", None)
        .expect("run");
    assert_eq!(run_status(&overflow), "skipped");
    assert_eq!(service.take_actions().len(), 256);
    let ids: Vec<String> = service
        .inbox(50, None, Some("job-0"), None)
        .expect("inbox")
        .0
        .iter()
        .map(run_id)
        .collect();
    service
        .complete(&ids[0], "succeeded", Some("thread"), Some("done"))
        .expect("finish");
    assert_eq!(service.take_actions().len(), 0);
}

// revision.test.ts and cas.test.ts through the service envelopes

#[test]
fn list_schedules_expose_the_durable_revision_for_cas_clients() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    let listed = service.handle(&json(
        r#"{
    "type": "automation.list",
    "requestId": "revisions"
  }"#,
    ));
    assert_eq!(iv(&listed["schedules"][0], "revision"), Some(1));
    service.set_enabled("triage", false, None).expect("disable");
    let listed = service.handle(&json(
        r#"{
    "type": "automation.list",
    "requestId": "revisions-2"
  }"#,
    ));
    assert_eq!(iv(&arr(&listed, "schedules")[0], "revision"), Some(2));
}

#[test]
fn identical_puts_with_a_matching_revision_stay_idempotent_without_bumping() {
    let h = Harness::new();
    let mut service = h.started();
    let auto = scheduled("run_once", 10_000);
    h.random.0.set(0.5);
    service.put(&auto, None).expect("put");
    h.random.0.set(0.9);
    service.put(&auto, Some(Some(1))).expect("identical");
    assert_eq!(h.store.revision("triage").expect("revision"), Some(1));
    assert_eq!(
        h.store
            .metadata("triage")
            .expect("metadata")
            .and_then(|job| job.due),
        Some(START + 5000)
    );
}

#[test]
fn create_only_puts_fail_while_the_id_is_live_and_succeed_after_removal() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    let error = service.put(&definition(), Some(None)).expect_err("live");
    assert_eq!(error.to_string(), "Automation already exists");
    service.remove("triage", None).expect("remove");
    service.put(&definition(), Some(None)).expect("recreate");
}

#[test]
fn a_stale_revision_cannot_resurrect_a_removed_id_while_blind_writes_can() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    assert_eq!(h.store.revision("triage").expect("revision"), Some(1));
    service.remove("triage", None).expect("remove");
    assert_eq!(h.store.revision("triage").expect("revision"), Some(2));
    let error = service
        .put(&definition(), Some(Some(1)))
        .expect_err("stale");
    assert_eq!(error.to_string(), "Automation is missing");
    service.put(&definition(), None).expect("blind");
    assert_eq!(h.store.revision("triage").expect("revision"), Some(3));
}

// service.test.ts

#[test]
fn fills_trigger_variables_and_persists_a_successful_result_with_its_thread() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    let run = service
        .trigger(
            "triage",
            "manual:1",
            variables("new issues"),
            "manual",
            None,
        )
        .expect("run");
    let (id, input) = execute(&service.take_actions()[0]);
    assert_eq!(id, run_id(&run));
    assert_eq!(sv(&input, "prompt"), Some("Triage new issues"));
    assert_eq!(sv(&input, "title"), Some("Triage"));
    service
        .complete(
            &id,
            "succeeded",
            Some("thread-0"),
            Some("Reviewed three issues"),
        )
        .expect("finish");
    let runs = service.inbox(50, None, None, None).expect("inbox").0;
    assert_eq!(sv(&runs[0], "status"), Some("succeeded"));
    assert_eq!(sv(&runs[0], "threadId"), Some("thread-0"));
    assert_eq!(iv(&runs[0], "finishedAt"), Some(START - 60_000));
}

#[test]
fn deduplicates_repeated_events_even_after_restart() {
    let h = Harness::new();
    {
        let mut service = h.started();
        service.put(&definition(), None).expect("put");
        let run = service
            .trigger(
                "triage",
                "github:42:v1",
                variables("CI failure"),
                "github",
                None,
            )
            .expect("run");
        let id = run_id(&run);
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
            model_hold_ms: None,
            model_retry_ms: None,
        },
    );
    service.start().expect("start");
    let again = service
        .trigger(
            "triage",
            "github:42:v1",
            variables("CI failure"),
            "github",
            None,
        )
        .expect("repeat");
    assert_eq!(run_status(&again), "succeeded");
    assert!(service.take_actions().is_empty());
}

#[test]
fn runs_one_at_a_time_even_when_a_stored_definition_asks_for_more() {
    let h = Harness::new();
    let mut service = h.started();
    let mut auto = definition();
    auto.concurrency = 4;
    service.put(&auto, None).expect("put");
    for index in 0..3 {
        service
            .trigger(
                "triage",
                &format!("event-{index}"),
                variables("review"),
                "manual",
                None,
            )
            .expect("run");
    }
    let runs = service.inbox(50, None, None, None).expect("inbox").0;
    let statuses: Vec<&str> = runs.iter().filter_map(|run| sv(run, "status")).collect();
    assert_eq!(statuses, vec!["skipped", "queued", "running"]);
    assert_eq!(service.take_actions().len(), 1);
}

#[test]
fn records_a_missing_template_variable_as_failure_without_creating_a_thread() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    let run = service
        .trigger("triage", "missing", BTreeMap::new(), "manual", None)
        .expect("run");
    assert_eq!(run_status(&run), "failed");
    assert_eq!(
        sv(&run, "result"),
        Some("Missing trigger variable: subject")
    );
    assert!(service.take_actions().is_empty());
}

#[test]
fn records_executor_failures_rather_than_treating_acceptance_as_completion() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    service
        .trigger("triage", "failure", variables("issues"), "manual", None)
        .expect("run");
    let (id, _) = execute(&service.take_actions()[0]);
    service
        .complete(&id, "failed", Some("thread"), Some("Reviewed three issues"))
        .expect("finish");
    let runs = service.inbox(50, None, None, None).expect("inbox").0;
    assert_eq!(sv(&runs[0], "status"), Some("failed"));
    assert_eq!(sv(&runs[0], "result"), Some("Reviewed three issues"));
}

#[test]
fn pages_the_scheduled_inbox_without_repeating_rows() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    for index in 0..5 {
        service
            .trigger(
                "triage",
                &format!("bad-{index}"),
                BTreeMap::new(),
                "manual",
                None,
            )
            .expect("run");
    }
    let (first, before) = service.inbox(2, None, None, None).expect("inbox");
    assert_eq!(
        first
            .iter()
            .filter_map(|run| sv(run, "eventKey"))
            .collect::<Vec<_>>(),
        vec!["bad-4", "bad-3"]
    );
    let (second, before) = service.inbox(2, before, None, None).expect("inbox");
    assert_eq!(
        second
            .iter()
            .filter_map(|run| sv(run, "eventKey"))
            .collect::<Vec<_>>(),
        vec!["bad-2", "bad-1"]
    );
    let (third, after) = service.inbox(2, before, None, None).expect("inbox");
    assert_eq!(sv(&third[0], "eventKey"), Some("bad-0"));
    assert!(after.is_none());
}

#[test]
fn subscribes_file_changes_through_the_workspace_contract_and_deduplicates_delivery() {
    let h = Harness::new();
    let mut service = h.started();
    service
        .put(
            &Definition {
                trigger: Trigger::File {
                    paths: vec!["src/**".to_owned()],
                },
                ..definition()
            },
            None,
        )
        .expect("put");
    assert_eq!(h.workspace.subscriptions.borrow().as_slice(), ["/project"]);
    let revision = service.watch_revision("triage").expect("revision");
    service
        .receive_file_event("triage", revision, "change:1", variables("src/main.ts"))
        .expect("event");
    service
        .receive_file_event("triage", revision, "change:1", variables("src/main.ts"))
        .expect("repeat");
    assert_eq!(service.take_actions().len(), 1);
    let runs = service.inbox(50, None, None, None).expect("inbox").0;
    assert_eq!(sv(&runs[0], "trigger"), Some("file"));
    service.remove("triage", None).expect("remove");
    assert_eq!(h.workspace.unsubscriptions.get(), 1);
}

#[test]
fn manual_wire_requests_reuse_their_request_id_as_a_durable_event_key() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    let request = json(
        r#"{
    "type": "automation.run",
    "requestId": "run-now",
    "id": "triage",
    "variables": { "subject": "issues" }
  }"#,
    );
    let first = service.handle(&request);
    assert_eq!(
        sv(at(&first, "run").expect("nested"), "status"),
        Some("running")
    );
    assert_eq!(bv(&service.handle(&request), "ok"), Some(true));
    assert_eq!(service.take_actions().len(), 1);
    service.set_enabled("triage", false, None).expect("disable");
    let disabled = service.handle(&json(
        r#"{
    "type": "automation.run",
    "requestId": "disabled",
    "id": "triage",
    "variables": { "subject": "issues" }
  }"#,
    ));
    assert_eq!(bv(&disabled, "ok"), Some(false));
}

#[test]
fn persists_count_progress_and_stops_at_the_limit_after_a_restart() {
    let h = Harness::new();
    let mut auto = scheduled("run_once", 0);
    if let Trigger::Schedule { schedule } = &mut auto.trigger {
        schedule.expression = "FREQ=DAILY;COUNT=3".to_owned();
    }
    {
        let mut service = h.started();
        service.put(&auto, None).expect("put");
        h.clock.0.set(START);
        assert!(service.tick().expect("tick").is_some());
        let (id, _) = execute(&service.take_actions()[0]);
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
            model_hold_ms: None,
            model_retry_ms: None,
        },
    );
    service.start().expect("start");
    h.clock.0.set(START + DAY);
    assert!(service.tick().expect("tick").is_some());
    let (id, _) = execute(&service.take_actions()[0]);
    service
        .complete(&id, "succeeded", Some("thread"), Some("done"))
        .expect("finish");
    h.clock.0.set(START + 2 * DAY);
    assert!(service.tick().expect("tick").is_some());
    let (id, _) = execute(&service.take_actions()[0]);
    service
        .complete(&id, "succeeded", Some("thread"), Some("done"))
        .expect("finish");
    h.clock.0.set(START + 3 * DAY);
    assert!(service.tick().expect("tick").is_none());
    assert_eq!(
        service.inbox(50, None, None, None).expect("inbox").0.len(),
        3
    );
}

#[test]
fn counts_skipped_downtime_occurrences_toward_count() {
    let h = Harness::new();
    let mut auto = scheduled("skip", 0);
    if let Trigger::Schedule { schedule } = &mut auto.trigger {
        schedule.expression = "FREQ=DAILY;COUNT=3".to_owned();
    }
    let mut service = h.started();
    service.put(&auto, None).expect("put");
    h.clock.0.set(START + 5 * DAY);
    service.stop();
    service.start().expect("restart");
    assert!(service.arm_delay().expect("delay").is_none());
    assert!(
        service
            .inbox(50, None, None, None)
            .expect("inbox")
            .0
            .is_empty()
    );
}

#[test]
fn treats_trigger_text_as_literal_content_rather_than_another_template() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    service
        .trigger(
            "triage",
            "literal",
            variables("{{other}} $(not-a-command)"),
            "manual",
            None,
        )
        .expect("run");
    assert_eq!(
        input_prompt(&service.take_actions()[0]),
        "Triage {{other}} $(not-a-command)"
    );
}

// monitoring.test.ts

#[test]
fn history_filters_before_paging_and_tied_timestamps_leave_no_skipped_or_duplicate_runs() {
    let h = Harness::new();
    let mut service = h.started();
    let mut quiet = definition();
    quiet.prompt = "Review".to_owned();
    service.put(&quiet, None).expect("put");
    let mut busy = definition();
    busy.id = "busy".to_owned();
    busy.prompt = "Review".to_owned();
    service.put(&busy, None).expect("put");
    for index in 0..55 {
        service
            .trigger(
                "triage",
                &format!("quiet-{index}"),
                BTreeMap::new(),
                "manual",
                None,
            )
            .expect("run");
        let (id, _) = execute(&service.take_actions()[0]);
        service
            .complete(&id, "succeeded", Some("thread"), Some("done"))
            .expect("finish");
    }
    for index in 0..55 {
        service
            .trigger(
                "busy",
                &format!("busy-{index}"),
                BTreeMap::new(),
                "manual",
                None,
            )
            .expect("run");
        let (id, _) = execute(&service.take_actions()[0]);
        service
            .complete(&id, "succeeded", Some("thread"), Some("done"))
            .expect("finish");
    }
    let (first, before) = service
        .inbox(50, None, Some("triage"), None)
        .expect("inbox");
    assert_eq!(first.len(), 50);
    let (older, next) = service
        .inbox(50, before, Some("triage"), None)
        .expect("inbox");
    assert_eq!(
        older
            .iter()
            .filter_map(|run| sv(run, "eventKey"))
            .collect::<Vec<_>>(),
        vec!["quiet-4", "quiet-3", "quiet-2", "quiet-1", "quiet-0"]
    );
    assert!(next.is_none());
}

#[test]
fn the_inbox_can_leave_out_runs_that_finished_by_a_time_keeping_runs_still_going() {
    let h = Harness::new();
    let mut service = h.started();
    let mut quiet = definition();
    quiet.prompt = "Review".to_owned();
    service.put(&quiet, None).expect("put");
    let mut long = definition();
    long.id = "long".to_owned();
    long.prompt = "Review".to_owned();
    service.put(&long, None).expect("put");
    service
        .trigger("long", "long-0", BTreeMap::new(), "manual", None)
        .expect("long");
    let long_id = match &service.take_actions()[0] {
        Action::Execute { run_id, .. } => run_id.clone(),
        _ => unreachable!(),
    };
    for index in 0..3 {
        service
            .trigger(
                "triage",
                &format!("short-{index}"),
                BTreeMap::new(),
                "manual",
                None,
            )
            .expect("run");
        let (id, _) = execute(&service.take_actions()[0]);
        h.clock.0.set(START + index * 1000);
        service
            .complete(&id, "succeeded", Some("thread"), Some("done"))
            .expect("finish");
    }
    let (runs, _) = service
        .inbox(50, None, None, Some(START + 500))
        .expect("inbox");
    assert_eq!(
        runs.iter()
            .filter_map(|run| sv(run, "eventKey"))
            .collect::<Vec<_>>(),
        vec!["short-2", "short-1", "long-0"]
    );
    h.clock.0.set(START + 5000);
    service
        .complete(&long_id, "succeeded", Some("thread"), Some("done"))
        .expect("finish");
    let (runs, _) = service
        .inbox(50, None, None, Some(START + 2000))
        .expect("inbox");
    assert_eq!(sv(&runs[0], "eventKey"), Some("long-0"));
}

// trigger-readiness.test.ts

#[test]
fn editing_a_failed_file_trigger_retains_its_error_until_the_replacement_watcher_is_ready() {
    let h = Harness::new();
    h.workspace.fail.set(true);
    let mut service = h.started();
    let automation = Definition {
        trigger: Trigger::File {
            paths: vec!["src/**".to_owned()],
        },
        ..definition()
    };
    service.put(&automation, None).expect("put");
    fn list(service: &mut Service<'_>) -> Value {
        service.handle(&json(
            r#"{
      "type": "automation.list",
      "requestId": "health"
    }"#,
        ))
    }
    let listed = list(&mut service);
    let schedule = &arr(&listed, "schedules")[0];
    assert_eq!(
        sv(at(schedule, "triggerError").expect("error"), "message"),
        Some("Project folder unavailable")
    );
    h.workspace.fail.set(false);
    service
        .watch_ready("triage", 1)
        .expect("stale readiness is ignored");
    assert!(at(&arr(&list(&mut service), "schedules")[0], "triggerError").is_some());
    service.put(&automation, None).expect("identical put");
    let revision = service.watch_revision("triage").expect("watch revision");
    service.watch_ready("triage", revision).expect("ready");
    assert!(at(&arr(&list(&mut service), "schedules")[0], "triggerError").is_none());
}

// lifecycle.test.ts and monitoring stop/start cases

#[test]
fn stopping_abandons_pending_work_and_start_recovers_it_once() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    service
        .trigger("triage", "first", variables("issues"), "manual", None)
        .expect("run");
    let (id, _) = execute(&service.take_actions()[0]);
    service.stop();
    let error = service
        .trigger("triage", "during-stop", variables("issues"), "manual", None)
        .expect_err("stopped");
    assert_eq!(error.to_string(), "Automation service is stopped");
    service.start().expect("restart");
    let actions = service.take_actions();
    assert!(matches!(actions.first(), Some(Action::Recover { run_id, .. }) if run_id == &id));
    service
        .complete(&id, "succeeded", Some("recovered"), Some("recovered"))
        .expect("finish");
    let runs = service.inbox(50, None, None, None).expect("inbox").0;
    assert_eq!(sv(&runs[0], "status"), Some("succeeded"));
    assert_eq!(sv(&runs[0], "threadId"), Some("recovered"));
    service.stop();
    assert!(service.take_actions().is_empty());
}

#[test]
fn retrying_creation_with_the_same_idempotency_key_when_a_crash_preceded_thread_creation() {
    let h = Harness::new();
    let run_id = {
        let mut service = h.started();
        service.put(&definition(), None).expect("put");
        let run = service
            .trigger("triage", "crash", variables("issues"), "manual", None)
            .expect("run");
        run_id(&run)
    };
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
            model_hold_ms: None,
            model_retry_ms: None,
        },
    );
    service.start().expect("restart");
    assert!(matches!(
        service.take_actions().first(),
        Some(Action::Recover { .. })
    ));
    service.recovery_empty(&run_id).expect("nothing sent");
    let actions = service.take_actions();
    let (sent_id, input) = execute(&actions[0]);
    assert_eq!(sent_id, run_id);
    assert_eq!(sv(&input, "idempotencyKey"), Some(run_id.as_str()));
}

#[test]
fn a_run_that_would_start_in_a_stopped_service_is_never_sent() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    service.stop();
    assert!(service.take_actions().is_empty());
    assert!(
        service
            .trigger("triage", "x", variables("issues"), "manual", None)
            .is_err()
    );
}

#[test]
fn fixed_inputs_are_the_ports_contract_for_a_manual_run() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    service
        .trigger("triage", "shape", variables("issues"), "manual", None)
        .expect("run");
    let (_, input) = execute(&service.take_actions()[0]);
    let keys: Vec<String> = input
        .as_object()
        .expect("object")
        .keys()
        .map(|key| key.to_string())
        .collect();
    let keys: Vec<&str> = keys.iter().map(String::as_str).collect();
    assert_eq!(
        keys,
        vec![
            "idempotencyKey",
            "automationId",
            "title",
            "provider",
            "workspace",
            "worktree",
            "prompt",
            "model"
        ]
    );
}

#[test]
fn the_clock_drives_finished_and_started_times() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    let run = service
        .trigger("triage", "clock", variables("issues"), "manual", None)
        .expect("run");
    assert_eq!(iv(&run, "startedAt"), Some(START - 60_000));
    let (id, _) = execute(&service.take_actions()[0]);
    h.clock.0.set(START + 7000);
    service
        .complete(&id, "succeeded", Some("thread"), Some("done"))
        .expect("finish");
    let runs = service.inbox(50, None, None, None).expect("inbox").0;
    assert_eq!(iv(&runs[0], "finishedAt"), Some(START + 7000));
}

// store.ts:92 migration and ADR 0170: a TS-shaped row with no finish column yet is backfilled
// from its body in bounded batches after open, never as history-sized work inside open.
#[test]
fn backfills_finished_at_from_ts_shaped_run_bodies_in_bounded_batches() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    service
        .trigger("triage", "old-0", variables("issues"), "manual", None)
        .expect("run");
    let (id, _) = execute(&service.take_actions()[0]);
    h.clock.0.set(START);
    service
        .complete(&id, "succeeded", Some("thread"), Some("done"))
        .expect("finish");
    service.take_actions();
    drop(service);

    // The store as a build older than the column left it, and as TS sees it: the body has
    // finishedAt while the column is null.
    let raw = ace_store::Connection::open(
        h.path().to_str().expect("utf8"),
        ace_store::OpenOptions {
            read_only: false,
            timeout_ms: 5000,
        },
    )
    .expect("raw");
    raw.exec("UPDATE automation_runs SET finished_at=NULL")
        .expect("old row");
    raw.close().expect("close");

    let store = h.reopen();
    assert_eq!(store.backfill_finished_at(1).expect("batch"), 1);
    assert_eq!(store.backfill_finished_at(1).expect("done"), 0);
    let (runs, _) = store.inbox(50, None, None, Some(START)).expect("inbox");
    assert!(
        runs.is_empty(),
        "settled runs leave the finishedAfter range"
    );
    assert_eq!(store.inbox(50, None, None, None).expect("inbox").0.len(), 1);
}

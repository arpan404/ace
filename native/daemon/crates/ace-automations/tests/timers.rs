// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
//! Ports `cancellation.test.ts`, `teardown.test.ts`, the timer cases of `polish.test.ts` and the
//! re-entrant `onRun` case of `admission.test.ts` behind the injected timer port.

mod support;

use ace_automations::service::Action;
use ace_automations::{Schedule, ScheduleKind, Trigger};
use support::*;

const START: i64 = 1_704_099_600_000;

fn interrupts(actions: &[Action]) -> Vec<String> {
    actions
        .iter()
        .filter_map(|action| match action {
            Action::Interrupt { run_id, .. } => Some(run_id.clone()),
            _ => None,
        })
        .collect()
}

fn recovers(actions: &[Action]) -> Vec<String> {
    actions
        .iter()
        .filter_map(|action| match action {
            Action::Recover { run_id, .. } => Some(run_id.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn a_failed_interrupt_is_tried_again_on_the_timer_and_ends_with_the_run() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    let run = service
        .trigger("triage", "first", variables("first"), "manual", None)
        .expect("run");
    let run_id = sv(&run, "id").expect("id").to_owned();
    let (executed, _) = execute(&service.take_actions()[0]);
    assert_eq!(executed, run_id);
    service.set_enabled("triage", false, None).expect("pause");
    assert_eq!(interrupts(&service.take_actions()), vec![run_id.clone()]);

    service.interrupt_failed(&run_id, "Executor unavailable");
    assert_eq!(service.armed_delay(), Some(1000));
    assert_eq!(
        service.take_errors(),
        vec!["Executor unavailable".to_owned()]
    );

    h.clock.0.set(START - 60_000 + 1000);
    service.timer_fired().expect("timer");
    assert_eq!(interrupts(&service.take_actions()), vec![run_id.clone()]);
    service
        .complete(
            &run_id,
            "failed",
            Some("thread-0"),
            Some("Stopped before it finished."),
        )
        .expect("finish");
    assert!(service.take_actions().is_empty());

    // A finished run's cancellation is done with: a restart sends no stop.
    service.stop();
    service.start().expect("restart");
    assert!(interrupts(&service.take_actions()).is_empty());
}

#[test]
fn a_pause_whose_stop_never_reached_the_executor_stops_the_run_unsent_after_restart() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    let run = service
        .trigger("triage", "first", variables("first"), "manual", None)
        .expect("run");
    let run_id = sv(&run, "id").expect("id").to_owned();
    service.take_actions();
    service.set_enabled("triage", false, None).expect("pause");
    service.take_actions();
    service.interrupt_failed(&run_id, "Executor unavailable");
    service.stop();

    service.start().expect("restart");
    let actions = service.take_actions();
    assert_eq!(recovers(&actions), vec![run_id.clone()]);
    assert_eq!(interrupts(&actions), vec![run_id.clone()]);
    // Nothing of the run reached its thread, so recovery finds nothing and stops it unsent.
    service.recovery_empty(&run_id).expect("recovery");
    let run = service
        .inbox(50, None, Some("triage"), None)
        .expect("inbox")
        .0
        .into_iter()
        .find(|run| sv(run, "id") == Some(run_id.as_str()))
        .expect("run");
    assert_eq!(sv(&run, "status"), Some("failed"));
    assert_eq!(sv(&run, "result"), Some("Stopped before it started."));
}

#[test]
fn a_timer_that_cannot_be_armed_is_reported_and_nothing_is_unhandled() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    let run = service
        .trigger("triage", "first", variables("first"), "manual", None)
        .expect("run");
    let run_id = sv(&run, "id").expect("id").to_owned();
    service.take_actions();
    service.set_enabled("triage", false, None).expect("pause");
    service.take_actions();
    h.timer.fail_arm.set(true);
    service.interrupt_failed(&run_id, "Executor unavailable");
    assert!(
        service
            .take_errors()
            .iter()
            .any(|error| error == "database is locked")
    );
    assert_eq!(service.armed_delay(), None);
}

#[test]
fn stopping_releases_watchers_when_timer_cancellation_throws_and_re_enters_cleanly() {
    let h = Harness::new();
    let mut service = h.started();
    let mut file = definition();
    file.id = "watch".to_owned();
    file.trigger = Trigger::File {
        paths: vec!["src/**".to_owned()],
    };
    service.put(&file, None).expect("file");
    let mut scheduled = definition();
    scheduled.trigger = Trigger::Schedule {
        schedule: Schedule {
            kind: ScheduleKind::Rrule,
            expression: "FREQ=DAILY".to_owned(),
            timezone: "UTC".to_owned(),
            start_at: START,
        },
    };
    assert_eq!(h.workspace.unsubscriptions.get(), 0, "after file put");
    service.put(&scheduled, None).expect("schedule");
    assert_eq!(h.workspace.unsubscriptions.get(), 0, "after schedule put");
    assert_eq!(h.workspace.subscriptions.borrow().len(), 1);
    assert!(h.timer.delay.get().is_some());
    h.timer.fail_cancel.set(true);
    service.stop();
    assert_eq!(
        service.take_errors(),
        vec!["timer cancellation failed".to_owned()]
    );
    assert_eq!(h.workspace.unsubscriptions.get(), 1);
    assert_eq!(h.timer.delay.get(), None);
    let error = service
        .trigger("watch", "stopped", variables("issues"), "manual", None)
        .expect_err("stopped");
    assert_eq!(error.to_string(), "Automation service is stopped");

    // The host reports the queued error and re-enters start/stop; resources still settle.
    service.start().expect("restart");
    assert!(h.timer.delay.get().is_some());
    assert_eq!(h.workspace.unsubscriptions.get(), 1);
    service.stop();
    assert_eq!(h.workspace.unsubscriptions.get(), 2);
    assert!(service.take_errors().is_empty());
}

#[test]
fn repeated_stop_and_start_keeps_one_recovery_per_run_and_no_duplicate_launch() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    let run = service
        .trigger("triage", "once", variables("issues"), "manual", None)
        .expect("run");
    let run_id = sv(&run, "id").expect("id").to_owned();
    let (launched, _) = execute(&service.take_actions()[0]);
    assert_eq!(launched, run_id);
    for _ in 0..20 {
        service.stop();
        service.start().expect("restart");
        let actions = service.take_actions();
        assert_eq!(recovers(&actions), vec![run_id.clone()]);
        assert!(
            !actions
                .iter()
                .any(|action| matches!(action, Action::Execute { .. }))
        );
    }
    service.stop();
    assert!(service.take_actions().is_empty());
    let runs = service.inbox(50, None, None, None).expect("inbox").0;
    assert_eq!(sv(&runs[0], "status"), Some("running"));
}

#[test]
fn a_late_completion_after_stop_is_ignored_and_recovery_takes_the_run() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    let run = service
        .trigger("triage", "pending", variables("issues"), "manual", None)
        .expect("run");
    let run_id = sv(&run, "id").expect("id").to_owned();
    service.take_actions();
    service.stop();
    assert!(
        service
            .complete(&run_id, "succeeded", Some("late"), Some("late"))
            .expect("late completion")
            .is_none()
    );
    service.start().expect("restart");
    assert_eq!(recovers(&service.take_actions()), vec![run_id.clone()]);
    service
        .complete(&run_id, "succeeded", Some("recovered"), Some("done"))
        .expect("finish");
    let runs = service.inbox(50, None, None, None).expect("inbox").0;
    assert_eq!(sv(&runs[0], "status"), Some("succeeded"));
    assert_eq!(sv(&runs[0], "threadId"), Some("recovered"));
}

#[test]
fn a_run_notification_that_stops_the_service_never_launches_its_observer() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    let run = service
        .trigger(
            "triage",
            "stop-during-notification",
            variables("issues"),
            "manual",
            None,
        )
        .expect("run");
    let run_id = sv(&run, "id").expect("id").to_owned();
    let published = service.take_published();
    assert_eq!(sv(&published[0], "status"), Some("running"));
    service.stop();
    assert!(service.take_actions().is_empty());
    let runs = service.inbox(50, None, None, None).expect("inbox").0;
    assert_eq!(sv(&runs[0], "status"), Some("running"));
    service.start().expect("restart");
    assert_eq!(recovers(&service.take_actions()), vec![run_id.clone()]);
    service
        .complete(&run_id, "succeeded", Some("thread"), Some("done"))
        .expect("finish");
}

#[test]
fn a_notification_that_fills_the_last_slot_keeps_the_waiting_run_waiting() {
    let h = Harness::new();
    let mut service = h.started();
    for index in 0..257 {
        let mut job = definition();
        job.id = format!("job-{index}");
        service.put(&job, None).expect("put");
    }
    let first = service
        .trigger("job-0", "first", variables("first"), "manual", None)
        .expect("first");
    service
        .trigger("job-0", "second", variables("second"), "manual", None)
        .expect("second");
    for index in 1..256 {
        service
            .trigger(
                &format!("job-{index}"),
                "event",
                variables("issues"),
                "manual",
                None,
            )
            .expect("run");
    }
    let actions = service.take_actions();
    assert_eq!(actions.len(), 256);
    let first_id = sv(&first, "id").expect("id").to_owned();

    // The host sees the finish, then another automation takes the room it left before the
    // automation's own waiting run is promoted.
    service
        .complete_deferred(&first_id, "succeeded", Some("thread"), Some("done"))
        .expect("finish");
    let published = service.take_published();
    assert_eq!(sv(&published[0], "automationId"), Some("job-0"));
    let late = service
        .trigger("job-256", "event", variables("late"), "manual", None)
        .expect("late");
    assert_eq!(sv(&late, "status"), Some("running"));
    service.take_actions();
    service.drain_waiting();
    assert!(
        service.take_actions().is_empty(),
        "the waiting run has no room"
    );

    // Another automation's run finishes and the waiting run takes that room.
    let mut ids: Vec<String> = service
        .inbox(50, None, Some("job-100"), None)
        .expect("inbox")
        .0
        .iter()
        .filter_map(|run| sv(run, "id").map(str::to_owned))
        .collect();
    let job_100 = ids.pop().expect("job-100 run");
    service
        .complete(&job_100, "succeeded", Some("thread"), Some("done"))
        .expect("finish");
    let actions = service.take_actions();
    assert!(
        actions
            .iter()
            .any(|action| matches!(action, Action::Execute { .. })),
        "waiting run starts once room frees"
    );
}

#[test]
fn a_deduplicated_schedule_fire_never_reuses_a_run_id_after_restart() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&scheduled("skip", 0), None).expect("put");
    let mut scheduled_variables = std::collections::BTreeMap::new();
    scheduled_variables.insert(
        "scheduled_at".to_owned(),
        ace_automations::calendar::iso_string(START),
    );
    let existing = service
        .trigger(
            "triage",
            &format!("schedule:{START}"),
            scheduled_variables,
            "schedule",
            None,
        )
        .expect("existing");
    let existing_id = run_id(&existing);
    service.take_actions();
    service
        .complete(&existing_id, "succeeded", Some("thread"), Some("done"))
        .expect("finish");

    // The due occurrence is the one the trigger already claimed: the tick deduplicates it.
    h.clock.0.set(START);
    assert!(service.tick().expect("tick").is_some());
    service.take_actions();
    service.take_published();

    h.clock.0.set(START + DAY);
    let second = service.timer_fired().expect("timer").expect("second");
    let second_id = run_id(&second);
    service
        .complete(&second_id, "succeeded", Some("thread"), Some("done"))
        .expect("finish");
    h.clock.0.set(START + 2 * DAY);
    let third = service.timer_fired().expect("timer").expect("third");
    let third_id = run_id(&third);
    service
        .complete(&third_id, "succeeded", Some("thread"), Some("done"))
        .expect("finish");
    drop(service);

    // A reopened service's generated ids are the host's, never a sequence reseeded from rows a
    // deduplicated fire left behind.
    let store = h.reopen();
    let mut service = h.service_on(&store);
    service.start().expect("restart");
    h.clock.0.set(START + 3 * DAY);
    let fourth = service.timer_fired().expect("timer").expect("fourth");
    let fourth_id = run_id(&fourth);
    assert_ne!(fourth_id, third_id);
    assert_ne!(fourth_id, second_id);
    assert_ne!(fourth_id, existing_id);
    assert_eq!(
        sv(&fourth, "eventKey"),
        Some(format!("schedule:{}", START + 3 * DAY).as_str())
    );
}

#[test]
fn a_schedule_whose_run_cannot_be_written_is_parked_and_the_timer_keeps_the_next_one() {
    let h = Harness::new();
    let mut service = h.started();
    let mut first = scheduled("skip", 0);
    first.id = "aaa".to_owned();
    service.put(&first, None).expect("first");
    let mut second = scheduled("skip", 0);
    second.id = "bbb".to_owned();
    if let Trigger::Schedule { schedule } = &mut second.trigger {
        schedule.start_at = START + DAY;
    }
    service.put(&second, None).expect("second");

    // The host's next id is already a stored run's id: this claim's insert is refused.
    let raw = ace_store::Connection::open(
        h.path().to_str().expect("utf8"),
        ace_store::OpenOptions {
            read_only: false,
            timeout_ms: 5000,
        },
    )
    .expect("raw");
    raw.exec(
        "INSERT INTO automation_runs(id,automation_id,event_key,status,body,input,finished_at) VALUES('run-1','other','other','succeeded','{}',NULL,1)",
    )
    .expect("blocking row");
    raw.close().expect("close");

    h.clock.0.set(START);
    assert!(service.tick().expect("tick").is_none());
    let parked = h.store.metadata("aaa").expect("meta").expect("job");
    assert!(parked.trigger_error.is_some());
    assert_eq!(parked.due, None);
    assert_eq!(service.armed_delay(), Some(60_000));

    h.clock.0.set(START + DAY);
    let run = service
        .timer_fired()
        .expect("timer")
        .expect("next schedule");
    assert_eq!(sv(&run, "automationId"), Some("bbb"));
}

#[test]
fn a_refused_terminal_write_keeps_the_run_until_a_retry_commits_it_and_promotes_the_queue() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&definition(), None).expect("put");
    let first = service
        .trigger("triage", "first", variables("first"), "manual", None)
        .expect("first");
    let first_id = run_id(&first);
    service
        .trigger("triage", "second", variables("second"), "manual", None)
        .expect("second");
    service.take_actions();

    // A transient write failure: the run table is momentarily unavailable.
    let raw = ace_store::Connection::open(
        h.path().to_str().expect("utf8"),
        ace_store::OpenOptions {
            read_only: false,
            timeout_ms: 5000,
        },
    )
    .expect("raw");
    raw.exec("ALTER TABLE automation_runs RENAME TO automation_runs_broken")
        .expect("break");
    raw.close().expect("close");
    assert!(
        service
            .complete(&first_id, "succeeded", Some("thread"), Some("done"))
            .expect("complete")
            .is_none()
    );
    assert!(
        service
            .take_errors()
            .iter()
            .any(|error| error.contains("automation_runs")),
        "the refused write is reported"
    );
    assert_eq!(service.armed_delay(), Some(1000));

    let raw = ace_store::Connection::open(
        h.path().to_str().expect("utf8"),
        ace_store::OpenOptions {
            read_only: false,
            timeout_ms: 5000,
        },
    )
    .expect("raw");
    raw.exec("ALTER TABLE automation_runs_broken RENAME TO automation_runs")
        .expect("restore");
    raw.close().expect("close");
    h.clock.0.set(START - 60_000 + 1000);
    let finished = service
        .timer_fired()
        .expect("timer")
        .expect("settled on retry");
    assert_eq!(sv(&finished, "status"), Some("succeeded"));
    let published = service.take_published();
    assert!(
        published
            .iter()
            .any(|run| sv(run, "id") == Some(first_id.as_str())),
        "the settled run is published once"
    );
    let actions = service.take_actions();
    assert_eq!(input_prompt(&actions[0]), "Triage second");
}

#[test]
fn a_deduplicated_due_schedule_advances_without_another_run_or_notification() {
    let h = Harness::new();
    let mut service = h.started();
    service.put(&scheduled("skip", 0), None).expect("put");
    let mut scheduled_variables = std::collections::BTreeMap::new();
    scheduled_variables.insert(
        "scheduled_at".to_owned(),
        ace_automations::calendar::iso_string(START),
    );
    let existing = service
        .trigger(
            "triage",
            &format!("schedule:{START}"),
            scheduled_variables,
            "schedule",
            None,
        )
        .expect("existing");
    let existing_id = run_id(&existing);
    service.take_actions();
    service.take_published();

    h.clock.0.set(START);
    let dedup = service.tick().expect("tick").expect("deduplicated run");
    assert_eq!(run_id(&dedup), existing_id);
    assert!(
        service.take_actions().is_empty(),
        "a deduplicated fire starts nothing"
    );
    assert!(
        service.take_published().is_empty(),
        "a deduplicated fire notifies nothing"
    );
    assert_eq!(
        h.store
            .metadata("triage")
            .expect("meta")
            .and_then(|job| job.due),
        Some(START + DAY),
        "the cursor still advances to the next occurrence"
    );
}

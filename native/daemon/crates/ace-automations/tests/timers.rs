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

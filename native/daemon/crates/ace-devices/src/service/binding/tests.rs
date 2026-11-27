// SPDX-License-Identifier: Apache-2.0
//! Moving a device between threads (`binding.ts`): fresh logs and recordings for
//! the new thread, control released, and the two refusals.
//!
//! `binding.ts` has no test file of its own (behaviour.md §5 lists none), so
//! these cases are the module's only guard.

use super::{
    Bind, Bound, begin_bind, begin_disable, finish_bind, finish_disable, supersede_inflight_bind,
};
use crate::error::DeviceErrorCode;
use crate::service::lease::{Actor, Controller};
use crate::service::session::Session;
use crate::service::words;

fn bound(thread_id: &str) -> Session {
    let mut session = Session::new("ios:AAAA");
    session.thread_id = Some(thread_id.to_owned());
    session.log_owners = vec![String::from("logs-1")];
    session
        .lease
        .claim(Actor::agent("agent-1", thread_id, "a1"), 0.0);
    session.completed = Some(String::from("recording-1"));
    session.recording_artifact = Some(String::from("artifact-1"));
    session
}

#[test]
fn binding_to_the_same_thread_changes_nothing() {
    let mut session = bound("t1");
    assert!(matches!(
        begin_bind(&mut session, "t1", "agent-1"),
        Ok(Bind::Unchanged { .. })
    ));
    assert_eq!(session.thread_id.as_deref(), Some("t1"));
    assert!(!session.changing_binding);
    assert_eq!(session.binding_epoch, 0);
    assert_eq!(session.lease.status(0.0).controller, Controller::Agent);
}

#[test]
fn binding_while_another_bind_runs_is_busy() {
    let mut session = bound("t1");
    session.changing_binding = true;
    let refused = begin_bind(&mut session, "t2", "agent-1").expect_err("a bind is running");
    assert_eq!(refused, words::refusal("bindingBusy"));
    assert_eq!(refused.code(), DeviceErrorCode::Busy);
}

#[test]
fn a_bind_frees_the_device_and_lets_go_of_control_before_cleanup() {
    let mut session = bound("t1");
    let epoch = match begin_bind(&mut session, "t2", "agent-1").expect("free") {
        Bind::Cleanup { epoch, .. } => epoch,
        other => panic!("expected a cleanup, got {other:?}"),
    };
    assert_eq!(epoch, 1);
    assert_eq!(session.thread_id, None, "unbound while the cleanup runs");
    assert!(
        session.log_owners.is_empty(),
        "the old thread's log readers go"
    );
    assert_eq!(
        session.lease.status(0.0).controller,
        Controller::None,
        "whoever was in control lets go"
    );
    assert!(session.changing_binding);
}

#[test]
fn a_cleanup_failure_leaves_the_device_unbound() {
    let mut session = bound("t1");
    let Bind::Cleanup { epoch, .. } = begin_bind(&mut session, "t2", "agent-1").expect("free")
    else {
        panic!("a cleanup");
    };
    assert_eq!(
        finish_bind(&mut session, "t2", epoch, true, true),
        Ok(Bound::CleanupFailed)
    );
    assert_eq!(session.thread_id, None);
    assert!(!session.changing_binding, "the bind is over either way");
    assert_eq!(
        session.completed, None,
        "the published recording is cleared"
    );
    assert_eq!(session.recording_artifact, None);
}

#[test]
fn a_bind_that_finishes_clears_the_old_threads_recording_and_binds() {
    let mut session = bound("t1");
    let Bind::Cleanup { epoch, .. } = begin_bind(&mut session, "t2", "agent-1").expect("free")
    else {
        panic!("a cleanup");
    };
    assert_eq!(
        finish_bind(&mut session, "t2", epoch, false, true),
        Ok(Bound::Bound)
    );
    assert_eq!(session.thread_id.as_deref(), Some("t2"));
    assert_eq!(session.completed, None);
    assert_eq!(session.recording_artifact, None);
}

#[test]
fn devices_turned_off_during_the_cleanup_refuse_the_bind() {
    let mut session = bound("t1");
    let Bind::Cleanup { epoch, .. } = begin_bind(&mut session, "t2", "agent-1").expect("free")
    else {
        panic!("a cleanup");
    };
    let refused =
        finish_bind(&mut session, "t2", epoch, false, false).expect_err("devices were turned off");
    assert_eq!(refused, words::refusal("bindingDisabled"));
    assert_eq!(refused.code(), DeviceErrorCode::Busy);
    assert_eq!(session.thread_id, None, "the device stays unbound");
}

#[test]
fn a_newer_bind_makes_the_older_one_refuse() {
    let mut session = bound("t1");
    let Bind::Cleanup { epoch, .. } = begin_bind(&mut session, "t2", "agent-1").expect("free")
    else {
        panic!("a cleanup");
    };
    // A disable (or another bind) moved the epoch while this one cleaned up.
    begin_disable(&mut session);
    let refused =
        finish_bind(&mut session, "t2", epoch, false, true).expect_err("a newer change passed it");
    assert_eq!(refused.code(), DeviceErrorCode::Busy);
    assert_eq!(session.thread_id, None);
}

#[test]
fn a_cleanup_failure_racing_a_disable_reports_the_failure_and_leaves_the_newer_bind_alone() {
    let mut session = bound("t1");
    let Bind::Cleanup { epoch, .. } = begin_bind(&mut session, "t2", "agent-1").expect("free")
    else {
        panic!("a cleanup");
    };
    // A disable (and a later bind) moved the epoch while this one cleaned up, and
    // then this cleanup failed too: the failure is the caller's own error.
    begin_disable(&mut session);
    let Bind::Cleanup { epoch: newer, .. } =
        begin_bind(&mut session, "t3", "agent-1").expect("a new bind")
    else {
        panic!("a newer cleanup");
    };
    session.completed = Some(String::from("recording-2"));
    session.recording_artifact = Some(String::from("artifact-2"));

    assert_eq!(
        finish_bind(&mut session, "t2", epoch, true, true),
        Ok(Bound::CleanupFailed)
    );
    assert!(
        session.changing_binding,
        "the newer bind keeps its reservation"
    );
    assert_eq!(
        session.completed.as_deref(),
        Some("recording-2"),
        "the newer bind's published recording stays"
    );
    assert_eq!(session.recording_artifact.as_deref(), Some("artifact-2"));
    assert_eq!(session.thread_id, None, "the device stays unbound");

    assert_eq!(
        finish_bind(&mut session, "t3", newer, false, true),
        Ok(Bound::Bound)
    );
    assert_eq!(session.thread_id.as_deref(), Some("t3"));
}

#[test]
fn disabling_retires_an_in_flight_bind_and_an_obsolete_finish_leaves_the_newer_bind_alone() {
    let mut session = bound("t1");
    let Bind::Cleanup { epoch, .. } = begin_bind(&mut session, "t2", "agent-1").expect("free")
    else {
        panic!("a cleanup");
    };
    begin_disable(&mut session);
    assert!(
        !session.changing_binding,
        "the disable retired the bind's reservation"
    );

    let Bind::Cleanup { epoch: newer, .. } =
        begin_bind(&mut session, "t3", "agent-1").expect("a new bind")
    else {
        panic!("a newer cleanup");
    };
    session.completed = Some(String::from("recording-2"));
    session.recording_artifact = Some(String::from("artifact-2"));

    let refused = finish_bind(&mut session, "t2", epoch, false, true)
        .expect_err("the disable passed this bind");
    assert_eq!(refused, words::refusal("bindingDisabled"));
    assert!(
        session.changing_binding,
        "the newer bind keeps its reservation"
    );
    assert_eq!(
        session.completed.as_deref(),
        Some("recording-2"),
        "the newer bind's published recording stays"
    );
    assert_eq!(session.recording_artifact.as_deref(), Some("artifact-2"));

    assert_eq!(
        finish_bind(&mut session, "t3", newer, false, true),
        Ok(Bound::Bound)
    );
    assert_eq!(session.thread_id.as_deref(), Some("t3"));
}

#[test]
fn a_persons_supersede_retires_the_agents_bind_and_its_obsolete_finish_changes_nothing() {
    let mut session = bound("t1");
    let Bind::Cleanup { epoch, .. } = begin_bind(&mut session, "t2", "agent-1").expect("free")
    else {
        panic!("a cleanup");
    };
    supersede_inflight_bind(&mut session);
    assert!(
        !session.changing_binding,
        "the person's takeover retires it"
    );
    assert_eq!(session.thread_id, None);

    let Bind::Cleanup {
        epoch: person_epoch,
        ..
    } = begin_bind(&mut session, "t-person", "person").expect("the person's bind")
    else {
        panic!("the person's cleanup");
    };
    session.completed = Some(String::from("person-recording"));

    let refused = finish_bind(&mut session, "t2", epoch, false, true)
        .expect_err("the person's bind passed this one");
    assert_eq!(refused, words::refusal("bindingDisabled"));
    assert!(
        session.changing_binding,
        "the person's bind keeps its reservation"
    );
    assert_eq!(session.completed.as_deref(), Some("person-recording"));

    assert_eq!(
        finish_bind(&mut session, "t-person", person_epoch, false, true),
        Ok(Bound::Bound)
    );
    assert_eq!(session.thread_id.as_deref(), Some("t-person"));
}

#[test]
fn a_recording_published_after_re_enable_survives_the_old_disable_completion() {
    let mut session = bound("t1");
    let disabled = begin_disable(&mut session);

    // Devices are on again: the device binds afresh and a recording publishes
    // before the old disable's stop returns.
    let Bind::Cleanup { epoch, .. } =
        begin_bind(&mut session, "t2", "agent-1").expect("a new bind")
    else {
        panic!("a newer cleanup");
    };
    finish_bind(&mut session, "t2", epoch, false, true).expect("bound");
    session.completed = Some(String::from("recording-2"));
    session.recording_artifact = Some(String::from("artifact-2"));

    finish_disable(&mut session, disabled);
    assert_eq!(
        session.completed.as_deref(),
        Some("recording-2"),
        "the newer recording survives the old disable's completion"
    );
    assert_eq!(session.recording_artifact.as_deref(), Some("artifact-2"));
}

#[test]
fn disabling_frees_every_device_and_bumps_its_epoch() {
    let mut session = bound("t1");
    let before = session.binding_epoch;
    let epoch = begin_disable(&mut session);
    assert_eq!(session.thread_id, None);
    assert_eq!(
        session.binding_epoch,
        before + 1,
        "a pending bind is passed"
    );
    finish_disable(&mut session, epoch);
    assert_eq!(session.completed, None);
    assert_eq!(session.recording_artifact, None);
}

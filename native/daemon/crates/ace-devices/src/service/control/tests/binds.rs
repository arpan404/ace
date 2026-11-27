// SPDX-License-Identifier: Apache-2.0
//! A bind's reservation across takeovers (`binding.ts`, `service.ts`): who retires
//! it, when its cleanup is consumed exactly once, and the recording it owns.

use super::*;

#[test]
fn an_agent_whose_bind_pauses_cannot_steal_control_after_a_person_takes_over() {
    let mut session = Session::new("ios:AAAA");
    assert_eq!(
        claim_for_agent(&mut session, &agent(), NOW),
        Ok(Claim::Take)
    );
    let bind = start_bind_for_agent(&mut session, &agent(), NOW).expect("bind");
    let person_assign = begin_assign(&mut session, &person(), NOW).expect("person begins");
    finish_assign(&mut session, person_assign, Some(&person()), NOW).expect("person wins");
    assert_eq!(session.lease.status(NOW).controller, Controller::Human);

    let refused = resume_claim_for_agent(&mut session, &agent(), bind, false, true, NOW)
        .expect_err("person still holds it");
    assert_eq!(refused, words::refusal("controlChanged"));
    assert_eq!(session.lease.status(NOW).controller, Controller::Human);
}

#[test]
fn a_person_with_a_thread_supersedes_an_agent_bind_before_it_can_finish() {
    let mut session = Session::new("ios:AAAA");
    let agent_bind = start_bind_for_agent(&mut session, &agent(), NOW).expect("agent bind");
    let takeover = start_human_controller_with_thread(&mut session, &person(), "t-view", NOW)
        .expect("person with thread");
    assert!(session.changing_binding);
    resume_human_controller_with_thread(
        &mut session,
        takeover,
        "t-view",
        Some(&person()),
        false,
        true,
        NOW,
    )
    .expect("person wins");
    assert_eq!(session.thread_id.as_deref(), Some("t-view"));
    let refused = resume_claim_for_agent(&mut session, &agent(), agent_bind, false, true, NOW)
        .expect_err("stale agent");
    assert_eq!(refused, words::refusal("controlChanged"));
}

#[test]
fn a_person_bind_while_an_agent_bind_runs_starts_before_the_agent_bind_does() {
    let mut session = Session::new("ios:AAAA");
    let agent_bind = start_bind_for_agent(&mut session, &agent(), NOW).expect("agent first");
    let takeover = start_human_controller_with_thread(&mut session, &person(), "t-person", NOW)
        .expect("person");
    resume_human_controller_with_thread(
        &mut session,
        takeover,
        "t-person",
        Some(&person()),
        false,
        true,
        NOW,
    )
    .expect("person bind finishes first");
    let refused = resume_claim_for_agent(&mut session, &agent(), agent_bind, false, true, NOW)
        .expect_err("passed");
    assert_eq!(refused, words::refusal("controlChanged"));
}

#[test]
fn a_retired_bind_clears_the_recording_its_skipped_cleanup_would_have() {
    let mut session = Session::new("ios:AAAA");
    let takeover = start_human_controller_with_thread(&mut session, &person(), "t-person", NOW)
        .expect("the person's threaded takeover");
    session.completed = Some(String::from("old-recording"));
    session.recording_artifact = Some(String::from("old-artifact"));

    // The person drops while their bind is still cleaning up. The reservation is
    // retired, so the cleanup that would have cleared the recording never runs.
    invalidate_pending_owner(&mut session, "person");
    assert!(!session.changing_binding);
    assert_eq!(
        session.completed, None,
        "the retired bind cleared its recording"
    );
    assert_eq!(session.recording_artifact, None);

    // The stale continuation does not re-publish it.
    let refused = resume_human_controller_with_thread(
        &mut session,
        takeover,
        "t-person",
        Some(&person()),
        false,
        true,
        NOW,
    )
    .expect_err("the person dropped mid-bind");
    assert_eq!(refused, words::refusal("controlChanged"));
    assert_eq!(session.completed, None);
}

#[test]
fn a_takeover_that_replaced_its_own_bind_leaves_the_newer_bind_alone() {
    let mut session = Session::new("ios:AAAA");
    let _takeover = start_human_controller_with_thread(&mut session, &person(), "t-person", NOW)
        .expect("the person's threaded takeover");
    // The same owner starts the bind again while their assignment is still pending,
    // so the newer bind is not the one that assignment began.
    let _newer_bind =
        begin_bind_for_person(&mut session, "t-person", "person").expect("the person's newer bind");
    session.completed = Some(String::from("newer-recording"));
    session.recording_artifact = Some(String::from("newer-artifact"));

    let other = Actor::human("person-2");
    begin_assign(&mut session, &other, NOW).expect("another person takes control");

    assert!(
        session.changing_binding,
        "the newer bind keeps its guard and epoch"
    );
    assert_eq!(
        session.binding_owner.as_deref(),
        Some("person"),
        "the newer bind keeps its owner"
    );
    assert_eq!(
        session.completed.as_deref(),
        Some("newer-recording"),
        "the newer bind keeps its recording"
    );
    assert_eq!(
        session.recording_artifact.as_deref(),
        Some("newer-artifact")
    );
}

#[test]
fn an_owner_drop_leaves_a_bind_that_owner_started_later_alone() {
    let mut session = Session::new("ios:AAAA");
    let _takeover = start_human_controller_with_thread(&mut session, &person(), "t-person", NOW)
        .expect("the person's threaded takeover");
    // The same owner starts the bind again while their assignment is still pending,
    // so the live reservation is not the one that assignment began.
    let _newer_bind =
        begin_bind_for_person(&mut session, "t-person", "person").expect("the person's newer bind");
    session.completed = Some(String::from("newer-recording"));
    session.recording_artifact = Some(String::from("newer-artifact"));

    invalidate_pending_owner(&mut session, "person");

    assert!(
        session.changing_binding,
        "the newer bind keeps its guard and epoch"
    );
    assert_eq!(
        session.binding_owner.as_deref(),
        Some("person"),
        "the newer bind keeps its owner"
    );
    assert_eq!(
        session.completed.as_deref(),
        Some("newer-recording"),
        "the newer bind keeps its recording"
    );
    assert_eq!(
        session.recording_artifact.as_deref(),
        Some("newer-artifact")
    );
}

#[test]
fn every_end_of_a_claim_bind_clears_its_marker_so_a_drop_retires_nothing() {
    // Success: the agent resumes and takes the device.
    let mut session = Session::new("ios:AAAA");
    let bind = start_bind_for_agent(&mut session, &agent(), NOW).expect("the agent's bind");
    let assignment = resume_claim_for_agent(&mut session, &agent(), bind, false, true, NOW)
        .expect("the agent resumes")
        .expect("an assignment");
    finish_assign(&mut session, assignment, Some(&agent()), NOW).expect("the agent holds it");
    assert_eq!(
        session.claim_bind_epoch, None,
        "a successful claim leaves no marker"
    );

    // Cleanup failure: nothing is assigned and the reservation is gone.
    let mut session = Session::new("ios:AAAA");
    let bind = start_bind_for_agent(&mut session, &agent(), NOW).expect("the agent's bind");
    resume_claim_for_agent(&mut session, &agent(), bind, true, true, NOW)
        .expect("the cleanup failure is the claim's own answer");
    assert_eq!(
        session.claim_bind_epoch, None,
        "a failed cleanup leaves no marker"
    );

    // A disable retires the reservation before its own cleanup runs.
    let mut session = Session::new("ios:AAAA");
    start_bind_for_agent(&mut session, &agent(), NOW).expect("the agent's bind");
    begin_disable(&mut session);
    assert_eq!(session.claim_bind_epoch, None, "a disable leaves no marker");

    // A person's threaded takeover supersedes the agent's bind.
    let mut session = Session::new("ios:AAAA");
    start_bind_for_agent(&mut session, &agent(), NOW).expect("the agent's bind");
    start_human_controller_with_thread(&mut session, &person(), "t-view", NOW)
        .expect("the person's takeover");
    assert_eq!(
        session.claim_bind_epoch, None,
        "a replacement leaves no marker"
    );

    // With no marker, a dropped agent retires nothing and invalidates nothing.
    let revision = session.control_revision;
    invalidate_pending_owner(&mut session, "agent-1");
    assert_eq!(session.control_revision, revision);
    assert!(
        session.changing_binding,
        "the person's bind still cleans up"
    );
    assert_eq!(session.binding_owner.as_deref(), Some("person"));
}

#[test]
fn an_agent_drop_mid_cleanup_frees_the_guard_and_a_fresh_claim_holds() {
    let mut session = Session::new("ios:AAAA");
    session.thread_id = Some(String::from("t-old"));
    session.completed = Some(String::from("old-recording"));
    session.recording_artifact = Some(String::from("old-artifact"));
    let _stalled_bind =
        start_bind_for_agent(&mut session, &agent(), NOW).expect("the agent's bind");
    assert!(session.changing_binding);

    // The agent is dropped while its cleanup is still out; no continuation will
    // ever land for that bind.
    invalidate_pending_owner(&mut session, "agent-1");
    assert!(
        !session.changing_binding,
        "the drop retires the agent's bind"
    );
    assert_eq!(
        session.completed, None,
        "the retired bind clears the recording it never got to clear"
    );
    assert_eq!(session.recording_artifact, None);

    // Every ordinary operation is free again, the person's included.
    authorize(&session, &person(), true, false).expect("no bind blocks ordinary operations");

    // A fresh claim by another agent reaches a holder.
    let other = Actor::agent("agent-2", "t2", "a2");
    assert_eq!(claim_for_agent(&mut session, &other, NOW), Ok(Claim::Take));
    let bind = start_bind_for_agent(&mut session, &other, NOW).expect("the other agent binds");
    let assignment = resume_claim_for_agent(&mut session, &other, bind, false, true, NOW)
        .expect("the other agent resumes")
        .expect("an assignment");
    finish_assign(&mut session, assignment, Some(&other), NOW).expect("the other agent holds it");
    assert_eq!(session.thread_id.as_deref(), Some("t2"));
    assert_eq!(session.lease.status(NOW).controller, Controller::Agent);
}

#[test]
fn a_late_successful_completion_after_the_agents_drop_is_refused_and_changes_nothing() {
    let mut session = Session::new("ios:AAAA");
    let bind = start_bind_for_agent(&mut session, &agent(), NOW).expect("the agent's bind");
    invalidate_pending_owner(&mut session, "agent-1");
    // The device belongs to nobody now; the dropped agent's cleanup returns success
    // and its continuation is delivered anyway.
    session.completed = Some(String::from("newer-recording"));
    session.recording_artifact = Some(String::from("newer-artifact"));

    let refused = resume_claim_for_agent(&mut session, &agent(), bind, false, true, NOW)
        .expect_err("the owner drop passed the bind");
    assert_eq!(refused, words::refusal("controlChanged"));
    assert_eq!(
        session.thread_id, None,
        "the refused completion binds nothing"
    );
    assert_eq!(session.lease.status(NOW).controller, Controller::None);
    assert!(!session.changing_binding);
    assert_eq!(
        session.completed.as_deref(),
        Some("newer-recording"),
        "the refused completion clears nothing published since"
    );
    assert_eq!(
        session.recording_artifact.as_deref(),
        Some("newer-artifact")
    );
}

#[test]
fn an_agents_drop_leaves_a_newer_bind_by_someone_else_alone() {
    let mut session = Session::new("ios:AAAA");
    start_bind_for_agent(&mut session, &agent(), NOW).expect("the agent's bind");
    // The person's threaded takeover supersedes the agent's bind and starts its own.
    let takeover = start_human_controller_with_thread(&mut session, &person(), "t-view", NOW)
        .expect("the person's takeover");
    assert!(session.changing_binding, "the person's bind is cleaning up");
    session.completed = Some(String::from("person-recording"));
    session.recording_artifact = Some(String::from("person-artifact"));

    invalidate_pending_owner(&mut session, "agent-1");

    assert!(
        session.changing_binding,
        "the person's bind keeps its guard and epoch"
    );
    assert_eq!(session.binding_owner.as_deref(), Some("person"));
    assert_eq!(session.completed.as_deref(), Some("person-recording"));
    assert_eq!(
        session.recording_artifact.as_deref(),
        Some("person-artifact")
    );

    // The person's bind still finishes onto their thread.
    resume_human_controller_with_thread(
        &mut session,
        takeover,
        "t-view",
        Some(&person()),
        false,
        true,
        NOW,
    )
    .expect("the person's bind finishes");
    assert_eq!(session.thread_id.as_deref(), Some("t-view"));
    assert_eq!(session.lease.status(NOW).controller, Controller::Human);
}

#[test]
fn a_second_agents_claim_is_refused_disabled_while_another_agents_bind_cleans_up() {
    let mut session = Session::new("ios:AAAA");
    start_bind_for_agent(&mut session, &agent(), NOW).expect("the first agent's bind");
    let other = Actor::agent("agent-2", "t2", "a2");

    // `claimForAgent` asks `assertEnabled` before it binds (`service.ts:453`), so a
    // claim that lands while another agent's cleanup is out is refused
    // `devicesDisabled`, not `bindingBusy`.
    let refused =
        start_bind_for_agent(&mut session, &other, NOW).expect_err("another bind is running");
    assert_eq!(refused, words::refusal("devicesDisabled"));
    assert_eq!(refused.code(), DeviceErrorCode::PermissionDenied);
    assert!(
        session.changing_binding,
        "the running bind keeps its guard and epoch"
    );
    assert_eq!(session.binding_owner.as_deref(), Some("agent-1"));
}

#[test]
fn a_threadless_takeover_during_a_disable_finds_no_recording_from_the_old_thread() {
    let mut session = Session::new("ios:AAAA");
    // The prior thread left a recording that ended on its own, waiting for its
    // `record.stop`.
    session.thread_id = Some(String::from("t-old"));
    session.completed = Some(String::from("old-recording"));
    session.recording_artifact = Some(String::from("old-artifact"));

    // An agent's bind starts, so the device is unbound and its guard is set while
    // the cleanup runs.
    let agent_bind = start_bind_for_agent(&mut session, &agent(), NOW).expect("agent bind");
    assert!(session.changing_binding);
    // Devices are turned off before that bind finishes, then on again while the
    // disable's own cleanup is still pending.
    let disabled = begin_disable(&mut session);

    // The person takes control without a thread: there is no bind to retire, so
    // their takeover passes the guard and reaches control.
    let assignment = begin_assign(&mut session, &person(), NOW).expect("person takes control");
    finish_assign(&mut session, assignment, Some(&person()), NOW).expect("person holds it");
    authorize(&session, &person(), true, false).expect("the person may stop a recording");

    assert_eq!(
        session.completed, None,
        "the person's record.stop has nothing of the old thread's to consume"
    );
    assert_eq!(session.recording_artifact, None);

    // Both old completions land afterwards: the agent's bind and the disable.
    let refused = resume_claim_for_agent(&mut session, &agent(), agent_bind, false, true, NOW)
        .expect_err("the disable passed the agent's bind");
    assert_eq!(refused, words::refusal("controlChanged"));
    finish_disable(&mut session, disabled);

    assert_eq!(
        session.completed, None,
        "the old completions publish nothing back"
    );
    assert_eq!(session.recording_artifact, None);
    assert_eq!(
        session.lease.status(NOW).controller,
        Controller::Human,
        "the person keeps control"
    );
}

#[test]
fn an_old_agents_bind_resuming_leaves_a_newer_agents_claim_intact() {
    let mut session = Session::new("ios:AAAA");
    let old = start_bind_for_agent(&mut session, &agent(), NOW).expect("the old agent's bind");

    // Devices off retire the old reservation while its cleanup is still out, then the
    // device comes back before that continuation lands.
    let disabled = begin_disable(&mut session);
    finish_disable(&mut session, disabled);

    // A newer agent takes the device and starts a claim bind of its own.
    let other = Actor::agent("agent-2", "t2", "a2");
    assert_eq!(claim_for_agent(&mut session, &other, NOW), Ok(Claim::Take));
    let newer = start_bind_for_agent(&mut session, &other, NOW).expect("the newer agent's bind");
    let epoch = newer.cleanup_epoch().expect("a reservation to wait for");
    assert_eq!(session.claim_bind_epoch, Some(epoch));

    // The old continuation lands late. It is refused, and the newer claim keeps its
    // guard, its epoch, its owner and the marker a drop of its own would retire.
    let refused = resume_claim_for_agent(&mut session, &agent(), old, false, true, NOW)
        .expect_err("the old bind was retired");
    assert_eq!(refused, words::refusal("bindingDisabled"));
    assert!(
        session.changing_binding,
        "the newer claim keeps its reservation"
    );
    assert_eq!(session.binding_epoch, epoch);
    assert_eq!(session.claim_bind_epoch, Some(epoch));
    assert_eq!(session.binding_owner.as_deref(), Some("agent-2"));

    // The newer claim still finishes onto its own thread.
    let assignment = resume_claim_for_agent(&mut session, &other, newer, false, true, NOW)
        .expect("the newer agent resumes")
        .expect("an assignment");
    finish_assign(&mut session, assignment, Some(&other), NOW).expect("the newer agent holds it");
    assert_eq!(session.thread_id.as_deref(), Some("t2"));
    assert_eq!(session.lease.status(NOW).controller, Controller::Agent);
    assert_eq!(
        session.claim_bind_epoch, None,
        "a finished claim leaves no marker"
    );
}

#[test]
fn a_replayed_successful_bind_completion_leaves_the_live_recording_alone() {
    let mut session = Session::new("ios:AAAA");
    let bind = start_bind_for_agent(&mut session, &agent(), NOW).expect("the agent's bind");
    let replay = bind.clone();
    let assignment = resume_claim_for_agent(&mut session, &agent(), bind, false, true, NOW)
        .expect("the agent resumes")
        .expect("an assignment");
    finish_assign(&mut session, assignment, Some(&agent()), NOW).expect("the agent holds it");
    // The newly bound thread publishes a recording of its own.
    session.completed = Some(String::from("recording-2"));
    session.recording_artifact = Some(String::from("artifact-2"));

    let refused = resume_claim_for_agent(&mut session, &agent(), replay, false, true, NOW)
        .expect_err("the bind already finished");
    assert_eq!(refused, words::refusal("controlChanged"));
    assert_eq!(session.thread_id.as_deref(), Some("t1"));
    assert_eq!(
        session.completed.as_deref(),
        Some("recording-2"),
        "a consumed reservation does not clear the live recording"
    );
    assert_eq!(session.recording_artifact.as_deref(), Some("artifact-2"));
}

#[test]
fn a_replayed_successful_finish_bind_leaves_the_published_recording_alone() {
    use crate::service::binding::finish_bind;

    let mut session = Session::new("ios:AAAA");
    let bind = start_bind_for_agent(&mut session, &agent(), NOW).expect("the agent's bind");
    let epoch = bind.cleanup_epoch().expect("a cleanup to wait for");
    let assignment = resume_claim_for_agent(&mut session, &agent(), bind, false, true, NOW)
        .expect("the agent resumes")
        .expect("an assignment");
    finish_assign(&mut session, assignment, Some(&agent()), NOW).expect("the agent holds it");
    // The newly bound thread publishes a recording of its own.
    session.completed = Some(String::from("recording-2"));
    session.recording_artifact = Some(String::from("artifact-2"));

    // The same bind's success is delivered again, straight to `finish_bind`: the
    // reservation it consumed is the only thing that may refuse it.
    let refused = finish_bind(&mut session, "t1", epoch, false, true)
        .expect_err("the reservation was already consumed");
    assert_eq!(refused, words::refusal("bindingDisabled"));
    assert_eq!(session.thread_id.as_deref(), Some("t1"));
    assert_eq!(
        session.completed.as_deref(),
        Some("recording-2"),
        "a consumed reservation does not clear the live recording"
    );
    assert_eq!(session.recording_artifact.as_deref(), Some("artifact-2"));
}

#[test]
fn a_replayed_failed_bind_completion_leaves_the_live_recording_alone() {
    let mut session = Session::new("ios:AAAA");
    let bind = start_bind_for_agent(&mut session, &agent(), NOW).expect("the agent's bind");
    let replay = bind.clone();
    let assignment = resume_claim_for_agent(&mut session, &agent(), bind, false, true, NOW)
        .expect("the agent resumes")
        .expect("an assignment");
    finish_assign(&mut session, assignment, Some(&agent()), NOW).expect("the agent holds it");
    session.completed = Some(String::from("recording-2"));
    session.recording_artifact = Some(String::from("artifact-2"));

    let outcome = resume_claim_for_agent(&mut session, &agent(), replay, true, true, NOW)
        .expect("the replay reports its own failure");
    assert_eq!(outcome, None, "a failed cleanup never assigns control");
    assert_eq!(
        session.lease.status(NOW).controller,
        Controller::Agent,
        "the live holder keeps control"
    );
    assert_eq!(
        session.completed.as_deref(),
        Some("recording-2"),
        "a consumed reservation's failure does not clear the live recording"
    );
    assert_eq!(session.recording_artifact.as_deref(), Some("artifact-2"));
}

#[test]
fn a_stale_agent_resume_does_not_abort_a_persons_bind_in_flight() {
    let mut session = Session::new("ios:AAAA");
    let agent_bind = start_bind_for_agent(&mut session, &agent(), NOW).expect("agent bind");
    // The person takes control with a thread: their bind supersedes the agent's
    // and is still cleaning up when the agent's own cleanup lands.
    let takeover = start_human_controller_with_thread(&mut session, &person(), "t-view", NOW)
        .expect("person with thread");
    assert!(session.changing_binding, "the person's bind is running");
    session.completed = Some(String::from("person-recording"));

    let refused = resume_claim_for_agent(&mut session, &agent(), agent_bind, false, true, NOW)
        .expect_err("stale agent");
    assert_eq!(refused, words::refusal("controlChanged"));
    assert!(
        session.changing_binding,
        "the person's bind keeps its guard and epoch"
    );
    assert_eq!(
        session.completed.as_deref(),
        Some("person-recording"),
        "the person's own bind keeps its recording"
    );

    // The person's bind still finishes onto their thread.
    resume_human_controller_with_thread(
        &mut session,
        takeover,
        "t-view",
        Some(&person()),
        false,
        true,
        NOW,
    )
    .expect("the person's bind finishes");
    assert_eq!(session.thread_id.as_deref(), Some("t-view"));
    assert_eq!(session.lease.status(NOW).controller, Controller::Human);
}

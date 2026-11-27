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

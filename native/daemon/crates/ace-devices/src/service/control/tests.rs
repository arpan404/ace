// SPDX-License-Identifier: Apache-2.0
//! Who takes a device and how control moves (`service.ts:440`-`:464`, `:882`-`:896`):
//! priority 1, a person's takeover beats an agent's start.

use super::{
    AGENT_CALLER_REQUIRED, Assignment, Claim, authorize, begin_assign, cancel_assign,
    claim_for_agent, finish_assign, invalidate_pending_owner, require_person,
    resume_claim_for_agent, resume_human_controller_with_thread, start_bind_for_agent,
    start_human_controller_with_thread,
};
use crate::error::DeviceError;
use crate::error::DeviceErrorCode;
use crate::service::binding::begin_disable;
use crate::service::lease::{Actor, Controller};
use crate::service::session::Session;
use crate::service::words;

fn agent() -> Actor {
    Actor::agent("agent-1", "t1", "a1")
}

fn person() -> Actor {
    Actor::human("person")
}

const NOW: f64 = 0.0;

#[test]
fn an_agent_takes_a_free_device_for_its_thread() {
    let mut session = Session::new("ios:AAAA");
    assert_eq!(
        claim_for_agent(&mut session, &agent(), NOW),
        Ok(Claim::Take)
    );
}

#[test]
fn an_empty_thread_id_or_agent_id_is_agent_caller_required() {
    let mut session = Session::new("ios:AAAA");
    for actor in [
        Actor {
            kind: crate::service::lease::ActorKind::Agent,
            owner: String::from("agent-1"),
            thread_id: Some(String::new()),
            agent_id: Some(String::from("a1")),
        },
        Actor {
            kind: crate::service::lease::ActorKind::Agent,
            owner: String::from("agent-1"),
            thread_id: Some(String::from("t1")),
            agent_id: Some(String::new()),
        },
    ] {
        let refused = claim_for_agent(&mut session, &actor, NOW).expect_err("missing identity");
        assert_eq!(
            refused,
            DeviceError::InvalidInput(String::from(AGENT_CALLER_REQUIRED))
        );
    }
}

#[test]
fn a_person_controlling_refuses_an_agents_start() {
    let mut session = Session::new("ios:AAAA");
    session.lease.claim(person(), NOW);
    let refused = claim_for_agent(&mut session, &agent(), NOW).expect_err("a person has it");
    assert_eq!(refused, words::refusal("personControlling"));
    assert_eq!(refused.code(), DeviceErrorCode::LeaseRequired);
}

#[test]
fn another_agent_holding_it_refuses_an_agents_start() {
    let mut session = Session::new("ios:AAAA");
    let other = Actor::agent("agent-2", "t2", "a2");
    session.lease.claim(other, NOW);
    let refused = claim_for_agent(&mut session, &agent(), NOW).expect_err("another agent has it");
    assert_eq!(refused, words::refusal("otherAgentUsing"));
    assert_eq!(refused.code(), DeviceErrorCode::Busy);
}

#[test]
fn an_agent_that_already_holds_it_for_its_thread_changes_nothing() {
    let mut session = Session::new("ios:AAAA");
    session.thread_id = Some(String::from("t1"));
    session.lease.claim(agent(), NOW);
    assert_eq!(
        claim_for_agent(&mut session, &agent(), NOW),
        Ok(Claim::Already)
    );
}

#[test]
fn a_takeover_releases_control_before_it_claims() {
    let mut session = Session::new("ios:AAAA");
    session.lease.claim(agent(), NOW);
    begin_assign(&mut session, &person(), NOW).expect("a takeover");
    assert_eq!(session.lease.status(NOW).controller, Controller::None);
    assert_eq!(session.pending_controller.as_deref(), Some("person"));
}

#[test]
fn a_persons_takeover_wins_the_race_with_an_agents_start() {
    let mut session = Session::new("ios:AAAA");
    let agent_assign = begin_assign(&mut session, &agent(), NOW).expect("a takeover");
    let person_assign = begin_assign(&mut session, &person(), NOW).expect("a takeover");
    finish_assign(&mut session, person_assign, Some(&person()), NOW).expect("the person wins");

    let refused =
        finish_assign(&mut session, agent_assign, Some(&agent()), NOW).expect_err("passed");
    assert_eq!(refused, words::refusal("controlChanged"));
    assert_eq!(refused.code(), DeviceErrorCode::Busy);
    assert_eq!(session.lease.status(NOW).controller, Controller::Human);
    assert_eq!(session.pending_controller, None);
}

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
fn a_person_may_take_over_while_an_agent_is_binding_to_a_new_thread() {
    let mut session = Session::new("ios:AAAA");
    let bind = start_bind_for_agent(&mut session, &agent(), NOW).expect("bind in flight");
    assert!(session.changing_binding);
    authorize(&session, &person(), true, false).expect("bind does not block a person");

    let person_assign = begin_assign(&mut session, &person(), NOW).expect("person begins");
    finish_assign(&mut session, person_assign, Some(&person()), NOW).expect("person wins");

    let refused = resume_claim_for_agent(&mut session, &agent(), bind, false, true, NOW)
        .expect_err("person holds it");
    assert_eq!(refused, words::refusal("controlChanged"));
}

#[test]
fn an_agent_resuming_claim_after_a_person_finished_is_refused_not_released() {
    let mut session = Session::new("ios:AAAA");
    let bind = start_bind_for_agent(&mut session, &agent(), NOW).expect("bind");
    let person_assign = begin_assign(&mut session, &person(), NOW).expect("person");
    finish_assign(&mut session, person_assign, Some(&person()), NOW).expect("person wins");
    assert_eq!(session.pending_controller, None);

    let refused = resume_claim_for_agent(&mut session, &agent(), bind, false, true, NOW)
        .expect_err("late agent");
    assert_eq!(refused, words::refusal("controlChanged"));
    assert_eq!(session.lease.status(NOW).controller, Controller::Human);
}

#[test]
fn a_stale_agent_claim_after_a_person_hands_back_is_rejected_and_a_fresh_claim_succeeds() {
    let mut session = Session::new("ios:AAAA");
    let bind = start_bind_for_agent(&mut session, &agent(), NOW).expect("bind");
    let person_assign = begin_assign(&mut session, &person(), NOW).expect("person");
    finish_assign(&mut session, person_assign, Some(&person()), NOW).expect("person takes");
    let hand_back = begin_assign(&mut session, &person(), NOW).expect("hand back");
    finish_assign(&mut session, hand_back, None, NOW).expect("released");
    assert_eq!(session.lease.status(NOW).controller, Controller::None);

    let refused = resume_claim_for_agent(&mut session, &agent(), bind, false, true, NOW)
        .expect_err("stale claim");
    assert_eq!(refused, words::refusal("controlChanged"));
    assert!(!session.changing_binding);
    assert_eq!(session.thread_id, None);
    assert_eq!(
        claim_for_agent(&mut session, &agent(), NOW),
        Ok(Claim::Take)
    );

    // The fresh claim completes and the agent is the holder, not merely allowed.
    let bind = start_bind_for_agent(&mut session, &agent(), NOW).expect("fresh bind");
    let assignment = resume_claim_for_agent(&mut session, &agent(), bind, false, true, NOW)
        .expect("fresh resume")
        .expect("an assignment");
    finish_assign(&mut session, assignment, Some(&agent()), NOW).expect("the agent takes it");
    assert_eq!(session.thread_id.as_deref(), Some("t1"));
    assert_eq!(session.lease.status(NOW).controller, Controller::Agent);
}

#[test]
fn a_stale_agent_claim_after_the_person_dropped_mid_takeover_is_rejected() {
    let mut session = Session::new("ios:AAAA");
    let bind = start_bind_for_agent(&mut session, &agent(), NOW).expect("bind");
    let person_assign = begin_assign(&mut session, &person(), NOW).expect("person");
    invalidate_pending_owner(&mut session, "person");
    let refused =
        resume_claim_for_agent(&mut session, &agent(), bind, false, true, NOW).expect_err("stale");
    assert_eq!(refused, words::refusal("controlChanged"));
    assert_eq!(
        claim_for_agent(&mut session, &agent(), NOW),
        Ok(Claim::Take)
    );
    let _ = person_assign;

    // The fresh claim completes and the agent is the holder, not merely allowed.
    let bind = start_bind_for_agent(&mut session, &agent(), NOW).expect("fresh bind");
    let assignment = resume_claim_for_agent(&mut session, &agent(), bind, false, true, NOW)
        .expect("fresh resume")
        .expect("an assignment");
    finish_assign(&mut session, assignment, Some(&agent()), NOW).expect("the agent takes it");
    assert_eq!(session.thread_id.as_deref(), Some("t1"));
    assert_eq!(session.lease.status(NOW).controller, Controller::Agent);
}

#[test]
fn a_person_who_took_control_and_disconnected_lets_the_agent_claim_and_hold_it() {
    let mut session = Session::new("ios:AAAA");
    let person_assign = begin_assign(&mut session, &person(), NOW).expect("the person takes");
    finish_assign(&mut session, person_assign, Some(&person()), NOW).expect("the person holds it");
    assert_eq!(session.lease.status(NOW).controller, Controller::Human);

    invalidate_pending_owner(&mut session, "person");
    session.lease.release(Some("person"));
    assert_eq!(session.lease.status(NOW).controller, Controller::None);
    assert_eq!(
        claim_for_agent(&mut session, &agent(), NOW),
        Ok(Claim::Take)
    );

    let bind = start_bind_for_agent(&mut session, &agent(), NOW).expect("bind");
    let assignment = resume_claim_for_agent(&mut session, &agent(), bind, false, true, NOW)
        .expect("resume")
        .expect("an assignment");
    finish_assign(&mut session, assignment, Some(&agent()), NOW).expect("the agent takes it");
    assert_eq!(session.thread_id.as_deref(), Some("t1"));
    assert_eq!(session.lease.status(NOW).controller, Controller::Agent);
}

#[test]
fn a_persons_expired_control_lets_the_agent_claim_and_hold_it() {
    let mut session = Session::new("ios:AAAA");
    let person_assign = begin_assign(&mut session, &person(), NOW).expect("the person takes");
    finish_assign(&mut session, person_assign, Some(&person()), NOW).expect("the person holds it");
    let later = NOW + crate::service::lease::LEASE_MS + 1.0;
    assert_eq!(
        session.lease.status(later).controller,
        Controller::None,
        "the lease ran out"
    );
    assert_eq!(
        claim_for_agent(&mut session, &agent(), later),
        Ok(Claim::Take)
    );

    let bind = start_bind_for_agent(&mut session, &agent(), later).expect("bind");
    let assignment = resume_claim_for_agent(&mut session, &agent(), bind, false, true, later)
        .expect("resume")
        .expect("an assignment");
    finish_assign(&mut session, assignment, Some(&agent()), later).expect("the agent takes it");
    assert_eq!(session.thread_id.as_deref(), Some("t1"));
    assert_eq!(session.lease.status(later).controller, Controller::Agent);
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
fn a_person_who_hands_back_while_their_threaded_bind_cleans_up_frees_the_device_for_an_agent() {
    let mut session = Session::new("ios:AAAA");
    let takeover = start_human_controller_with_thread(&mut session, &person(), "t-person", NOW)
        .expect("the person begins first");
    let hand_back = begin_assign(&mut session, &person(), NOW).expect("hand back");
    finish_assign(&mut session, hand_back, None, NOW).expect("released");
    assert!(
        !session.changing_binding,
        "the hand-back retires the person's own bind reservation"
    );

    // The agent starts its own bind before the person's stale continuation runs.
    assert_eq!(
        claim_for_agent(&mut session, &agent(), NOW),
        Ok(Claim::Take)
    );
    let bind = start_bind_for_agent(&mut session, &agent(), NOW).expect("the agent's bind");
    let assignment = resume_claim_for_agent(&mut session, &agent(), bind, false, true, NOW)
        .expect("the agent resumes")
        .expect("an assignment");
    finish_assign(&mut session, assignment, Some(&agent()), NOW).expect("the agent holds it");
    assert_eq!(session.thread_id.as_deref(), Some("t1"));
    assert_eq!(session.lease.status(NOW).controller, Controller::Agent);

    // The person's stale continuation changes nothing.
    let refused = resume_human_controller_with_thread(
        &mut session,
        takeover,
        "t-person",
        Some(&person()),
        false,
        true,
        NOW,
    )
    .expect_err("the person's assignment was handed back");
    assert_eq!(refused, words::refusal("controlChanged"));
    assert_eq!(session.thread_id.as_deref(), Some("t1"));
    assert_eq!(session.lease.status(NOW).controller, Controller::Agent);
}

#[test]
fn a_person_who_drops_while_their_threaded_bind_cleans_up_frees_the_device_for_an_agent() {
    let mut session = Session::new("ios:AAAA");
    let takeover = start_human_controller_with_thread(&mut session, &person(), "t-person", NOW)
        .expect("the person begins first");
    invalidate_pending_owner(&mut session, "person");
    assert!(
        !session.changing_binding,
        "the owner drop retires the person's own bind reservation"
    );

    // The agent starts its own bind before the person's stale continuation runs.
    assert_eq!(
        claim_for_agent(&mut session, &agent(), NOW),
        Ok(Claim::Take)
    );
    let bind = start_bind_for_agent(&mut session, &agent(), NOW).expect("the agent's bind");
    let assignment = resume_claim_for_agent(&mut session, &agent(), bind, false, true, NOW)
        .expect("the agent resumes")
        .expect("an assignment");
    finish_assign(&mut session, assignment, Some(&agent()), NOW).expect("the agent holds it");
    assert_eq!(session.thread_id.as_deref(), Some("t1"));
    assert_eq!(session.lease.status(NOW).controller, Controller::Agent);

    // The person's stale continuation changes nothing.
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
    assert_eq!(session.thread_id.as_deref(), Some("t1"));
    assert_eq!(session.lease.status(NOW).controller, Controller::Agent);
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
fn the_same_person_may_hand_back_while_their_own_takeover_is_still_pending() {
    let mut session = Session::new("ios:AAAA");
    session.lease.claim(agent(), NOW);
    let first = begin_assign(&mut session, &person(), NOW).expect("takeover begins");
    let hand_back = begin_assign(&mut session, &person(), NOW).expect("hand back begins");
    finish_assign(&mut session, hand_back, None, NOW).expect("released");
    assert_eq!(session.lease.status(NOW).controller, Controller::None);
    let refused = finish_assign(&mut session, first, Some(&person()), NOW).expect_err("stale");
    assert_eq!(refused, words::refusal("controlChanged"));
}

#[test]
fn a_threaded_person_whose_bind_hits_a_disable_leaves_no_pending_marker() {
    let mut session = Session::new("ios:AAAA");
    let takeover = start_human_controller_with_thread(&mut session, &person(), "t-view", NOW)
        .expect("the person's takeover");
    begin_disable(&mut session);
    let refused = resume_human_controller_with_thread(
        &mut session,
        takeover,
        "t-view",
        Some(&person()),
        false,
        false,
        NOW,
    )
    .expect_err("devices are off");
    assert_eq!(refused, words::refusal("bindingDisabled"));
    assert_eq!(
        session.pending_controller, None,
        "the marker is cancelled with its own assignment"
    );
    assert_eq!(session.lease.status(NOW).controller, Controller::None);

    // Back on, a fresh claim reaches a holder instead of being blocked by a marker.
    let assignment = begin_assign(&mut session, &person(), NOW).expect("a fresh claim");
    finish_assign(&mut session, assignment, Some(&person()), NOW).expect("the person holds it");
    assert_eq!(session.lease.status(NOW).controller, Controller::Human);
}

#[test]
fn an_unchanged_person_bind_cannot_grant_control_while_devices_are_off() {
    let mut session = Session::new("ios:AAAA");
    session.thread_id = Some(String::from("t-view"));
    let takeover = start_human_controller_with_thread(&mut session, &person(), "t-view", NOW)
        .expect("the person's takeover");
    let refused = resume_human_controller_with_thread(
        &mut session,
        takeover,
        "t-view",
        Some(&person()),
        false,
        false,
        NOW,
    )
    .expect_err("devices are off");
    assert_eq!(refused, words::refusal("bindingDisabled"));
    assert_eq!(session.pending_controller, None);
    assert_eq!(session.lease.status(NOW).controller, Controller::None);

    let assignment = begin_assign(&mut session, &person(), NOW).expect("a fresh claim");
    finish_assign(&mut session, assignment, Some(&person()), NOW).expect("the person holds it");
    assert_eq!(session.lease.status(NOW).controller, Controller::Human);
}

#[test]
fn a_person_bind_on_the_same_thread_refuses_across_a_disable_and_re_enable() {
    let mut session = Session::new("ios:AAAA");
    session.thread_id = Some(String::from("t-view"));
    let takeover = start_human_controller_with_thread(&mut session, &person(), "t-view", NOW)
        .expect("the person's takeover");
    begin_disable(&mut session);
    let refused = resume_human_controller_with_thread(
        &mut session,
        takeover,
        "t-view",
        Some(&person()),
        false,
        true,
        NOW,
    )
    .expect_err("the disable passed it");
    assert_eq!(refused, words::refusal("bindingDisabled"));
    assert_eq!(session.pending_controller, None);
    assert_eq!(session.lease.status(NOW).controller, Controller::None);

    let assignment = begin_assign(&mut session, &person(), NOW).expect("a fresh claim");
    finish_assign(&mut session, assignment, Some(&person()), NOW).expect("the person holds it");
    assert_eq!(session.lease.status(NOW).controller, Controller::Human);
}

#[test]
fn an_unchanged_agent_bind_cannot_grant_control_while_devices_are_off() {
    let mut session = Session::new("ios:AAAA");
    session.thread_id = Some(String::from("t1"));
    let bind = start_bind_for_agent(&mut session, &agent(), NOW).expect("an unchanged bind");
    let refused = resume_claim_for_agent(&mut session, &agent(), bind, false, false, NOW)
        .expect_err("devices are off");
    assert_eq!(refused, words::refusal("bindingDisabled"));
    assert_eq!(session.lease.status(NOW).controller, Controller::None);

    let bind = start_bind_for_agent(&mut session, &agent(), NOW).expect("a fresh bind");
    let assignment = resume_claim_for_agent(&mut session, &agent(), bind, false, true, NOW)
        .expect("the agent resumes")
        .expect("an assignment");
    finish_assign(&mut session, assignment, Some(&agent()), NOW).expect("the agent holds it");
    assert_eq!(session.lease.status(NOW).controller, Controller::Agent);
}

#[test]
fn an_unchanged_agent_bind_refuses_across_a_disable_and_re_enable() {
    let mut session = Session::new("ios:AAAA");
    session.thread_id = Some(String::from("t1"));
    let bind = start_bind_for_agent(&mut session, &agent(), NOW).expect("an unchanged bind");
    begin_disable(&mut session);
    let refused = resume_claim_for_agent(&mut session, &agent(), bind, false, true, NOW)
        .expect_err("the disable passed it");
    assert_eq!(refused, words::refusal("bindingDisabled"));
    assert_eq!(session.lease.status(NOW).controller, Controller::None);

    let bind = start_bind_for_agent(&mut session, &agent(), NOW).expect("a fresh bind");
    let assignment = resume_claim_for_agent(&mut session, &agent(), bind, false, true, NOW)
        .expect("the agent resumes")
        .expect("an assignment");
    finish_assign(&mut session, assignment, Some(&agent()), NOW).expect("the agent holds it");
    assert_eq!(session.lease.status(NOW).controller, Controller::Agent);
}

#[test]
fn an_agents_bind_that_a_disable_passed_is_refused_and_a_fresh_claim_holds() {
    let mut session = Session::new("ios:AAAA");
    let bind = start_bind_for_agent(&mut session, &agent(), NOW).expect("the agent's bind");
    begin_disable(&mut session);
    let refused = resume_claim_for_agent(&mut session, &agent(), bind, false, true, NOW)
        .expect_err("the disable passed it");
    assert_eq!(refused, words::refusal("bindingDisabled"));
    assert_eq!(session.lease.status(NOW).controller, Controller::None);

    let bind = start_bind_for_agent(&mut session, &agent(), NOW).expect("a fresh bind");
    let assignment = resume_claim_for_agent(&mut session, &agent(), bind, false, true, NOW)
        .expect("the agent resumes")
        .expect("an assignment");
    finish_assign(&mut session, assignment, Some(&agent()), NOW).expect("the agent holds it");
    assert_eq!(session.lease.status(NOW).controller, Controller::Agent);
}

#[test]
fn a_disable_during_an_agents_assignment_cleanup_grants_no_lease_and_a_fresh_claim_holds() {
    let mut session = Session::new("ios:AAAA");
    let bind = start_bind_for_agent(&mut session, &agent(), NOW).expect("the agent's bind");
    let stale = resume_claim_for_agent(&mut session, &agent(), bind, false, true, NOW)
        .expect("the agent resumes")
        .expect("an assignment");
    // The shell is releasing the capture's input when devices are turned off, and
    // the cleanup returns once they are on again.
    begin_disable(&mut session);

    let refused = finish_assign(&mut session, stale, Some(&agent()), NOW)
        .expect_err("the disable passed the takeover");
    assert_eq!(refused, words::refusal("controlChanged"));
    assert_eq!(session.lease.status(NOW).controller, Controller::None);
    assert_eq!(session.pending_controller, None);

    // Back on, a fresh claim reaches a holder.
    let bind = start_bind_for_agent(&mut session, &agent(), NOW).expect("a fresh bind");
    let fresh = resume_claim_for_agent(&mut session, &agent(), bind, false, true, NOW)
        .expect("the agent resumes")
        .expect("an assignment");
    finish_assign(&mut session, fresh, Some(&agent()), NOW).expect("the fresh claim holds it");
    assert_eq!(session.thread_id.as_deref(), Some("t1"));
    assert_eq!(session.lease.status(NOW).controller, Controller::Agent);
}

#[test]
fn a_disable_during_a_threadless_persons_assignment_cleanup_grants_no_lease_and_a_fresh_claim_holds()
 {
    let mut session = Session::new("ios:AAAA");
    let stale = begin_assign(&mut session, &person(), NOW).expect("the person begins");
    // The shell is releasing the capture's input when devices are turned off, and
    // the cleanup returns once they are on again.
    begin_disable(&mut session);

    let refused = finish_assign(&mut session, stale, Some(&person()), NOW)
        .expect_err("the disable passed the takeover");
    assert_eq!(refused, words::refusal("controlChanged"));
    assert_eq!(session.lease.status(NOW).controller, Controller::None);
    assert_eq!(session.pending_controller, None);

    // Back on, a fresh claim reaches a holder.
    let fresh = begin_assign(&mut session, &person(), NOW).expect("a fresh claim");
    finish_assign(&mut session, fresh, Some(&person()), NOW).expect("the fresh claim holds it");
    assert_eq!(session.lease.status(NOW).controller, Controller::Human);
}

#[test]
fn an_agents_cleanup_failure_racing_a_disable_reports_the_failure_not_the_disable() {
    let mut session = Session::new("ios:AAAA");
    let bind = start_bind_for_agent(&mut session, &agent(), NOW).expect("the agent's bind");
    begin_disable(&mut session);
    let outcome = resume_claim_for_agent(&mut session, &agent(), bind, true, true, NOW)
        .expect("the cleanup failure is reported ahead of the disable");
    assert_eq!(outcome, None, "the failed cleanup never assigns control");
    assert_eq!(session.lease.status(NOW).controller, Controller::None);
}

#[test]
fn cancelling_an_unrelated_owners_assignment_leaves_the_pending_marker() {
    let mut session = Session::new("ios:AAAA");
    let agent_assign = begin_assign(&mut session, &agent(), NOW).expect("agent");
    let revision = session.control_revision;
    let unrelated = Assignment {
        revision: agent_assign.revision,
        generation: agent_assign.generation,
        kind: agent_assign.kind,
        owner: String::from("someone-else"),
    };
    cancel_assign(&mut session, unrelated);
    assert_eq!(session.control_revision, revision);
    assert_eq!(session.pending_controller.as_deref(), Some("agent-1"));
}

#[test]
fn a_control_change_during_the_cleanup_refuses_the_late_holder() {
    let mut session = Session::new("ios:AAAA");
    let assignment = begin_assign(&mut session, &agent(), NOW).expect("a takeover");
    session.generation = 1;
    let refused = finish_assign(&mut session, assignment, Some(&agent()), NOW)
        .expect_err("the device changed under it");
    assert_eq!(refused.code(), DeviceErrorCode::Busy);
    assert_eq!(session.lease.status(NOW).controller, Controller::None);
    assert_eq!(
        session.pending_controller, None,
        "the marker cleared so a later start is not refused forever"
    );
}

#[test]
fn a_fresh_claim_works_after_a_generation_mismatch_cleared_the_marker() {
    let mut session = Session::new("ios:AAAA");
    let assignment = begin_assign(&mut session, &agent(), NOW).expect("a takeover");
    session.generation = 1;
    let _ = finish_assign(&mut session, assignment, Some(&agent()), NOW);
    assert_eq!(session.pending_controller, None);
    assert_eq!(
        claim_for_agent(&mut session, &agent(), NOW),
        Ok(Claim::Take)
    );
}

#[test]
fn a_late_completion_after_the_owner_dropped_does_not_claim_control() {
    let mut session = Session::new("ios:AAAA");
    let assignment = begin_assign(&mut session, &person(), NOW).expect("a takeover");
    invalidate_pending_owner(&mut session, "person");
    let refused =
        finish_assign(&mut session, assignment, Some(&person()), NOW).expect_err("dropped");
    assert_eq!(refused, words::refusal("controlChanged"));
    assert_eq!(session.lease.status(NOW).controller, Controller::None);
}

#[test]
fn a_second_person_supersedes_a_pending_persons_takeover() {
    let mut session = Session::new("ios:AAAA");
    let first = begin_assign(&mut session, &person(), NOW).expect("the first person");
    let other = Actor::human("person-2");
    let second = begin_assign(&mut session, &other, NOW).expect("a later person");
    finish_assign(&mut session, second, Some(&other), NOW).expect("the later person holds it");
    let refused = finish_assign(&mut session, first, Some(&person()), NOW).expect_err("passed");
    assert_eq!(refused, words::refusal("controlChanged"));
    assert_eq!(session.pending_controller, None);
    assert_eq!(session.lease.status(NOW).controller, Controller::Human);
    assert!(
        session.lease.owned("person-2", NOW),
        "the later person holds it"
    );
}

#[test]
fn a_person_taking_control_without_a_thread_still_clears_the_agents_recording() {
    let mut session = Session::new("ios:AAAA");
    session.completed = Some(String::from("recording-1"));
    session.recording_artifact = Some(String::from("artifact-1"));
    let bind = start_bind_for_agent(&mut session, &agent(), NOW).expect("agent bind");
    let person_assign =
        begin_assign(&mut session, &person(), NOW).expect("the person takes control");
    finish_assign(&mut session, person_assign, Some(&person()), NOW).expect("the person holds it");

    let refused = resume_claim_for_agent(&mut session, &agent(), bind, false, true, NOW)
        .expect_err("control changed");
    assert_eq!(refused, words::refusal("controlChanged"));
    assert_eq!(
        session.completed, None,
        "the old thread's recording is cleaned"
    );
    assert_eq!(session.recording_artifact, None);
    assert_eq!(session.lease.status(NOW).controller, Controller::Human);
    assert!(!session.changing_binding);
}

#[test]
fn cancelling_a_takeover_invalidates_so_a_late_finish_cannot_claim() {
    let mut session = Session::new("ios:AAAA");
    let assignment = begin_assign(&mut session, &person(), NOW).expect("a takeover");
    cancel_assign(&mut session, assignment.clone());
    assert_eq!(session.pending_controller, None);
    let refused =
        finish_assign(&mut session, assignment, Some(&person()), NOW).expect_err("cancelled");
    assert_eq!(refused, words::refusal("controlChanged"));
    assert_eq!(session.lease.status(NOW).controller, Controller::None);
}

#[test]
fn handing_control_back_releases_it() {
    let mut session = Session::new("ios:AAAA");
    session.lease.claim(agent(), NOW);
    let assignment = begin_assign(&mut session, &agent(), NOW).expect("a takeover");
    finish_assign(&mut session, assignment, None, NOW).expect("released");
    assert_eq!(session.lease.status(NOW).controller, Controller::None);
    assert_eq!(session.pending_controller, None);
}

#[test]
fn authorize_refuses_disabled_devices_and_another_threads_device() {
    let mut session = Session::new("ios:AAAA");
    let refused = authorize(&session, &agent(), false, false).expect_err("disabled");
    assert_eq!(refused, words::refusal("devicesDisabled"));
    assert_eq!(refused.code(), DeviceErrorCode::PermissionDenied);

    session.thread_id = Some(String::from("t2"));
    let refused = authorize(&session, &agent(), true, false).expect_err("another thread's");
    assert_eq!(refused, words::refusal("deviceNotTaken"));
    assert_eq!(refused.code(), DeviceErrorCode::LeaseRequired);

    authorize(&session, &person(), true, false).expect("a person");
    session.changing_binding = true;
    authorize(&session, &person(), true, false).expect("bind does not block a person");
    assert_eq!(
        authorize(&session, &agent(), true, false),
        Err(words::refusal("devicesDisabled"))
    );
}

#[test]
fn a_persons_takeover_that_began_first_wins() {
    let mut session = Session::new("ios:AAAA");
    let person_assign = begin_assign(&mut session, &person(), NOW).expect("a takeover");
    let refused =
        claim_for_agent(&mut session, &agent(), NOW).expect_err("a person's takeover is in flight");
    assert_eq!(refused, words::refusal("personControlling"));

    finish_assign(&mut session, person_assign, Some(&person()), NOW).expect("the person wins");
    assert_eq!(session.lease.status(NOW).controller, Controller::Human);
}

#[test]
fn an_agents_takeover_is_refused_while_a_persons_is_pending() {
    let mut session = Session::new("ios:AAAA");
    let person_assign = begin_assign(&mut session, &person(), NOW).expect("a takeover");
    let refused = begin_assign(&mut session, &agent(), NOW).expect_err("the person began first");
    assert_eq!(refused, words::refusal("personControlling"));
    finish_assign(&mut session, person_assign, Some(&person()), NOW).expect("the person wins");
}

#[test]
fn a_second_agents_takeover_supersedes_the_first() {
    let mut session = Session::new("ios:AAAA");
    let first = begin_assign(&mut session, &agent(), NOW).expect("an agent");
    let other = Actor::agent("agent-2", "t2", "a2");
    let second = begin_assign(&mut session, &other, NOW).expect("a later agent");
    finish_assign(&mut session, second, Some(&other), NOW).expect("the later agent");
    let refused = finish_assign(&mut session, first, Some(&agent()), NOW).expect_err("passed");
    assert_eq!(refused, words::refusal("controlChanged"));
}

#[test]
fn a_failed_takeover_clears_its_pending_controller() {
    let mut session = Session::new("ios:AAAA");
    let assignment = begin_assign(&mut session, &person(), NOW).expect("a takeover");
    assert_eq!(session.pending_controller.as_deref(), Some("person"));
    cancel_assign(&mut session, assignment);
    assert_eq!(session.pending_controller, None);
    assert_eq!(
        claim_for_agent(&mut session, &agent(), NOW),
        Ok(Claim::Take)
    );
}

#[test]
fn a_cancelled_takeover_that_was_passed_changes_nothing() {
    let mut session = Session::new("ios:AAAA");
    let first = begin_assign(&mut session, &agent(), NOW).expect("an agent");
    let other = Actor::agent("agent-2", "t2", "a2");
    begin_assign(&mut session, &other, NOW).expect("a later agent");
    cancel_assign(&mut session, first);
    assert_eq!(session.pending_controller.as_deref(), Some("agent-2"));
}

#[test]
fn ace_s_own_person_only_actions_refuse_an_agent() {
    for operation in [
        "enable",
        "controller",
        "stream.configure",
        "stream.keyframe",
    ] {
        let refused = require_person(operation, &agent()).expect_err(operation);
        assert_eq!(refused, words::refusal("personOnly"), "{operation}");
        assert_eq!(refused.code(), DeviceErrorCode::PermissionDenied);
    }
    assert_eq!(
        require_person("tools.install", &agent()),
        Err(words::refusal("toolsPersonOnly"))
    );
    assert_eq!(
        require_person("permissions.request", &agent()),
        Err(words::refusal("humanAuthorization"))
    );
    for operation in [
        "enable",
        "controller",
        "tools.install",
        "permissions.request",
    ] {
        require_person(operation, &person()).expect(operation);
    }
    for operation in [
        "list",
        "states",
        "boot",
        "input",
        "screenshot",
        "permissions",
    ] {
        require_person(operation, &agent()).expect(operation);
    }
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

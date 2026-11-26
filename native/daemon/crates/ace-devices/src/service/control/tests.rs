// SPDX-License-Identifier: Apache-2.0
//! Who takes a device and how control moves (`service.ts:440`-`:464`, `:882`-`:896`):
//! priority 1, a person's takeover beats an agent's start.

use super::{Assignment, Claim, authorize, begin_assign, claim_for_agent, finish_assign};
use crate::error::DeviceErrorCode;
use crate::service::lease::{Actor, Controller};
use crate::service::session::Session;
use crate::service::words;

fn agent() -> Actor {
    Actor::agent("agent-1", "t1", "a1")
}

fn person() -> Actor {
    Actor::human("person")
}

#[test]
fn an_agent_takes_a_free_device_for_its_thread() {
    let mut session = Session::new("ios:AAAA");
    assert_eq!(
        claim_for_agent(&mut session, &agent(), 0.0),
        Ok(Claim::Take)
    );
}

#[test]
fn a_person_controlling_refuses_an_agents_start() {
    let mut session = Session::new("ios:AAAA");
    session.lease.claim(person(), 0.0);
    let refused = claim_for_agent(&mut session, &agent(), 0.0).expect_err("a person has it");
    assert_eq!(refused, words::refusal("personControlling"));
    assert_eq!(refused.code(), DeviceErrorCode::LeaseRequired);
}

#[test]
fn another_agent_holding_it_refuses_an_agents_start() {
    let mut session = Session::new("ios:AAAA");
    let other = Actor::agent("agent-2", "t2", "a2");
    session.lease.claim(other, 0.0);
    let refused = claim_for_agent(&mut session, &agent(), 0.0).expect_err("another agent has it");
    assert_eq!(refused, words::refusal("otherAgentUsing"));
    assert_eq!(refused.code(), DeviceErrorCode::Busy);
}

#[test]
fn an_agent_that_already_holds_it_for_its_thread_changes_nothing() {
    let mut session = Session::new("ios:AAAA");
    session.thread_id = Some(String::from("t1"));
    session.lease.claim(agent(), 0.0);
    assert_eq!(
        claim_for_agent(&mut session, &agent(), 0.0),
        Ok(Claim::Already)
    );
}

#[test]
fn a_takeover_releases_control_before_it_claims() {
    let mut session = Session::new("ios:AAAA");
    session.lease.claim(agent(), 0.0);
    begin_assign(&mut session, "person");
    // The gap the person may take the device in: nobody controls it, and the
    // takeover is marked as pending.
    assert_eq!(session.lease.status(0.0).controller, Controller::None);
    assert_eq!(session.pending_controller.as_deref(), Some("person"));
}

#[test]
fn a_persons_takeover_wins_the_race_with_an_agents_start() {
    let mut session = Session::new("ios:AAAA");
    // The agent's sim_start has begun: its takeover released the lease and is
    // cleaning the capture up.
    let agent_assign = begin_assign(&mut session, "agent-1");
    // In that gap the person takes the device.
    let person_assign = begin_assign(&mut session, "person");
    finish_assign(&mut session, person_assign, Some(&person()), 0.0).expect("the person wins");

    // The agent's start comes back to find control changed under it.
    let refused =
        finish_assign(&mut session, agent_assign, Some(&agent()), 0.0).expect_err("passed");
    assert_eq!(refused, words::refusal("controlChanged"));
    assert_eq!(refused.code(), DeviceErrorCode::Busy);
    assert_eq!(session.lease.status(0.0).controller, Controller::Human);
    assert_eq!(
        session.pending_controller, None,
        "the person's takeover finished"
    );
}

#[test]
fn a_control_change_during_the_cleanup_refuses_the_late_holder() {
    let mut session = Session::new("ios:AAAA");
    let assignment = begin_assign(&mut session, "agent-1");
    // A bind moved the generation while the capture cleaned up.
    session.generation = 1;
    let refused = finish_assign(&mut session, assignment, Some(&agent()), 0.0)
        .expect_err("the device changed under it");
    assert_eq!(refused.code(), DeviceErrorCode::Busy);
    assert_eq!(session.lease.status(0.0).controller, Controller::None);
}

#[test]
fn handing_control_back_releases_it() {
    let mut session = Session::new("ios:AAAA");
    session.lease.claim(agent(), 0.0);
    let assignment: Assignment = begin_assign(&mut session, "agent-1");
    finish_assign(&mut session, assignment, None, 0.0).expect("released");
    assert_eq!(session.lease.status(0.0).controller, Controller::None);
    assert_eq!(session.pending_controller, None);
}

#[test]
fn authorize_refuses_disabled_devices_and_another_threads_device() {
    let mut session = Session::new("ios:AAAA");
    let refused = authorize(&session, &agent(), false, false).expect_err("disabled");
    assert_eq!(refused, words::refusal("devicesDisabled"));
    assert_eq!(refused.code(), DeviceErrorCode::PermissionDenied);

    // An agent acts only on the device its thread took.
    session.thread_id = Some(String::from("t2"));
    let refused = authorize(&session, &agent(), true, false).expect_err("another thread's");
    assert_eq!(refused, words::refusal("deviceNotTaken"));
    assert_eq!(refused.code(), DeviceErrorCode::LeaseRequired);

    // A person's input is not tied to a thread.
    authorize(&session, &person(), true, false).expect("a person");
    // A bind in flight disables the device too.
    session.changing_binding = true;
    assert_eq!(
        authorize(&session, &person(), true, false),
        Err(words::refusal("devicesDisabled"))
    );
}

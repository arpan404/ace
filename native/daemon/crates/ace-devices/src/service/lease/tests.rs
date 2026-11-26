// SPDX-License-Identifier: Apache-2.0
//! The controller lease (`lease.ts` rule for rule): the claim, the takeover's
//! epoch, the expiry with its kept actor, the retained tickets, and the two
//! rules of behaviour.md §3.

use super::{Actor, ActorKind, Controller, ControllerLease, LEASE_MS, agent_owner};
use crate::error::{DeviceError, DeviceErrorCode};
use crate::service::words;

fn human(owner: &str) -> Actor {
    Actor::human(owner)
}

fn agent(owner: &str) -> Actor {
    Actor::agent(owner, "t1", "a1")
}

#[test]
fn a_claim_takes_the_control_for_thirty_seconds() {
    let mut lease = ControllerLease::new();
    assert_eq!(lease.status(0.0).controller, Controller::None);

    lease.claim(human("person"), 1_000.0);
    let status = lease.status(1_000.0);
    assert_eq!(status.controller, Controller::Human);
    assert_eq!(status.expires_at, Some(1_000.0 + LEASE_MS));
    assert_eq!(status.holder, None, "a person is not a thread's holder");
    assert_eq!(lease.control_epoch(1_000.0), 1);

    // An agent's status names its thread and agent.
    lease.claim(agent("agent-1"), 2_000.0);
    let status = lease.status(2_000.0);
    assert_eq!(status.controller, Controller::Agent);
    assert_eq!(
        status
            .holder
            .map(|holder| (holder.thread_id, holder.agent_id)),
        Some((String::from("t1"), String::from("a1")))
    );
    assert_eq!(
        lease.control_epoch(2_000.0),
        2,
        "a takeover moves the epoch"
    );
}

#[test]
fn an_agent_without_both_ids_has_no_holder() {
    let mut lease = ControllerLease::new();
    let mut half = agent("agent-1");
    half.agent_id = None;
    lease.claim(half, 0.0);
    assert_eq!(lease.status(0.0).holder, None);
}

#[test]
fn a_lease_expires_at_its_deadline_and_keeps_the_actor_for_resume_only() {
    let mut lease = ControllerLease::new();
    lease.claim(agent("agent-1"), 0.0);
    let claimed = lease.control_epoch(0.0);

    // Just before the deadline it still holds, and reading it renews nothing.
    assert_eq!(lease.status(LEASE_MS - 1.0).controller, Controller::Agent);
    // At the deadline it is gone, and the control's epoch moved.
    let expired = lease.status(LEASE_MS);
    assert_eq!(expired.controller, Controller::None);
    assert_eq!(expired.expires_at, None);
    assert_ne!(lease.control_epoch(LEASE_MS), claimed);

    // Only the expired delegation resumes; a person never does.
    assert!(!lease.resume(human("person"), LEASE_MS));
    assert!(lease.resume(agent("agent-1"), LEASE_MS));
    assert_eq!(lease.status(LEASE_MS).controller, Controller::Agent);
}

#[test]
fn a_takeover_revokes_the_previous_holder_and_never_resumes_it() {
    let mut lease = ControllerLease::new();
    lease.claim(agent("agent-1"), 0.0);
    lease.claim(human("person"), 1.0);

    // The agent's epoch and actor are both gone: neither resume nor a ticket works.
    assert!(!lease.resume(agent("agent-1"), 1.0));
    assert_eq!(
        lease
            .ticket(&agent("agent-1"), 1.0)
            .map_err(|error| error.code()),
        Err(DeviceErrorCode::LeaseRequired)
    );
    assert!(lease.owned("person", 1.0));
    assert!(!lease.owned("agent-1", 1.0));
}

#[test]
fn a_release_only_answers_its_own_owner_and_a_free_device_keeps_its_epoch() {
    let mut lease = ControllerLease::new();
    lease.claim(human("person"), 0.0);
    let held = lease.control_epoch(0.0);

    // Another owner's release changes nothing at all.
    lease.release(Some("someone-else"));
    assert!(lease.owned("person", 0.0));
    assert_eq!(lease.control_epoch(0.0), held);

    // The holder's release frees it and moves the epoch.
    lease.release(Some("person"));
    assert_eq!(lease.status(0.0).controller, Controller::None);
    assert_eq!(lease.control_epoch(0.0), held + 1);

    // Releasing a device nobody holds invalidates nothing.
    let free = lease.control_epoch(0.0);
    lease.release(None);
    lease.release(Some("person"));
    assert_eq!(lease.control_epoch(0.0), free);
}

#[test]
fn an_expired_delegation_is_released_by_its_owner_without_moving_the_epoch() {
    let mut lease = ControllerLease::new();
    lease.claim(agent("agent-1"), 0.0);
    lease.status(LEASE_MS);
    let after_expiry = lease.control_epoch(LEASE_MS);

    // The owner's release clears the expired actor, so it cannot resume.
    lease.release(Some("agent-1"));
    assert_eq!(lease.control_epoch(LEASE_MS), after_expiry);
    assert!(!lease.resume(agent("agent-1"), LEASE_MS));
}

#[test]
fn a_retained_ticket_keeps_the_lease_alive_until_it_is_released() {
    let mut lease = ControllerLease::new();
    lease.claim(agent("agent-1"), 0.0);
    let ticket = lease.retain(&agent("agent-1"), 1, 0.0).expect("held");

    // Pending work renews the deadline on every read, past the original one.
    assert_eq!(
        lease.status(LEASE_MS * 2.0).expires_at,
        Some(LEASE_MS * 3.0)
    );
    assert_eq!(lease.status(LEASE_MS * 2.0).controller, Controller::Agent);

    // A ticket is consumed by its release, so a second one cannot happen (the
    // TypeScript's closure flag); the count it held is gone either way.
    lease.release_retained(ticket);
    assert_eq!(
        lease.status(LEASE_MS * 3.0).controller,
        Controller::None,
        "without the ticket the lease expires as usual"
    );
}

#[test]
fn a_ticket_is_refused_for_another_epoch_or_another_owner() {
    let mut lease = ControllerLease::new();
    lease.claim(agent("agent-1"), 0.0);
    let stale = 7;
    assert_eq!(
        lease
            .retain(&agent("agent-1"), stale, 0.0)
            .map_err(|error| error.code()),
        Err(DeviceErrorCode::LeaseRequired)
    );
    assert_eq!(
        lease
            .ticket(&agent("other"), 0.0)
            .map_err(|error| error.code()),
        Err(DeviceErrorCode::LeaseRequired)
    );
    // The kind matters too: a person's name on an agent's control is not the holder.
    assert_eq!(
        lease
            .ticket(&human("agent-1"), 0.0)
            .map_err(|error| error.code()),
        Err(DeviceErrorCode::LeaseRequired)
    );
}

#[test]
fn asserting_the_lease_renews_it_and_names_the_way_back() {
    let mut lease = ControllerLease::new();
    lease.claim(agent("agent-1"), 0.0);
    lease
        .assert_held(&agent("agent-1"), None, 20_000.0)
        .expect("held");
    assert_eq!(
        lease.status(20_000.0).expires_at,
        Some(20_000.0 + LEASE_MS),
        "the assert renewed it"
    );

    let refused = lease
        .assert_held(&human("person"), None, 20_000.0)
        .expect_err("a person does not hold the agent's lease");
    assert_eq!(refused.code(), DeviceErrorCode::LeaseRequired);
    // The words are the catalog's, not this crate's.
    assert_eq!(refused, words::refusal("leaseRequired"));
}

#[test]
fn an_agent_owner_is_the_json_pair_the_type_script_writes() {
    assert_eq!(agent_owner("t1", "a1"), r#"["t1","a1"]"#);
    // A quote in either id is escaped as JSON.stringify escapes it.
    assert_eq!(agent_owner("t\"1", "a1"), r#"["t\"1","a1"]"#);
    assert_eq!(ActorKind::Agent.as_str(), "agent");
}

#[test]
fn an_empty_thread_or_agent_id_names_no_holder() {
    let mut lease = ControllerLease::new();
    // `lease.ts` tests the ids by truthiness, so "" is no holder at all.
    lease.claim(Actor::agent("agent-1", "", "a1"), 0.0);
    assert_eq!(lease.status(0.0).holder, None);
    lease.claim(Actor::agent("agent-1", "t1", ""), 0.0);
    assert_eq!(lease.status(0.0).holder, None);
}

#[test]
fn many_pending_actions_on_one_epoch_keep_one_retained_count() {
    let mut lease = ControllerLease::new();
    let agent = agent("agent-1");
    lease.claim(agent.clone(), 0.0);
    let tickets: Vec<_> = (0..64)
        .map(|_| lease.retain(&agent, 1, 0.0).expect("held"))
        .collect();
    assert_eq!(lease.retained_epochs(), 1, "per epoch, never per call");
    for ticket in tickets {
        lease.release_retained(ticket);
    }
    assert_eq!(lease.retained_epochs(), 0);
}

// SPDX-License-Identifier: Apache-2.0
//! The device input queue (`input-queue.ts`): 32 per kind, a person's lane the
//! agents cannot fill, and a takeover that invalidates a waiting agent's input.
//!
//! `input-queue.ts` has no test file of its own (behaviour.md §5 lists none), so
//! these cases are the module's only guard.

use ace_json::{Value, json};

use super::{
    MAX_PENDING_PER_KIND, PendingInput, admit, admit_shared, finish, finish_shared, guard,
    shared_guard, with_waited,
};
use crate::error::DeviceErrorCode;
use crate::service::lease::{Actor, ActorKind, Controller, ControllerLease, LEASE_MS};
use crate::service::words;

fn agent() -> Actor {
    Actor::agent("agent-1", "t1", "a1")
}

fn person() -> Actor {
    Actor::human("person")
}

fn held_lease(actor: &Actor) -> ControllerLease {
    let mut lease = ControllerLease::new();
    lease.claim(actor.clone(), 0.0);
    lease
}

#[test]
fn thirty_two_waiting_inputs_of_one_kind_refuse_the_next() {
    let actor = agent();
    let mut lease = held_lease(&actor);
    let mut pending = PendingInput::new();
    let mut admitted = Vec::new();
    for _ in 0..MAX_PENDING_PER_KIND {
        admitted.push(admit(&mut lease, &mut pending, &actor, 0.0).expect("room"));
    }
    assert_eq!(pending.count(ActorKind::Agent), MAX_PENDING_PER_KIND);

    let refused = admit(&mut lease, &mut pending, &actor, 0.0).expect_err("the lane is full");
    assert_eq!(refused, words::refusal("inputQueueFull"));
    assert_eq!(refused.code(), DeviceErrorCode::Busy);
    assert_eq!(pending.count(ActorKind::Agent), MAX_PENDING_PER_KIND);

    // The refusal took no retain, so one release still frees the lane.
    for admission in admitted {
        finish(&mut lease, &mut pending, admission);
    }
    assert_eq!(pending.count(ActorKind::Agent), 0);
    assert_eq!(pending.total(), 0);
    admit(&mut lease, &mut pending, &actor, 0.0).expect("room again");
}

#[test]
fn a_person_and_an_agent_have_separate_lanes() {
    let agent = agent();
    let person = person();
    let mut lease = held_lease(&agent);
    let mut pending = PendingInput::new();
    for _ in 0..MAX_PENDING_PER_KIND {
        admit(&mut lease, &mut pending, &agent, 0.0).expect("room");
    }
    // The agent's full lane never refuses the person's input (ADR 0143): the
    // person's input takes the shared lane, not the agent's.
    admit_shared(&mut pending, &person).expect("the person's lane is free");
    assert_eq!(pending.count(ActorKind::Human), 1);
    assert_eq!(pending.total(), MAX_PENDING_PER_KIND + 1);
}

#[test]
fn an_input_without_the_lease_is_refused_before_the_lane_is_checked() {
    let agent = agent();
    let mut lease = held_lease(&agent);
    let mut pending = PendingInput::new();
    for _ in 0..MAX_PENDING_PER_KIND {
        admit(&mut lease, &mut pending, &agent, 0.0).expect("room");
    }
    // A person took the device: the full lane would say busy, but the lease is
    // the first thing an input proves.
    lease.claim(person(), 0.0);
    let refused = admit(&mut lease, &mut pending, &agent, 0.0).expect_err("no lease");
    assert_eq!(refused.code(), DeviceErrorCode::LeaseRequired);
    assert_eq!(pending.count(ActorKind::Agent), MAX_PENDING_PER_KIND);
}

#[test]
fn a_waiting_input_keeps_the_lease_alive() {
    let agent = agent();
    let mut lease = held_lease(&agent);
    let mut pending = PendingInput::new();
    let admission = admit(&mut lease, &mut pending, &agent, 0.0).expect("room");

    // Two lease lengths later, the waiting input still holds it.
    assert_eq!(lease.status(LEASE_MS * 2.0).controller, Controller::Agent);
    finish(&mut lease, &mut pending, admission);
    assert_eq!(
        lease.status(LEASE_MS * 3.0).controller,
        Controller::None,
        "without the input the lease expires as usual"
    );
}

#[test]
fn a_persons_takeover_invalidates_a_waiting_agents_input() {
    let agent = agent();
    let mut lease = held_lease(&agent);
    let mut pending = PendingInput::new();
    let admission = admit(&mut lease, &mut pending, &agent, 0.0).expect("room");
    let ticket = admission.ticket();
    guard(&mut lease, &agent, ticket, 1_000.0).expect("still holds it");

    // The person takes the device while the agent's input waits its turn.
    lease.claim(person(), 1_500.0);
    let refused = guard(&mut lease, &agent, ticket, 2_000.0).expect_err("the takeover revoked it");
    assert_eq!(refused.code(), DeviceErrorCode::LeaseRequired);
}

#[test]
fn shared_input_passes_while_an_agent_holds_the_device() {
    let agent = agent();
    let mut lease = held_lease(&agent);
    let mut pending = PendingInput::new();
    let shared = admit_shared(&mut pending, &person()).expect("room");
    // Cowork: the person's input goes in alongside the agent's control.
    shared_guard(&mut lease, &person(), false, 0.0).expect("cowork needs no lease");
    finish_shared(&mut pending, shared);
    assert_eq!(pending.count(ActorKind::Human), 0);
}

#[test]
fn shared_input_queued_before_a_takeover_respects_the_new_holder() {
    let agent = agent();
    let mut lease = held_lease(&agent);
    let mut pending = PendingInput::new();
    admit_shared(&mut pending, &person()).expect("room");

    // A Take control is being applied: the queued shared input must prove the
    // lease, and the person does not hold it yet.
    let refused = shared_guard(&mut lease, &person(), true, 0.0).expect_err("no lease yet");
    assert_eq!(refused.code(), DeviceErrorCode::LeaseRequired);

    // Once the person holds it, the same input passes.
    lease.claim(person(), 0.0);
    shared_guard(&mut lease, &person(), true, 0.0).expect("the person holds it");
    // And a different person is still refused while this one controls it.
    let other = Actor::human("other");
    let refused = shared_guard(&mut lease, &other, false, 0.0).expect_err("someone else's");
    assert_eq!(refused.code(), DeviceErrorCode::LeaseRequired);
}

#[test]
fn a_waited_result_carries_the_note_only_on_a_plain_object() {
    let note = "Waited 2 s while the person used the iPhone 17.";
    let object = with_waited(json!({ "completed": true }), Some(note));
    assert_eq!(object.get("waited").and_then(Value::as_str), Some(note));

    // Anything that is not a plain object is returned unchanged, as the
    // TypeScript's spread would be (`typeof result === "object" && !Array.isArray`).
    let array = json!([1, 2]);
    assert_eq!(with_waited(array.clone(), Some(note)), array);
    assert_eq!(with_waited(json!("done"), Some(note)), json!("done"));

    // No note (an empty one is no note) changes nothing.
    assert_eq!(
        with_waited(json!({ "completed": true }), None),
        json!({ "completed": true })
    );
    assert_eq!(
        with_waited(json!({ "completed": true }), Some("")),
        json!({ "completed": true })
    );
}

// SPDX-License-Identifier: Apache-2.0
//! Cowork (`device-cowork.ts` and `@ace/interaction/presence`): the person's
//! presence, the wait it gives an agent, and the pointer viewers draw.
//!
//! `device-cowork.test.ts` is a (a) file (behaviour.md §5): it drives the whole
//! service, so it stays the service's proof. These cases cover the decisions
//! beside them, including the presence machine's own edges.

use super::{
    AgentPointer, Cowork, PERSON_QUIET_MS, PERSON_WAIT_MS, Point, Sharing, Step, busy,
    person_active, presence_step, waited_note,
};
use crate::error::DeviceErrorCode;

#[test]
fn the_person_counts_as_present_for_three_seconds() {
    assert_eq!(PERSON_QUIET_MS, 3_000.0);
    assert!(person_active(0.0, Some(0.0), PERSON_QUIET_MS));
    assert!(person_active(2_999.0, Some(0.0), PERSON_QUIET_MS));
    assert!(!person_active(3_000.0, Some(0.0), PERSON_QUIET_MS));
    assert!(
        !person_active(1_000.0, None, PERSON_QUIET_MS),
        "never acted"
    );

    let mut cowork = Cowork::new();
    assert!(!cowork.active("ios:AAAA", 0.0));
    assert!(cowork.person_input("ios:AAAA", 1_000.0), "became active");
    assert!(cowork.active("ios:AAAA", 1_500.0));
    assert!(
        !cowork.active("android:emulator-5554", 1_500.0),
        "another device"
    );
    assert!(!cowork.active("ios:AAAA", 4_000.0), "the presence lapsed");
}

#[test]
fn a_waiting_action_runs_when_the_presence_lapses() {
    assert_eq!(
        presence_step(1_000.0, Some(0.0), 1_000.0, 3_000.0, 60_000.0),
        Step::Wait(2_000.0)
    );
    assert_eq!(
        presence_step(3_000.0, Some(0.0), 1_000.0, 3_000.0, 60_000.0),
        Step::Run
    );
    assert_eq!(
        presence_step(1_000.0, None, 1_000.0, 3_000.0, 60_000.0),
        Step::Run
    );
}

#[test]
fn a_waiting_action_gives_up_after_a_minute() {
    assert_eq!(PERSON_WAIT_MS, 60_000.0);
    // The person's presence would lapse later than the wait runs out.
    assert_eq!(
        presence_step(60_000.0, Some(58_000.0), 0.0, 3_000.0, 60_000.0),
        Step::GiveUp
    );
}

#[test]
fn the_wait_is_the_shorter_of_the_lapse_and_the_deadline() {
    // 1 s of presence left, 2 s of the wait: wait 1 s.
    assert_eq!(
        presence_step(0.0, Some(-2_000.0), 0.0, 3_000.0, 2_000.0),
        Step::Wait(1_000.0)
    );
    // 5 s of presence left, 1 s of the wait: wait 1 s, then look again.
    assert_eq!(
        presence_step(0.0, Some(2_000.0), 0.0, 3_000.0, 1_000.0),
        Step::Wait(1_000.0)
    );
    // 5 s of presence left, no wait left: give up.
    assert_eq!(
        presence_step(0.0, Some(2_000.0), 0.0, 3_000.0, 0.0),
        Step::GiveUp
    );
}

#[test]
fn a_waited_action_carries_its_note_only_after_half_a_second() {
    assert_eq!(waited_note(499.0, "the iPhone 17"), None);
    assert_eq!(
        waited_note(500.0, "the iPhone 17").as_deref(),
        Some("Waited 1 s while the person used the iPhone 17.")
    );
    assert_eq!(
        waited_note(2_400.0, "the iPhone 17").as_deref(),
        Some("Waited 2 s while the person used the iPhone 17.")
    );
    assert_eq!(
        waited_note(1_000.0, "the iPhone 17").as_deref(),
        Some("Waited 1 s while the person used the iPhone 17.")
    );
}

#[test]
fn a_busy_wait_names_the_device() {
    let refused = busy("the iPhone 17");
    assert_eq!(refused.code(), DeviceErrorCode::PersonBusy);
    assert_eq!(
        refused,
        crate::error::DeviceError::coded(
            DeviceErrorCode::PersonBusy,
            "The person is using the iPhone 17; nothing was done",
            crate::service::words::tool_hint("personBusyHint"),
        )
    );
}

#[test]
fn an_agent_point_becomes_the_pointer_viewers_draw() {
    let mut cowork = Cowork::new();
    cowork.acted("d1", "tap", Some(Point { x: 10.0, y: 20.0 }), None, 1_500.6);
    assert_eq!(
        cowork.view("d1", false, 0.0).agent_pointer,
        Some(AgentPointer {
            x: 10.0,
            y: 20.0,
            kind: String::from("click"),
            at: 1_501.0,
        })
    );

    // A swipe drags; `to` wins over the start point; a negative clock is zero.
    cowork.acted(
        "d1",
        "swipe",
        Some(Point { x: 1.0, y: 2.0 }),
        Some(Point { x: 30.0, y: 40.0 }),
        -5.0,
    );
    let pointer = cowork
        .view("d1", false, 0.0)
        .agent_pointer
        .expect("a pointer");
    assert_eq!(
        (pointer.x, pointer.y, pointer.kind.as_str(), pointer.at),
        (30.0, 40.0, "drag", 0.0)
    );

    // An app-level action has no point: the old pointer stays.
    cowork.acted("d1", "install", None, None, 9_000.0);
    assert_eq!(
        cowork.view("d1", false, 0.0).agent_pointer.map(|p| p.kind),
        Some(String::from("drag"))
    );
    // Typing and keys draw a type pointer; an unknown action a click.
    cowork.acted("d1", "type", Some(Point { x: 5.0, y: 6.0 }), None, 0.0);
    assert_eq!(
        cowork.view("d1", false, 0.0).agent_pointer.map(|p| p.kind),
        Some(String::from("type"))
    );
    cowork.acted("d1", "mystery", Some(Point { x: 5.0, y: 6.0 }), None, 0.0);
    assert_eq!(
        cowork.view("d1", false, 0.0).agent_pointer.map(|p| p.kind),
        Some(String::from("click"))
    );
}

#[test]
fn a_person_controlling_is_exclusive_and_cowork_shares() {
    let mut cowork = Cowork::new();
    assert_eq!(cowork.view("d1", false, 0.0).sharing, Sharing::Cowork);
    assert_eq!(cowork.view("d1", true, 0.0).sharing, Sharing::Exclusive);
    assert_eq!(Sharing::Cowork.as_str(), "cowork");
    assert_eq!(Sharing::Exclusive.as_str(), "exclusive");

    cowork.person_input("d1", 0.0);
    let view = cowork.view("d1", false, 1_000.0);
    assert!(view.person_active);
    assert!(!cowork.view("d1", false, 3_000.0).person_active);
}

#[test]
fn a_person_input_never_moves_the_clock_backwards() {
    let mut cowork = Cowork::new();
    assert!(cowork.person_input("d1", 2_000.0));
    assert!(
        !cowork.person_input("d1", 1_000.0),
        "an older input changes nothing"
    );
    assert!(cowork.active("d1", 2_500.0));
    assert!(
        !cowork.active("d1", 5_000.0),
        "the older input did not extend it"
    );
}

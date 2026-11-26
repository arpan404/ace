// SPDX-License-Identifier: Apache-2.0
//! Keeping devices and the saved setting in step (`devices-setting.ts`): which
//! step comes next, and what counts as a new choice.
//!
//! `devices-setting` is a (b) file (behaviour.md §5) that drives the whole daemon
//! with a real settings store. These cases cover the decisions the loop makes.

use super::{Goal, SettingGoal, Step, is_busy, next_step};

fn goal(enabled: bool, save: bool) -> Goal {
    Goal::new(0, enabled, save)
}

#[test]
fn a_choice_that_differs_turns_the_devices_first() {
    assert_eq!(next_step(goal(true, false), false), Step::Devices);
    assert_eq!(next_step(goal(false, false), true), Step::Devices);
    // Even when it also has to be saved, the devices move first.
    assert_eq!(next_step(goal(true, true), false), Step::Devices);
}

#[test]
fn a_choice_matching_the_devices_is_only_saved() {
    assert_eq!(next_step(goal(true, true), true), Step::Save);
    assert_eq!(next_step(goal(false, true), false), Step::Save);
}

#[test]
fn a_choice_that_needs_nothing_is_done() {
    assert_eq!(next_step(goal(true, false), true), Step::Done);
    assert_eq!(next_step(goal(false, false), false), Step::Done);
}

#[test]
fn a_busy_failure_retries_and_another_is_logged() {
    assert!(is_busy(Some("busy")));
    assert!(!is_busy(Some("timeout")));
    assert!(!is_busy(None));
}

#[test]
fn devices_echoing_what_is_being_applied_is_not_a_new_choice() {
    let mut setting = SettingGoal::new();
    setting.want(true, false);
    setting.begin_applying(true);
    assert_eq!(setting.devices_changed(true), None, "our own change");
    assert_eq!(
        setting.current().map(|goal| (goal.enabled, goal.save)),
        Some((true, false))
    );

    setting.applied();
    // A person's change afterwards is a new choice, and it has to be saved.
    let chosen = setting.devices_changed(false).expect("a new choice");
    assert_eq!((chosen.enabled, chosen.save), (false, true));
    assert_eq!(setting.current().map(|goal| goal.id()), Some(chosen.id()));
}

#[test]
fn the_newest_choice_replaces_the_one_in_flight() {
    let mut setting = SettingGoal::new();
    let first = setting.want(false, false);
    // A quick on-then-off while the first is still running.
    let second = setting.want(true, false);
    assert_eq!(setting.current().map(|goal| goal.id()), Some(second.id()));
    // The first's tail does not end the loop: a newer choice is in force.
    assert!(setting.settle(first, Step::Devices, false));
    assert_eq!(setting.current().map(|goal| goal.id()), Some(second.id()));
}

#[test]
fn a_settled_choice_ends_the_loop_and_a_failure_ends_its_own_goal() {
    let mut setting = SettingGoal::new();
    let target = setting.want(true, false);
    // Devices now match: the loop goes round once more, finds nothing to do, and
    // ends with the goal met.
    assert!(setting.settle(target, Step::Devices, true));
    assert!(!setting.settle(target, Step::Done, true));
    assert_eq!(setting.current(), None);

    // A save step always finishes its goal once it ran.
    let saving = setting.want(true, true);
    assert!(!setting.settle(saving, Step::Save, true));

    // A failure ends only the goal it belonged to.
    let target = setting.want(false, false);
    setting.failed(target);
    assert_eq!(setting.current(), None);
}

#[test]
fn a_newer_choice_with_the_same_value_still_keeps_the_loop_going() {
    // The TypeScript compares goals by identity, so a second choice that looks
    // the same is still a newer one: the older tail must not end the loop.
    let mut setting = SettingGoal::new();
    let first = setting.want(true, false);
    let second = setting.want(true, false);
    assert_ne!(first.id(), second.id(), "each choice is its own");
    assert!(
        setting.settle(first, Step::Devices, true),
        "a newer choice is in force"
    );
    assert_eq!(setting.current().map(|goal| goal.id()), Some(second.id()));
    assert!(!setting.settle(second, Step::Done, true));
}

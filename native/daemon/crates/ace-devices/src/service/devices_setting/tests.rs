// SPDX-License-Identifier: Apache-2.0
//! Keeping devices and the saved setting in step (`devices-setting.ts`): which
//! step comes next, and what counts as a new choice.
//!
//! `devices-setting` is a (b) file (behaviour.md §5) that drives the whole daemon
//! with a real settings store. These cases cover the decisions the loop makes.

use super::{Goal, SettingGoal, Step, is_busy, next_step};

fn goal(enabled: bool, save: bool) -> Goal {
    Goal { enabled, save }
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
    setting.want(goal(true, false));
    setting.begin_applying(true);
    assert_eq!(setting.devices_changed(true), None, "our own change");
    assert_eq!(setting.current(), Some(goal(true, false)));

    setting.applied();
    // A person's change afterwards is a new choice, and it has to be saved.
    assert_eq!(setting.devices_changed(false), Some(goal(false, true)));
    assert_eq!(setting.current(), Some(goal(false, true)));
}

#[test]
fn the_newest_choice_replaces_the_one_in_flight() {
    let mut setting = SettingGoal::new();
    let first = goal(false, false);
    setting.want(first);
    // A quick on-then-off while the first is still running.
    let second = goal(true, false);
    setting.want(second);
    assert_eq!(setting.current(), Some(second));
    // The first's tail does not end the loop: a newer choice is in force.
    assert!(setting.settle(first, Step::Devices, false));
    assert_eq!(setting.current(), Some(second));
}

#[test]
fn a_settled_choice_ends_the_loop_and_a_failure_ends_its_own_goal() {
    let mut setting = SettingGoal::new();
    let target = goal(true, false);
    setting.want(target);
    // Devices now match: the loop goes round once more, finds nothing to do, and
    // ends with the goal met.
    assert!(setting.settle(target, Step::Devices, true));
    assert!(!setting.settle(target, Step::Done, true));
    assert_eq!(setting.current(), None);

    // A save step always finishes its goal once it ran.
    setting.want(goal(true, true));
    assert!(!setting.settle(goal(true, true), Step::Save, true));

    // A failure ends only the goal it belonged to.
    let target = goal(false, false);
    setting.want(target);
    setting.failed(target);
    assert_eq!(setting.current(), None);
}

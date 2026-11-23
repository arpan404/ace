// SPDX-License-Identifier: Apache-2.0

use super::*;

const SID: &str = "S-1-5-21-1-2-3-1001";
const STRANGER: &str = "S-1-5-21-1-2-3-1002";

fn snapshot(taken: u64, processes: &[(u32, u32)]) -> WindowsSnapshot {
    WindowsSnapshot {
        taken: taken.to_string(),
        processes: processes
            .iter()
            .map(|(pid, parent)| WindowsLink {
                pid: *pid,
                parent: *parent,
            })
            .collect(),
    }
}

/// Live processes by pid: creation time and owner. Anything else is gone.
fn host(live: &[(u32, u64, Option<&str>)]) -> impl Fn(u32) -> WindowsIdentified {
    let table: std::collections::HashMap<u32, (u64, Option<String>)> = live
        .iter()
        .map(|(pid, start, uid)| (*pid, (*start, uid.map(str::to_owned))))
        .collect();
    move |pid| match table.get(&pid) {
        None => WindowsIdentified::Gone,
        Some((_, None)) => WindowsIdentified::Unknown,
        Some((start, Some(uid))) => WindowsIdentified::Found {
            start: start.to_string(),
            uid: uid.clone(),
        },
    }
}

fn record(pid: u32, start: u64) -> WindowsRecord {
    WindowsRecord {
        pid,
        start: start.to_string(),
        uid: SID.to_owned(),
    }
}

#[test]
fn reused_leader_pid_child_is_neither_ended_nor_claimed() {
    // Leader 100 (started 10) died; a stranger reused 100, made child 200 at 30.
    let state = windows_tree_state(
        &[record(100, 10)],
        &snapshot(50, &[(200, 100)]),
        &host(&[(200, 30, Some(SID))]),
    );
    assert!(state.live.is_empty());
    assert!(state.discovered.is_empty());
    assert_eq!(state.ambiguous, vec![200]);
}

#[test]
fn reuser_children_stay_strangers_and_earlier_orphans_unproven() {
    // Leader 100 (10) died; 150 was made at 20, before 100 was reused at 25.
    let state = windows_tree_state(
        &[record(100, 10)],
        &snapshot(50, &[(150, 100), (200, 100)]),
        &host(&[
            (100, 25, Some(SID)),
            (150, 20, Some(SID)),
            (200, 30, Some(SID)),
        ]),
    );
    assert!(state.live.is_empty());
    assert_eq!(state.ambiguous, vec![150]);
}

#[test]
fn surviving_grandchild_keeps_the_tree_unresolved() {
    let state = windows_tree_state(
        &[record(100, 10), record(200, 15)],
        &snapshot(50, &[(300, 200)]),
        &host(&[(300, 20, Some(SID))]),
    );
    assert!(state.live.is_empty());
    assert_eq!(
        state
            .gone
            .iter()
            .map(|member| member.pid)
            .collect::<Vec<_>>(),
        vec![100, 200]
    );
    assert_eq!(state.ambiguous, vec![300]);
}

#[test]
fn recorded_descendant_is_ended_after_its_parents_exit() {
    let state = windows_tree_state(
        &[record(100, 10), record(200, 15), record(300, 20)],
        &snapshot(50, &[(300, 200)]),
        &host(&[(300, 20, Some(SID))]),
    );
    assert_eq!(state.live, vec![record(300, 20)]);
    assert!(state.ambiguous.is_empty());
}

#[test]
fn only_children_of_a_live_parent_before_the_snapshot_are_claimed() {
    let state = windows_tree_state(
        &[record(100, 10)],
        &snapshot(
            50,
            &[(200, 100), (300, 200), (400, 100), (500, 100), (600, 100)],
        ),
        &host(&[
            (100, 10, Some(SID)),
            (200, 20, Some(SID)),
            (300, 25, Some(SID)),
            (400, 5, Some(SID)),
            (500, 60, Some(SID)),
            (600, 30, Some(STRANGER)),
        ]),
    );
    assert_eq!(
        state
            .live
            .iter()
            .map(|member| member.pid)
            .collect::<Vec<_>>(),
        vec![100, 200, 300]
    );
    assert_eq!(state.discovered, vec![record(200, 20), record(300, 25)]);
    assert!(state.ambiguous.is_empty());
}

#[test]
fn unreadable_member_is_neither_ended_nor_gone() {
    let state = windows_tree_state(
        &[record(100, 10)],
        &snapshot(50, &[]),
        &host(&[(100, 0, None)]),
    );
    assert!(state.live.is_empty());
    assert!(state.gone.is_empty());
    assert_eq!(state.ambiguous, vec![100]);
}

#[test]
fn sids_validate_as_dotted_numbers() {
    assert!(valid_sid(SID));
    assert!(!valid_sid("not-a-sid"));
    assert!(!valid_sid("S-"));
    assert!(!valid_sid(&format!("S-1-{}", "1".repeat(300))));
}

// SPDX-License-Identifier: Apache-2.0
//! Stops: each member is checked just before its signal, and pidfds pin it.

use super::*;

#[test]
fn stop_checks_each_member_just_before_its_signal() {
    let mut fake = machine(&[(200, 1, "first"), (300, 1, "second")]);
    fake.after_signal = Some(Box::new(|fake, pid| {
        // While the batch runs, 300 exits and its pid goes to an unrelated process.
        if pid == 200
            && fake.table.borrow().get(&300).map(|row| row.start.as_str()) == Some("second")
        {
            fake.table.borrow_mut().remove(&300);
            fake.table.borrow_mut().insert(
                300,
                FakeProc {
                    parent: 1,
                    start: "stranger".to_owned(),
                    group: None,
                    ignores: None,
                    zombie: false,
                },
            );
        }
    }));
    stop_members(
        &[member(200, "first"), member(300, "second")],
        500,
        &fake,
        None,
    );
    assert_eq!(
        fake.signals.borrow().clone(),
        vec!["SIGTERM 200:first".to_owned()]
    );
    assert_eq!(
        fake.table.borrow().get(&300).map(|row| row.start.clone()),
        Some("stranger".to_owned())
    );
}

#[test]
fn pidfd_pins_the_checked_process_so_a_reused_pid_is_never_signalled() {
    let mut fake = machine(&[(300, 1, "second")]);
    fake.pidfd_enabled = true;
    fake.after_identity_hook = Some(Box::new(|fake, pid, reads| {
        // 300 exits and a stranger takes its pid right after the third identity read.
        if pid == 300 && reads == 3 {
            fake.table.borrow_mut().remove(&300);
            fake.table.borrow_mut().insert(
                300,
                FakeProc {
                    parent: 1,
                    start: "stranger".to_owned(),
                    group: None,
                    ignores: None,
                    zombie: false,
                },
            );
        }
    }));
    stop_members(&[member(300, "second")], 500, &fake, None);
    assert!(fake.signals.borrow().is_empty());
    assert_eq!(
        fake.table.borrow().get(&300).map(|row| row.start.clone()),
        Some("stranger".to_owned())
    );
}

#[test]
fn gone_pidfd_open_reads_gone_without_signalling() {
    let mut fake = machine(&[(300, 1, "provider")]);
    fake.pidfd_enabled = true;
    fake.open_failure = Some(OpenBehavior::Gone);
    let left = stop_members(&[member(300, "provider")], 500, &fake, None);
    assert!(fake.signals.borrow().is_empty());
    assert_eq!(left, vec![member(300, "provider")]);
}

#[test]
fn undescriptored_pidfd_reports_unsafe_and_runs_no_signal() {
    let mut fake = machine(&[(300, 1, "provider")]);
    fake.pidfd_enabled = true;
    fake.open_failure = Some(OpenBehavior::Unsafe);
    let left = stop_members(&[member(300, "provider")], 500, &fake, None);
    assert!(fake.signals.borrow().is_empty());
    assert_eq!(left, vec![member(300, "provider")]);
}

#[test]
fn kernel_without_pidfds_signals_the_pid_directly() {
    let mut fake = machine(&[(300, 1, "provider")]);
    fake.pidfd_enabled = true;
    fake.open_failure = Some(OpenBehavior::Unsupported);
    let left = stop_members(&[member(300, "provider")], 500, &fake, None);
    assert!(left.is_empty());
    assert_eq!(
        fake.signals.borrow().clone(),
        vec!["SIGTERM 300:provider".to_owned()]
    );
}

#[test]
fn stop_past_its_deadline_sends_no_signal() {
    let fake = machine(&[(300, 1, "provider")]);
    let left = stop_members(
        &[member(300, "provider")],
        500,
        &fake,
        Some(std::time::Instant::now() - std::time::Duration::from_secs(1)),
    );
    assert!(fake.signals.borrow().is_empty());
    assert_eq!(left, vec![member(300, "provider")]);
}

#[test]
fn stubborn_member_is_killed_and_unkillable_is_reported() {
    let fake = machine(&[(200, 1, "stubborn"), (300, 1, "unkillable")]);
    if let Some(row) = fake.table.borrow_mut().get_mut(&200) {
        row.ignores = Some(Ignore::Term);
    }
    if let Some(row) = fake.table.borrow_mut().get_mut(&300) {
        row.ignores = Some(Ignore::All);
    }
    let survivors = stop_members(
        &[member(200, "stubborn"), member(300, "unkillable")],
        500,
        &fake,
        None,
    );
    assert_eq!(survivors, vec![member(300, "unkillable")]);
    assert_eq!(
        fake.signals.borrow().clone(),
        vec![
            "SIGTERM 200:stubborn".to_owned(),
            "SIGTERM 300:unkillable".to_owned(),
            "SIGKILL 200:stubborn".to_owned(),
            "SIGKILL 300:unkillable".to_owned(),
        ]
    );
}

#[test]
fn zombie_counts_as_stopped() {
    let fake = machine(&[(200, 1, "done")]);
    if let Some(row) = fake.table.borrow_mut().get_mut(&200) {
        row.zombie = true;
    }
    assert!(stop_members(&[member(200, "done")], 500, &fake, None).is_empty());
    assert!(fake.signals.borrow().is_empty());
}

// SPDX-License-Identifier: Apache-2.0
//! The per-device queue (`device-queue.ts`): one operation at a time, the latest
//! subscribe wins, and an unsubscribe always runs.
//!
//! `device-queue.ts` has no test file of its own (behaviour.md §5 lists none), so
//! these cases are the module's only guard. Each one is named after the
//! behaviour it keeps.

use super::{DeviceQueue, Finished, Kind, Run, Started};

fn started(id: u64, device: &str, kind: Kind) -> Started {
    Started::Run(Run {
        id,
        device: device.to_owned(),
        kind,
    })
}

fn next(id: u64, device: &str, kind: Kind) -> Finished {
    Finished {
        dropped: Vec::new(),
        next: Some(Run {
            id,
            device: device.to_owned(),
            kind,
        }),
    }
}

#[test]
fn one_device_runs_one_operation_at_a_time_in_order() {
    let mut queue = DeviceQueue::new();
    assert_eq!(
        queue.submit("d1", Kind::Subscribe),
        started(0, "d1", Kind::Subscribe)
    );
    assert_eq!(queue.submit("d1", Kind::Unsubscribe), Started::Queued(1));
    assert_eq!(queue.waiting("d1"), 1);
    assert!(queue.running("d1"));

    // The second waits for the first's end, then starts.
    assert_eq!(queue.finish("d1", 0), next(1, "d1", Kind::Unsubscribe));
    assert_eq!(queue.finish("d1", 1), Finished::default());
    assert!(!queue.running("d1"));
}

#[test]
fn every_queued_operation_runs_after_the_one_before_ends() {
    let mut queue = DeviceQueue::new();
    queue.submit("d1", Kind::Unsubscribe);
    assert_eq!(queue.submit("d1", Kind::Unsubscribe), Started::Queued(1));
    assert_eq!(queue.submit("d1", Kind::Unsubscribe), Started::Queued(2));

    assert_eq!(queue.finish("d1", 0), next(1, "d1", Kind::Unsubscribe));
    assert_eq!(queue.finish("d1", 1), next(2, "d1", Kind::Unsubscribe));
    assert_eq!(queue.finish("d1", 2), Finished::default());
}

#[test]
fn a_new_submission_supersedes_the_one_running() {
    let mut queue = DeviceQueue::new();
    queue.submit("d1", Kind::Subscribe);
    assert!(!queue.superseded("d1", 0));
    queue.submit("d1", Kind::Unsubscribe);
    assert!(
        queue.superseded("d1", 0),
        "the running subscribe rolls back"
    );

    // An unsubscribe is told too: a takeover of the device may still need to stop
    // what the old subscription was delivering.
    let mut queue = DeviceQueue::new();
    queue.submit("d1", Kind::Unsubscribe);
    queue.submit("d1", Kind::Subscribe);
    assert!(queue.superseded("d1", 0));
}

#[test]
fn a_running_subscribe_keeps_its_turn_until_it_ends() {
    let mut queue = DeviceQueue::new();
    queue.submit("d1", Kind::Subscribe);
    queue.submit("d1", Kind::Subscribe);
    queue.submit("d1", Kind::Subscribe);

    // Nothing newer starts before the running one ends, even though it was passed.
    assert!(queue.superseded("d1", 0));
    assert!(queue.running("d1"));
    assert_eq!(queue.waiting("d1"), 2);
}

#[test]
fn a_queued_subscribe_a_newer_one_passed_never_runs() {
    let mut queue = DeviceQueue::new();
    queue.submit("d1", Kind::Subscribe);
    assert_eq!(queue.submit("d1", Kind::Subscribe), Started::Queued(1));
    assert_eq!(queue.submit("d1", Kind::Subscribe), Started::Queued(2));

    // The first ends: the second was passed by the third, so it is dropped and
    // the third runs in the same step, as the TypeScript's chained tail does.
    assert_eq!(
        queue.finish("d1", 0),
        Finished {
            dropped: vec![1],
            next: Some(Run {
                id: 2,
                device: String::from("d1"),
                kind: Kind::Subscribe,
            }),
        }
    );
    assert!(
        !queue.superseded("d1", 2),
        "the newest subscribe runs clean"
    );
}

#[test]
fn an_unsubscribe_is_never_dropped() {
    let mut queue = DeviceQueue::new();
    queue.submit("d1", Kind::Subscribe);
    assert_eq!(queue.submit("d1", Kind::Unsubscribe), Started::Queued(1));
    queue.submit("d1", Kind::Subscribe);
    // The unsubscribe queued before the newest subscribe still runs.
    assert_eq!(queue.finish("d1", 0), next(1, "d1", Kind::Unsubscribe));
}

#[test]
fn devices_do_not_wait_for_each_other() {
    let mut queue = DeviceQueue::new();
    queue.submit("d1", Kind::Subscribe);
    assert_eq!(
        queue.submit("d2", Kind::Subscribe),
        started(1, "d2", Kind::Subscribe)
    );
    assert!(!queue.superseded("d1", 0));
    assert!(!queue.superseded("d2", 1));
    queue.finish("d1", 0);
    assert_eq!(queue.waiting("d2"), 0);
}

#[test]
fn an_idle_device_is_forgotten_and_a_later_submission_starts_fresh() {
    let mut queue = DeviceQueue::new();
    queue.submit("d1", Kind::Subscribe);
    queue.finish("d1", 0);
    assert!(!queue.running("d1"));
    assert_eq!(queue.waiting("d1"), 0);

    // A new submission is the first of a new chain: it runs, and the previous
    // chain's superseded state cannot reach it.
    assert_eq!(
        queue.submit("d1", Kind::Subscribe),
        started(1, "d1", Kind::Subscribe)
    );
    assert!(!queue.superseded("d1", 1));
}

#[test]
fn finishing_something_that_is_not_running_changes_nothing() {
    let mut queue = DeviceQueue::new();
    queue.submit("d1", Kind::Subscribe);
    assert_eq!(queue.finish("d1", 7), Finished::default());
    assert!(queue.running("d1"), "the real operation still runs");
    assert_eq!(queue.finish("unknown", 0), Finished::default());
}

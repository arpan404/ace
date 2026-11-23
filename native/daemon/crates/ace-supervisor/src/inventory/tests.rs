// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::test_scratch::{Fake, Scratch, identity};
use std::sync::Arc;

fn open(path: &str, runtime: Fake) -> Inventory<Fake> {
    Inventory::open(path, runtime, Arc::new(|_| {})).expect("inventory opens")
}

#[test]
fn unremoved_rows_retry_and_a_reused_pid_survives() {
    let scratch = Scratch::new();
    let path = scratch.file("processes.sqlite");
    let (mut fake, _) = Fake::new(10);
    fake.insert(10, "owner-start", 1000, 10);
    fake.insert(20, "first", 1000, 20);
    fake.insert(30, "other", 1000, 30);
    let mut inventory = open(&path, fake);
    inventory.add(20, "first", None).expect("adds");
    inventory.add(30, "other", None).expect("adds");
    // Another writer holds the file, so the deletes fail like a full disk.
    let blocker = Connection::open(&path, OpenOptions::default()).expect("blocker opens");
    blocker.exec("BEGIN IMMEDIATE").expect("blocks");
    inventory.remove(20);
    inventory.remove(30);
    assert!(inventory.retry_at_ms().is_some());
    blocker.exec("ROLLBACK").expect("unblocks");
    // The pid is reused before the retry: the new row must survive it.
    inventory
        .runtime
        .processes
        .insert(20, identity(20, "second"));
    inventory.add(20, "second", None).expect("adds");
    assert_eq!(inventory.retry_removals(1), RetryPlan::Done);
    assert_eq!(
        inventory
            .list()
            .expect("lists")
            .into_iter()
            .map(|entry| (entry.pid, entry.start))
            .collect::<Vec<_>>(),
        vec![(20, "second".to_owned())]
    );
    inventory.close();
    blocker.close().expect("blocker closes");
}

#[test]
fn failing_deletes_retry_on_backoff_and_close_cancels() {
    let scratch = Scratch::new();
    let path = scratch.file("processes.sqlite");
    let (mut fake, _) = Fake::new(10);
    fake.insert(10, "owner-start", 1000, 10);
    fake.insert(20, "child", 1000, 20);
    let mut inventory = open(&path, fake);
    inventory.add(20, "child", None).expect("adds");
    let blocker = Connection::open(&path, OpenOptions::default()).expect("blocker opens");
    blocker.exec("BEGIN IMMEDIATE").expect("blocks");
    inventory.remove(20);
    assert_eq!(inventory.retry_at_ms(), Some(1_000));
    // The scheduled retry finds the file still locked: another, later one.
    blocker.exec("ROLLBACK").expect("unblocks");
    blocker.exec("BEGIN IMMEDIATE").expect("blocks");
    assert_eq!(inventory.retry_removals(1_000), RetryPlan::RetryIn(2_000));
    blocker.exec("ROLLBACK").expect("unblocks");
    assert_eq!(inventory.retry_removals(3_000), RetryPlan::Done);
    assert!(inventory.list().expect("lists").is_empty());
    assert_eq!(inventory.retry_at_ms(), None);
    inventory.close();
    blocker.close().expect("blocker closes");
}

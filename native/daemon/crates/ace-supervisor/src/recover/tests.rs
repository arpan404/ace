// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::inventory::Inventory;
use crate::test_scratch::{Fake, Scratch, identity};
use std::sync::Arc;

fn open(path: &str, runtime: Fake) -> Inventory<Fake> {
    Inventory::open(path, runtime, Arc::new(|_| {})).expect("inventory opens")
}

#[test]
fn orphan_recovery_kills_no_identity_mismatch() {
    for kind in ["pid", "start", "uid", "group", "missing", "unreadable"] {
        let scratch = Scratch::new();
        let (mut fake, _) = Fake::new(10);
        fake.insert(10, "owner-start", 1000, 10);
        fake.insert(20, "child-start", 1000, 20);
        let mut inventory = open(&scratch.file("processes.sqlite"), fake);
        inventory.add(20, "synthetic", None).expect("adds");
        inventory.runtime.processes.remove(&10);
        match kind {
            "pid" => {
                inventory
                    .runtime
                    .processes
                    .insert(20, identity(21, "child-start"));
            }
            "start" => {
                inventory
                    .runtime
                    .processes
                    .insert(20, identity(20, "recycled"));
            }
            "uid" => {
                let mut current = identity(20, "child-start");
                current.owner = crate::identity::ProcessOwner::Uid(1001);
                inventory.runtime.processes.insert(20, current);
            }
            "group" => {
                let mut current = identity(20, "child-start");
                current.group = 21;
                inventory.runtime.processes.insert(20, current);
            }
            "missing" => {
                inventory.runtime.processes.remove(&20);
            }
            _ => {
                inventory.runtime.unreadable.push(20);
            }
        }
        // Not the run's provably: left running and on record, and
        // startup goes on unverified.
        assert_eq!(
            inventory.recover().expect("recovers"),
            Recovered {
                removed: 0,
                killed: 0,
                unresolved: 1,
            },
            "{kind}"
        );
        assert_eq!(inventory.list().expect("lists").len(), 1, "{kind}");
        inventory.close();
    }
}

#[test]
fn recovery_keeps_a_live_owner_and_kills_only_a_verified_orphan() {
    let scratch = Scratch::new();
    let (mut fake, killed) = Fake::new(10);
    fake.insert(10, "owner-start", 1000, 10);
    fake.insert(20, "child-start", 1000, 20);
    let mut inventory = open(&scratch.file("processes.sqlite"), fake);
    inventory.add(20, "synthetic", None).expect("adds");
    assert_eq!(
        inventory.recover().expect("recovers"),
        Recovered {
            removed: 0,
            killed: 0,
            unresolved: 0,
        }
    );
    assert!(killed.borrow().is_empty());
    inventory.runtime.processes.remove(&10);
    assert_eq!(
        inventory.recover().expect("recovers"),
        Recovered {
            removed: 0,
            killed: 1,
            unresolved: 0,
        }
    );
    assert_eq!(killed.borrow().clone(), vec![20]);
    inventory.close();
}

#[test]
fn refused_group_probe_is_kept_for_later() {
    let scratch = Scratch::new();
    let (mut fake, killed) = Fake::new(10);
    fake.insert(10, "owner-start", 1000, 10);
    fake.insert(20, "exiting", 1000, 20);
    fake.insert(30, "orphan", 1000, 30);
    fake.alive.insert(20, Err(ProbeRefused::Refused));
    let mut inventory = open(&scratch.file("processes.sqlite"), fake);
    inventory.add(20, "synthetic", None).expect("adds");
    inventory.add(30, "synthetic", None).expect("adds");
    inventory.runtime.processes.remove(&10);
    assert_eq!(
        inventory.recover().expect("recovers"),
        Recovered {
            removed: 0,
            killed: 1,
            unresolved: 1,
        }
    );
    assert_eq!(killed.borrow().clone(), vec![30]);
    assert!(
        inventory
            .list()
            .expect("lists")
            .iter()
            .any(|entry| entry.pid == 20)
    );
    inventory.runtime.alive.insert(20, Ok(false));
    let recovered = inventory.recover().expect("recovers");
    assert_eq!(recovered.unresolved, 0);
    assert_eq!(recovered.removed, 1);
    assert!(
        !inventory
            .list()
            .expect("lists")
            .iter()
            .any(|entry| entry.pid == 20)
    );
    inventory.close();
}

#[test]
fn probe_failure_other_than_refused_stops_recovery() {
    let scratch = Scratch::new();
    let (mut fake, _) = Fake::new(10);
    fake.insert(10, "owner-start", 1000, 10);
    fake.insert(20, "child", 1000, 20);
    fake.alive
        .insert(20, Err(ProbeRefused::Failed("kill EINVAL".to_owned())));
    let mut inventory = open(&scratch.file("processes.sqlite"), fake);
    inventory.add(20, "synthetic", None).expect("adds");
    inventory.runtime.processes.remove(&10);
    assert!(inventory.recover().is_err());
    inventory.close();
}

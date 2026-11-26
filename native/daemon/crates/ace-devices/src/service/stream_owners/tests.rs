// SPDX-License-Identifier: Apache-2.0
//! Connection lifetimes for stream owners (`stream-owners.ts`): a resubscribe
//! overlaps the view it replaces, and a disconnect never retains an owner.
//!
//! `stream-owners.ts` has no test file of its own (behaviour.md §5 lists none),
//! so these cases are the module's only guard.

use super::{DISCONNECTED, StreamOwners};

#[test]
fn an_owners_views_overlap_while_a_resubscribe_is_set_up() {
    let mut owners = StreamOwners::new();
    let scope = owners.scope("person");
    let first = owners.subscribe(&scope, "ios:AAAA", 1).expect("open");
    // The replacement view is set up beside the one it replaces.
    let second = owners.subscribe(&scope, "ios:AAAA", 2).expect("open");
    // The first ending does not take the device from the view still running.
    assert_eq!(owners.release(first), None);
    // The last one ending releases the device.
    assert_eq!(owners.release(second), Some(2));
}

#[test]
fn another_device_is_its_own_views() {
    let mut owners = StreamOwners::new();
    let scope = owners.scope("person");
    let one = owners.subscribe(&scope, "ios:AAAA", 1).expect("open");
    let other = owners
        .subscribe(&scope, "android:emulator-5554", 2)
        .expect("open");
    assert_eq!(owners.release(one), Some(1));
    assert_eq!(owners.release(other), Some(2));
}

#[test]
fn a_disconnected_owners_scope_refuses_its_views() {
    let mut owners = StreamOwners::new();
    let scope = owners.scope("person");
    owners.subscribe(&scope, "ios:AAAA", 1).expect("open");
    owners.disconnect("person");
    // The handle a lookup still holds fails its guard.
    assert_eq!(owners.guard(&scope), Err(String::from(DISCONNECTED)));
    assert_eq!(
        owners.subscribe(&scope, "ios:AAAA", 2),
        Err(String::from(DISCONNECTED))
    );
    // A later connection asks for a scope of its own.
    let fresh = owners.scope("person");
    assert!(owners.subscribe(&fresh, "ios:AAAA", 3).is_ok());
}

#[test]
fn a_release_after_a_disconnect_still_releases_the_last_view() {
    let mut owners = StreamOwners::new();
    let scope = owners.scope("person");
    let first = owners.subscribe(&scope, "ios:AAAA", 1).expect("open");
    let second = owners.subscribe(&scope, "ios:AAAA", 2).expect("open");
    owners.disconnect("person");
    // The views still end, and the last one still releases the device.
    assert_eq!(owners.release(first), None);
    assert_eq!(owners.release(second), Some(2));
    // Nothing of the owner is left behind.
    assert!(owners.is_empty());
}

#[test]
fn close_disconnects_every_owner() {
    let mut owners = StreamOwners::new();
    let a = owners.scope("a");
    let b = owners.scope("b");
    owners.subscribe(&a, "ios:AAAA", 1).expect("open");
    owners.subscribe(&b, "ios:AAAA", 2).expect("open");
    owners.close();
    assert_eq!(owners.guard(&a), Err(String::from(DISCONNECTED)));
    assert_eq!(owners.guard(&b), Err(String::from(DISCONNECTED)));
}

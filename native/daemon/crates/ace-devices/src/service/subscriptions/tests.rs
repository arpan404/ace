// SPDX-License-Identifier: Apache-2.0
//! One subscription per device, at most four, staged so a failed resubscribe
//! leaves the running one alone (`subscriptions.ts`).
//!
//! `subscriptions.ts` has no test file of its own (behaviour.md §5 lists none),
//! so these cases are the module's only guard.

use super::{DeviceSubscriptions, MAX_SUBSCRIPTIONS, SUBSCRIPTION_LIMIT};

#[test]
fn at_most_four_devices_hold_a_subscription() {
    let mut subscriptions = DeviceSubscriptions::new();
    for index in 0..MAX_SUBSCRIPTIONS {
        subscriptions.reserve(&format!("d{index}")).expect("room");
    }
    assert_eq!(subscriptions.len(), MAX_SUBSCRIPTIONS);
    // A fifth device is refused, but a device already held may reserve again.
    assert_eq!(
        subscriptions.reserve("d5"),
        Err(String::from(SUBSCRIPTION_LIMIT))
    );
    subscriptions.reserve("d0").expect("its own device");
}

#[test]
fn a_staged_subscription_keeps_the_running_one_until_it_attaches() {
    let mut subscriptions = DeviceSubscriptions::new();
    let first = subscriptions.reserve("d1").expect("room");
    assert!(subscriptions.attach(&first, 1).is_empty());
    assert!(
        subscriptions.active(&first),
        "the committed one stays active"
    );

    // The resubscribe is staged: the running view keeps going.
    let second = subscriptions.reserve("d1").expect("room");
    assert!(subscriptions.active(&second));
    assert!(subscriptions.active(&first));

    // It attaches: the running one is superseded and released.
    assert_eq!(subscriptions.attach(&second, 2), vec![1]);
    assert!(!subscriptions.active(&first));
    assert!(subscriptions.active(&second));
}

#[test]
fn a_superseded_stage_never_takes_over() {
    let mut subscriptions = DeviceSubscriptions::new();
    let earlier = subscriptions.reserve("d1").expect("room");
    let later = subscriptions.reserve("d1").expect("room");
    assert!(!subscriptions.active(&earlier), "the later stage passed it");

    // Attaching the superseded stage releases only its own subscription.
    assert_eq!(subscriptions.attach(&earlier, 1), vec![1]);
    assert!(!subscriptions.active(&earlier));
    // The later one still attaches normally.
    assert!(subscriptions.attach(&later, 2).is_empty());
    assert!(subscriptions.active(&later));
}

#[test]
fn a_cancelled_stage_leaves_the_running_subscription() {
    let mut subscriptions = DeviceSubscriptions::new();
    let first = subscriptions.reserve("d1").expect("room");
    subscriptions.attach(&first, 1);
    let second = subscriptions.reserve("d1").expect("room");
    subscriptions.cancel(&second);

    assert!(!subscriptions.active(&second));
    assert!(subscriptions.active(&first), "the old view still runs");
    // Removing the device releases the committed subscription, not the cancelled one.
    assert_eq!(subscriptions.remove("d1"), vec![1]);
    assert!(subscriptions.is_empty());
}

#[test]
fn removing_a_device_releases_its_committed_subscription_and_any_stage() {
    let mut subscriptions = DeviceSubscriptions::new();
    let first = subscriptions.reserve("d1").expect("room");
    subscriptions.attach(&first, 1);
    let staged = subscriptions.reserve("d1").expect("room");
    assert!(subscriptions.active(&staged));

    assert_eq!(subscriptions.remove("d1"), vec![1]);
    assert!(!subscriptions.active(&staged));
    assert!(subscriptions.is_empty());
    assert!(subscriptions.remove("d1").is_empty());
}

#[test]
fn close_releases_every_device_once() {
    let mut subscriptions = DeviceSubscriptions::new();
    let d1 = subscriptions.reserve("d1").expect("room");
    subscriptions.attach(&d1, 1);
    let d2 = subscriptions.reserve("d2").expect("room");
    subscriptions.attach(&d2, 2);
    // d3 is only staged: nothing to release for it.
    subscriptions.reserve("d3").expect("room");

    assert_eq!(subscriptions.close(), vec![1, 2]);
    assert!(subscriptions.is_empty());
    assert!(subscriptions.close().is_empty());
}

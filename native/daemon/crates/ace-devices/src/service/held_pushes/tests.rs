// SPDX-License-Identifier: Apache-2.0
//! A channel's pushes before welcome (`held-pushes.ts`): the snapshot first, then
//! the latest of each replaceable push in last-change order.
//!
//! `held-pushes.ts` has no test file of its own (behaviour.md §5 lists none), so
//! these cases are the module's only guard.

use super::{Held, HeldPushes, MAX_HELD, TOO_MANY_HELD, enabled};
use crate::service::wire::{Push, PushKind};

fn state(device: &str, tag: &str) -> Push<String> {
    Push {
        kind: PushKind::State {
            device_id: device.to_owned(),
        },
        message: tag.to_owned(),
    }
}

fn inventory(tag: &str) -> Push<String> {
    Push {
        kind: PushKind::Inventory,
        message: tag.to_owned(),
    }
}

fn reply(tag: &str) -> Push<String> {
    Push {
        kind: PushKind::Other,
        message: tag.to_owned(),
    }
}

fn messages(writes: &[Push<String>]) -> Vec<&str> {
    writes.iter().map(|push| push.message.as_str()).collect()
}

#[test]
fn pushes_wait_for_the_welcome_and_go_out_after_the_snapshot() {
    let mut pushes = HeldPushes::new();
    assert_eq!(pushes.send(state("d1", "state")), Ok(Held::Held));
    assert_eq!(pushes.send(inventory("inventory")), Ok(Held::Held));
    assert_eq!(pushes.len(), 2);

    let writes = pushes
        .open(vec![enabled(String::from("enabled"))])
        .expect("held");
    assert_eq!(messages(&writes), ["enabled", "state", "inventory"]);
    assert!(!pushes.holding());
}

#[test]
fn a_replaceable_push_keeps_only_its_latest_and_moves_to_the_end() {
    let mut pushes = HeldPushes::new();
    pushes.send(state("d1", "d1 old")).expect("held");
    pushes.send(state("d2", "d2")).expect("held");
    pushes.send(inventory("inventory")).expect("held");
    // The same device again: one push, with the latest state, at the end.
    pushes.send(state("d1", "d1 new")).expect("held");
    assert_eq!(pushes.len(), 3);

    let writes = pushes.open(Vec::new()).expect("held");
    assert_eq!(messages(&writes), ["d2", "inventory", "d1 new"]);
}

#[test]
fn one_off_pushes_are_all_kept_in_order() {
    let mut pushes = HeldPushes::new();
    pushes.send(reply("first")).expect("held");
    pushes.send(reply("second")).expect("held");
    assert_eq!(pushes.len(), 2, "a one-off never replaces another");

    let writes = pushes.open(Vec::new()).expect("held");
    assert_eq!(messages(&writes), ["first", "second"]);
}

#[test]
fn the_sixty_fifth_held_push_is_refused_even_when_it_would_replace() {
    let mut pushes = HeldPushes::new();
    for index in 0..MAX_HELD {
        pushes
            .send(state(&format!("d{index}"), "state"))
            .expect("room");
    }
    // The TypeScript checks the bound before the key, so even a repeat of a
    // held device is refused while the channel is at the cap.
    assert_eq!(
        pushes.send(state("d0", "again")),
        Err(String::from(TOO_MANY_HELD))
    );
    assert_eq!(pushes.len(), MAX_HELD);
}

#[test]
fn after_the_welcome_every_send_writes_at_once() {
    let mut pushes = HeldPushes::new();
    pushes.open(Vec::new()).expect("held");
    assert_eq!(
        pushes.send(state("d1", "now")),
        Ok(Held::Write(state("d1", "now")))
    );
    assert!(!pushes.holding());
}

#[test]
fn opening_twice_writes_nothing_the_second_time() {
    let mut pushes = HeldPushes::new();
    pushes.send(inventory("inventory")).expect("held");
    assert!(pushes.open(Vec::new()).is_some());
    assert_eq!(pushes.open(vec![enabled(String::from("enabled"))]), None);
}

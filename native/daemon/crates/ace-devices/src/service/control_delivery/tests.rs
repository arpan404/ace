// SPDX-License-Identifier: Apache-2.0
//! Coalescing pushes while frames drain (`control-delivery.ts`): a replaceable
//! push waits, a log batch drops, and a reply always writes.
//!
//! `control-delivery.ts` has no test file of its own (behaviour.md §5 lists
//! none), so these cases are the module's only guard.

use super::{BUFFERED_LIMIT, CLOSED, ControlDelivery, FLUSH_MS, Flush, Sent};
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

fn logs(tag: &str) -> Push<String> {
    Push {
        kind: PushKind::Logs,
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
fn a_repeat_of_a_waiting_push_is_coalesced_and_the_latest_wins() {
    let mut delivery = ControlDelivery::new();
    // The transport is backed up, so the first state waits.
    assert_eq!(
        delivery.send(state("d1", "old"), BUFFERED_LIMIT + 1),
        Ok(Sent::Held { arm: Some(1) })
    );
    // A second state for the same device waits behind the first, and replaces it.
    assert_eq!(
        delivery.send(state("d1", "new"), 0),
        Ok(Sent::Held { arm: None })
    );
    assert_eq!(delivery.pending(), 1);

    let Flush::Write(writes) = delivery.fire(1, 0) else {
        panic!("the flush writes what waits");
    };
    assert_eq!(messages(&writes), ["new"]);
}

#[test]
fn a_push_while_the_transport_is_backed_up_waits() {
    let mut delivery = ControlDelivery::new();
    assert_eq!(
        delivery.send(inventory("inventory"), BUFFERED_LIMIT + 1),
        Ok(Sent::Held { arm: Some(1) })
    );
    assert_eq!(delivery.pending(), 1);
}

#[test]
fn a_reply_writes_even_when_the_transport_is_backed_up() {
    let mut delivery = ControlDelivery::new();
    assert_eq!(
        delivery.send(reply("result"), BUFFERED_LIMIT + 1),
        Ok(Sent::Write(reply("result")))
    );
    assert_eq!(delivery.pending(), 0);
}

#[test]
fn a_log_batch_drops_under_back_pressure_and_writes_otherwise() {
    let mut delivery = ControlDelivery::new();
    assert_eq!(
        delivery.send(logs("batch"), BUFFERED_LIMIT + 1),
        Ok(Sent::Dropped)
    );
    assert_eq!(
        delivery.send(logs("batch"), BUFFERED_LIMIT),
        Ok(Sent::Write(logs("batch")))
    );
}

#[test]
fn the_flush_waits_twenty_five_ms_and_writes_in_first_held_order() {
    assert_eq!(FLUSH_MS, 25.0);
    let mut delivery = ControlDelivery::new();
    delivery
        .send(state("d1", "d1"), BUFFERED_LIMIT + 1)
        .expect("open");
    delivery
        .send(inventory("inventory"), BUFFERED_LIMIT + 1)
        .expect("open");
    // A repeat keeps the first position (`Map.set` on an existing key).
    delivery.send(state("d1", "d1 latest"), 0).expect("open");

    let Flush::Write(writes) = delivery.fire(1, 0) else {
        panic!("the flush writes what waits");
    };
    assert_eq!(messages(&writes), ["d1 latest", "inventory"]);
    assert_eq!(delivery.pending(), 0);
}

#[test]
fn a_flush_while_the_transport_is_still_backed_up_rearms() {
    let mut delivery = ControlDelivery::new();
    delivery
        .send(inventory("inventory"), BUFFERED_LIMIT + 1)
        .expect("open");
    assert_eq!(delivery.fire(1, BUFFERED_LIMIT + 1), Flush::Rearm(2));
    assert_eq!(delivery.pending(), 1, "nothing was written");
    assert_eq!(delivery.fire(1, 0), Flush::Idle, "the old timer is stale");
    let Flush::Write(writes) = delivery.fire(2, 0) else {
        panic!("the new timer writes");
    };
    assert_eq!(messages(&writes), ["inventory"]);
}

#[test]
fn a_flush_with_nothing_waiting_stays_idle() {
    let mut delivery = ControlDelivery::new();
    assert_eq!(delivery.fire(1, 0), Flush::Idle);
    assert_eq!(delivery.pending(), 0);
    delivery
        .send(reply("result"), 0)
        .expect("replies write immediately");
    assert_eq!(delivery.pending(), 0);
    assert_eq!(delivery.fire(1, 0), Flush::Idle);
}

#[test]
fn a_stale_timer_does_nothing_and_close_refuses_every_send() {
    let mut delivery = ControlDelivery::new();
    assert_eq!(delivery.fire(7, 0), Flush::Idle);

    delivery
        .send(inventory("inventory"), BUFFERED_LIMIT + 1)
        .expect("open");
    assert_eq!(delivery.close(), Some(1), "the armed timer is cancelled");
    assert_eq!(delivery.send(reply("result"), 0), Err(String::from(CLOSED)));
    assert_eq!(delivery.fire(1, 0), Flush::Idle);
    assert_eq!(delivery.pending(), 0);
}

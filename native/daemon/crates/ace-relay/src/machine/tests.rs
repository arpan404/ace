//! `relay-machine-host.ts` and `transfers/route-policy.ts` have no unit test on the TypeScript
//! side; these are new, pinning the stream's slots, answers and hosted-relay rule.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use ace_json::Value;

use super::{
    Admission, HOSTED_RELAY_TRANSFER_BYTES, Incoming, PARALLEL, Slots, URGENT, WAITING, answer,
    hosted_relay_carries, incoming, refusal, transfer_chunk, welcome,
};

fn json(text: &str) -> Value {
    ace_json::parse(text).unwrap()
}

#[test]
fn the_welcome_names_the_host_and_only_offers_transfers_when_they_are_served() {
    let plain = welcome("HOST", 42, false);
    assert_eq!(plain.get("type").and_then(Value::as_str), Some("welcome"));
    assert_eq!(plain.get("hostId").and_then(Value::as_str), Some("HOST"));
    assert_eq!(
        plain.get("protocolVersion").and_then(Value::as_u64),
        Some(1)
    );
    assert_eq!(plain.get("headSeq").and_then(Value::as_u64), Some(42));
    assert!(plain.get("machineTransfers").is_none());
    let transfers = welcome("HOST", 42, true);
    assert_eq!(
        transfers.get("machineTransfers").and_then(Value::as_bool),
        Some(true)
    );
}

#[test]
fn frames_are_read_leniently_and_a_transfer_needs_the_offer() {
    assert_eq!(
        incoming(&json("{\"type\":\"ping\"}"), false, false),
        Incoming::Ping
    );
    assert_eq!(
        incoming(&json("{\"type\":\"machine.call\",\"id\":7}"), false, true),
        Incoming::Call {
            id: 7,
            urgent: true
        }
    );
    assert_eq!(
        incoming(
            &json("{\"type\":\"machine.transfer\",\"id\":8}"),
            false,
            false
        ),
        Incoming::Ignored
    );
    assert_eq!(
        incoming(
            &json("{\"type\":\"machine.transfer\",\"id\":8}"),
            true,
            false
        ),
        Incoming::Transfer { id: 8 }
    );
    assert_eq!(
        incoming(
            &json("{\"type\":\"machine.cancel\",\"id\":9}"),
            false,
            false
        ),
        Incoming::Cancel { id: 9 }
    );
    // Unknown, malformed and an id that isn't a number are ignored, never fatal.
    assert_eq!(
        incoming(&json("{\"type\":\"moved\"}"), true, false),
        Incoming::Ignored
    );
    assert_eq!(incoming(&json("null"), true, false), Incoming::Ignored);
    assert_eq!(
        incoming(
            &json("{\"type\":\"machine.call\",\"id\":\"x\"}"),
            true,
            false
        ),
        Incoming::Ignored
    );
}

#[test]
fn four_work_slots_and_four_urgent_ones_run_beside_each_other() {
    let mut slots = Slots::new();
    for id in 1..=PARALLEL as u64 {
        assert_eq!(slots.arrive(id, false), Admission::Run { urgent: false });
    }
    assert_eq!(slots.arrive(9, false), Admission::Wait);
    for id in 10..10 + URGENT as u64 {
        assert_eq!(slots.arrive(id, true), Admission::Run { urgent: true });
    }
    assert_eq!(slots.arrive(20, true), Admission::Refused);
    assert_eq!(slots.running(), PARALLEL);
    assert_eq!(slots.urgent(), URGENT);
    assert_eq!(slots.waiting(), 1);
}

#[test]
fn a_finished_work_slot_goes_straight_to_the_next_waiting_call() {
    let mut slots = Slots::new();
    for id in 1..=PARALLEL as u64 {
        slots.arrive(id, false);
    }
    assert_eq!(slots.arrive(50, false), Admission::Wait);
    assert_eq!(slots.arrive(51, false), Admission::Wait);
    assert_eq!(slots.finish(false), Some(50));
    assert_eq!(slots.finish(false), Some(51));
    assert_eq!(slots.finish(false), None);
    assert_eq!(slots.running(), PARALLEL - 1);
    assert_eq!(slots.waiting(), 0);
    // Urgent slots never hand on to the work line.
    slots.arrive(60, true);
    assert_eq!(slots.finish(true), None);
    assert_eq!(slots.urgent(), 0);
}

#[test]
fn a_peer_past_thirty_two_waiting_is_refused_rather_than_queued_without_end() {
    let mut slots = Slots::new();
    for id in 1..=PARALLEL as u64 {
        slots.arrive(id, false);
    }
    for id in 0..WAITING as u64 {
        assert_eq!(slots.arrive(100 + id, false), Admission::Wait);
    }
    assert_eq!(slots.arrive(999, false), Admission::Refused);
    // A caller that stops waiting frees a place.
    assert!(slots.leave_wait(100));
    assert_eq!(slots.arrive(1000, false), Admission::Wait);
    assert!(!slots.leave_wait(12345));
}

#[test]
fn a_cancelled_call_leaves_the_line_or_is_left_to_its_run_to_abort() {
    let mut slots = Slots::new();
    for id in 1..=PARALLEL as u64 {
        slots.arrive(id, false);
    }
    slots.arrive(70, false);
    assert!(slots.cancel(70));
    assert_eq!(slots.waiting(), 0);
    // A running call is known, but its abort belongs to the run; an unknown id is not.
    assert!(slots.cancel(1));
    assert!(slots.running() > 0);
}

#[test]
fn answers_carry_the_call_the_status_and_a_parsed_body() {
    let answered = answer(7, 200, "{\"ok\":true}");
    assert_eq!(
        answered.get("type").and_then(Value::as_str),
        Some("machine.answer")
    );
    assert_eq!(answered.get("id").and_then(Value::as_u64), Some(7));
    assert_eq!(answered.get("status").and_then(Value::as_u64), Some(200));
    assert_eq!(
        answered
            .get("body")
            .and_then(|body| body.get("ok"))
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        refusal(8, 401)
            .get("body")
            .unwrap()
            .get("error")
            .and_then(Value::as_str),
        Some("unauthorized")
    );
    assert_eq!(
        refusal(8, 503)
            .get("body")
            .unwrap()
            .get("error")
            .and_then(Value::as_str),
        Some("unavailable")
    );
}

#[test]
fn the_hosted_relay_carries_control_and_final_payloads_and_bulk_within_eight_mib() {
    assert!(hosted_relay_carries(
        0,
        "final",
        HOSTED_RELAY_TRANSFER_BYTES * 4
    ));
    assert!(hosted_relay_carries(0, "code", HOSTED_RELAY_TRANSFER_BYTES));
    assert!(!hosted_relay_carries(
        1,
        "code",
        HOSTED_RELAY_TRANSFER_BYTES
    ));
    assert!(hosted_relay_carries(HOSTED_RELAY_TRANSFER_BYTES, "code", 0));
}

#[test]
fn a_transfer_chunk_s_base64_decodes_for_the_target() {
    assert_eq!(transfer_chunk("aGVsbG8="), Some(b"hello".to_vec()));
    assert_eq!(transfer_chunk(""), Some(Vec::new()));
    assert_eq!(transfer_chunk("!!!"), None);
}

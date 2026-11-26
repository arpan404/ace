// SPDX-License-Identifier: Apache-2.0
//! `apps/relay/src/admission.ts` (client slots), `config.ts` (control messages, options) and
//! `host.ts` (registration, backoff, the http/media/client ticket answers, the first-message
//! rule). None of them has a unit test file; these are new.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use ace_json::Value;

use super::backoff::Backoff;
use super::{
    ClientSlots, ControlMessage, FirstMessage, HostOptions, HttpAnswer, Registration,
    RegistrationWait, RejectReason, authorize_first, first_message, http_answer, valid_host_id,
    valid_ticket,
};
use crate::noise::KeyPair;

fn json(text: &str) -> Value {
    ace_json::parse(text).unwrap()
}

#[test]
fn a_host_id_is_52_base32_characters_and_a_ticket_64_lowercase_hex() {
    let host = KeyPair::from_private([7u8; 32]).host_id();
    assert!(valid_host_id(&host));
    assert!(!valid_host_id(&host.to_lowercase()));
    assert!(!valid_host_id(&host[..51]));
    assert!(valid_ticket(&"a".repeat(64)));
    assert!(!valid_ticket(&"A".repeat(64)));
    assert!(!valid_ticket(&"a".repeat(63)));
}

#[test]
fn the_options_defaults_are_the_host_schema_and_its_refinements_hold() {
    let options = HostOptions::default();
    assert_eq!(options.max_client_channels, 64);
    assert_eq!(options.hello_timeout_ms, 10_000);
    assert_eq!(options.handshake_timeout_ms, 10_000);
    assert_eq!(options.idle_timeout_ms, 25_000);
    assert_eq!(options.ping_interval_ms, 10_000);
    assert_eq!(options.retry_initial_ms, 250);
    assert_eq!(options.retry_max_ms, 5_000);
    assert!(options.valid().is_ok());
    assert!(
        HostOptions {
            max_client_channels: 1_025,
            ..options
        }
        .valid()
        .is_err()
    );
    assert!(
        HostOptions {
            retry_initial_ms: 6_000,
            ..options
        }
        .valid()
        .is_err()
    );
}

#[test]
fn the_three_control_messages_parse_and_anything_else_ends_the_session() {
    let host_id = "A".repeat(52);
    assert_eq!(
        ControlMessage::parse(&json(&format!(
            "{{\"type\":\"registered\",\"hostId\":\"{host_id}\"}}"
        )))
        .unwrap(),
        ControlMessage::Registered {
            host_id: host_id.clone()
        }
    );
    let ticket = "a".repeat(64);
    assert_eq!(
        ControlMessage::parse(&json(&format!(
            "{{\"type\":\"client\",\"ticket\":\"{ticket}\"}}"
        )))
        .unwrap(),
        ControlMessage::Client {
            ticket: ticket.clone(),
            media: false
        }
    );
    assert_eq!(
        ControlMessage::parse(&json(&format!(
            "{{\"type\":\"client\",\"ticket\":\"{ticket}\",\"purpose\":\"media\"}}"
        )))
        .unwrap(),
        ControlMessage::Client {
            ticket: ticket.clone(),
            media: true
        }
    );
    assert!(
        ControlMessage::parse(&json(&format!(
            "{{\"type\":\"http\",\"ticket\":\"{ticket}\"}}"
        )))
        .is_ok()
    );
    // A purpose this daemon doesn't know, an unknown type, and a bad ticket are refused.
    assert!(
        ControlMessage::parse(&json(&format!(
            "{{\"type\":\"client\",\"ticket\":\"{ticket}\",\"purpose\":\"video\"}}"
        )))
        .is_err()
    );
    assert!(ControlMessage::parse(&json("{\"type\":\"moved\"}")).is_err());
    assert!(ControlMessage::parse(&json("{\"type\":\"http\",\"ticket\":\"short\"}")).is_err());
    assert!(
        ControlMessage::parse(&json("{\"type\":\"registered\",\"hostId\":\"short\"}")).is_err()
    );
}

#[test]
fn a_rejection_carries_its_ticket_and_reason_in_the_relay_s_words() {
    let ticket = "b".repeat(64);
    for (reason, word) in [(RejectReason::Off, "off"), (RejectReason::Busy, "busy")] {
        let message = json(&reason.message(&ticket));
        assert_eq!(message.get("type").and_then(Value::as_str), Some("reject"));
        assert_eq!(
            message.get("ticket").and_then(Value::as_str),
            Some(ticket.as_str())
        );
        assert_eq!(message.get("reason").and_then(Value::as_str), Some(word));
    }
}

#[test]
fn an_http_ticket_is_taken_only_when_the_path_is_on_and_under_its_cap() {
    assert_eq!(http_answer(false, 0, None), HttpAnswer::Off);
    assert_eq!(http_answer(true, 0, None), HttpAnswer::Open);
    assert_eq!(http_answer(true, 31, None), HttpAnswer::Open);
    assert_eq!(http_answer(true, 32, None), HttpAnswer::Busy);
    assert_eq!(http_answer(true, 4, Some(4)), HttpAnswer::Busy);
    assert_eq!(http_answer(true, 3, Some(4)), HttpAnswer::Open);
}

#[test]
fn pending_slots_are_evicted_oldest_first_and_authorized_ones_are_never() {
    let mut slots = ClientSlots::new(2);
    assert_eq!(slots.reserve("a").evicted, None);
    assert_eq!(slots.reserve("b").evicted, None);
    let third = slots.reserve("c");
    assert!(third.accepted);
    assert_eq!(third.evicted.as_deref(), Some("a"));
    assert_eq!(slots.len(), 2);
    // An authorized channel may not be evicted; a full host refuses the ticket.
    slots.authorize("b").unwrap();
    slots.authorize("c").unwrap();
    assert!(!slots.reserve("d").accepted);
    // An authorized channel that was never reserved is expired, not authorized.
    assert_eq!(
        slots.authorize("zzz").unwrap_err().to_string(),
        "Channel expired"
    );
    slots.release("b");
    assert!(slots.reserve("d").accepted);
    assert_eq!(slots.len(), 2);
}

#[test]
fn a_registration_bumps_the_generation_and_wakes_only_the_clients_that_waited_for_it() {
    let mut registration = Registration::default();
    assert_eq!(
        registration.when_registered(0),
        RegistrationWait::Waiting(0)
    );
    // The waiter asked for `after = 0`: generation 1 satisfies it; it is resolved and removed.
    assert_eq!(registration.registered("host", "host").unwrap(), vec![0]);
    assert_eq!(registration.generation(), 1);
    assert_eq!(registration.waiting(), 0);
    assert_eq!(registration.when_registered(0), RegistrationWait::Ready(1));
    assert_eq!(
        registration.when_registered(1),
        RegistrationWait::Waiting(0)
    );
    assert!(registration.registered("other", "host").is_err());
    let resolved = registration.registered("host", "host").unwrap();
    assert_eq!(resolved, vec![1]);
    assert_eq!(registration.waiting(), 0);
    registration.close();
    assert_eq!(registration.when_registered(0), RegistrationWait::Closed);
}

#[test]
fn more_than_1024_registration_waiters_are_told_to_ask_again() {
    let mut registration = Registration::default();
    for _ in 0..1_024 {
        assert!(matches!(
            registration.when_registered(0),
            RegistrationWait::Waiting(_)
        ));
    }
    assert_eq!(registration.when_registered(0), RegistrationWait::TooMany);
}

#[test]
fn the_retry_waits_between_half_and_all_of_the_current_interval_and_doubles_to_the_cap() {
    let mut backoff = Backoff::new(250, 5_000);
    assert_eq!(backoff.next(0.0), 125);
    assert_eq!(backoff.current(), 500);
    assert_eq!(backoff.next(1.0), 500);
    assert_eq!(backoff.current(), 1_000);
    assert_eq!(backoff.next(0.5), 750);
    backoff.reset();
    assert_eq!(backoff.current(), 250);
    let mut backoff = Backoff::new(4_000, 5_000);
    assert_eq!(backoff.next(0.0), 2_000);
    assert_eq!(backoff.current(), 5_000);
    assert_eq!(backoff.next(0.0), 2_500);
    assert_eq!(backoff.current(), 5_000);
}

#[test]
fn a_channel_s_first_message_is_its_confirmation_after_nk_and_its_hello_otherwise() {
    assert_eq!(
        first_message(true, false, Some("hello.confirm")),
        Ok(FirstMessage::Confirmation)
    );
    assert_eq!(
        first_message(true, false, Some("hello"))
            .unwrap_err()
            .to_string(),
        "First message must be hello.confirm"
    );
    assert_eq!(
        first_message(false, false, Some("hello")),
        Ok(FirstMessage::Hello)
    );
    assert_eq!(
        first_message(false, false, Some("pair.redeem")),
        Ok(FirstMessage::PairRedeem)
    );
    // A redemption never authorizes, and only one is let through.
    assert_eq!(
        first_message(false, true, Some("pair.redeem"))
            .unwrap_err()
            .to_string(),
        "First message must be hello"
    );
    assert_eq!(
        first_message(false, false, Some("ping"))
            .unwrap_err()
            .to_string(),
        "First message must be hello"
    );
    assert!(first_message(false, false, None).is_err());
}

#[test]
fn authorizing_needs_the_device_hello_and_a_live_channel() {
    assert_eq!(
        authorize_first(false, false).unwrap_err().to_string(),
        "Device hello has not been received"
    );
    assert_eq!(
        authorize_first(true, true).unwrap_err().to_string(),
        "Channel expired"
    );
    assert!(authorize_first(true, false).is_ok());
}

// SPDX-License-Identifier: Apache-2.0
//! T1b.3b's proof: the negotiation table `ws` 8.22 produces with ace's options,
//! the deflate window's mapping, the threshold, and RSV1 in both directions. The
//! codec's own cases are `tests/codec.rs`, the 8-bit-window decoder is
//! `tests/window8.rs`, and the wire half is `tests/wire.rs`.

use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;

use super::codec::{Deflater, INFLATE_WINDOW, Inflating, THRESHOLD, deflate_window};
use super::{Body, Deflate, Malformed, may_compress, negotiate};
use crate::frame::header::parse_first;
use crate::frame::read::FrameReader;
use crate::frame::{Frame, FrameError, Opcode};

mod codec;
mod window8;
mod wire;

fn answer(offer: &str) -> Result<Option<Deflate>, Malformed> {
    negotiate(Some(offer.as_bytes()))
}

#[test]
fn the_answer_is_the_offers_parameters_then_both_no_context_takeover_flags() {
    let table: &[(&str, &str)] = &[
        (
            "permessage-deflate; client_max_window_bits",
            "permessage-deflate; server_no_context_takeover; client_no_context_takeover",
        ),
        (
            "permessage-deflate; client_max_window_bits=10",
            "permessage-deflate; client_max_window_bits=10; server_no_context_takeover; client_no_context_takeover",
        ),
        (
            "permessage-deflate; server_max_window_bits=10",
            "permessage-deflate; server_max_window_bits=10; server_no_context_takeover; client_no_context_takeover",
        ),
        (
            "permessage-deflate; server_max_window_bits=8",
            "permessage-deflate; server_max_window_bits=8; server_no_context_takeover; client_no_context_takeover",
        ),
        (
            "permessage-deflate; client_max_window_bits=8",
            "permessage-deflate; client_max_window_bits=8; server_no_context_takeover; client_no_context_takeover",
        ),
        (
            "permessage-deflate; client_max_window_bits, permessage-deflate; server_max_window_bits=12",
            "permessage-deflate; server_no_context_takeover; client_no_context_takeover",
        ),
        (
            "permessage-deflate",
            "permessage-deflate; server_no_context_takeover; client_no_context_takeover",
        ),
        (
            "permessage-deflate; server_no_context_takeover; client_no_context_takeover; server_max_window_bits=9",
            "permessage-deflate; server_no_context_takeover; client_no_context_takeover; server_max_window_bits=9",
        ),
        (
            "permessage-deflate; server_no_context_takeover; client_max_window_bits",
            "permessage-deflate; server_no_context_takeover; client_no_context_takeover",
        ),
        (
            "permessage-deflate; client_max_window_bits=8; server_max_window_bits=8",
            "permessage-deflate; client_max_window_bits=8; server_max_window_bits=8; server_no_context_takeover; client_no_context_takeover",
        ),
        (
            "permessage-deflate; client_no_context_takeover; server_max_window_bits=8",
            "permessage-deflate; client_no_context_takeover; server_max_window_bits=8; server_no_context_takeover",
        ),
        (
            "permessage-deflate ; client_max_window_bits",
            "permessage-deflate; server_no_context_takeover; client_no_context_takeover",
        ),
        (
            "permessage-deflate; server_max_window_bits=\"10\"",
            "permessage-deflate; server_max_window_bits=10; server_no_context_takeover; client_no_context_takeover",
        ),
        (
            "foo; bar=baz, permessage-deflate",
            "permessage-deflate; server_no_context_takeover; client_no_context_takeover",
        ),
        (
            "permessage-deflate; server_max_window_bits=08",
            "permessage-deflate; server_max_window_bits=8; server_no_context_takeover; client_no_context_takeover",
        ),
        (
            "permessage-deflate; server_max_window_bits=15; client_max_window_bits=15",
            "permessage-deflate; server_max_window_bits=15; client_max_window_bits=15; server_no_context_takeover; client_no_context_takeover",
        ),
    ];
    for (offer, expected) in table {
        let agreed = answer(offer).unwrap_or_else(|_| panic!("{offer:?} is accepted"));
        let deflate = agreed.unwrap_or_else(|| panic!("{offer:?} negotiated deflate"));
        assert_eq!(deflate.header(), *expected, "{offer:?}");
    }
}

#[test]
fn a_malformed_offer_anywhere_refuses_the_upgrade() {
    // ws 8.22 answers each of these with its 400 (the table in the task's commit
    // message: `ws`'s own parser and `accept`, run once, then pasted).
    for offer in [
        "permessage-deflate; client_max_window_bits=",
        "permessage-deflate; =10",
        "permessage-deflate; foo",
        "permessage-deflate; server_max_window_bits=10; server_max_window_bits=11",
        "",
        "permessage-deflate; server_max_window_bits=7",
        "permessage-deflate; client_no_context_takeover=1",
        "permessage-deflate; server_max_window_bits",
        "permessage-deflate; client_max_window_bits=16",
        "permessage-deflate; client_max_window_bits; client_max_window_bits",
        "permessage-deflate; client_max_window_bits = 10",
        "permessage-deflate, permessage-deflate; foo",
        "permessage-deflate; Client_Max_Window_Bits",
        // `ws` reads a window with JavaScript's `+value`; only digits are taken
        // here (behaviour.md §2's recorded difference).
        "permessage-deflate; server_max_window_bits=0x0a",
        "permessage-deflate; server_max_window_bits=1e1",
        "permessage-deflate; server_max_window_bits=10.0",
        "permessage-deflate; server_max_window_bits=+10",
    ] {
        assert_eq!(answer(offer), Err(Malformed), "{offer:?}");
    }
}

#[test]
fn no_deflate_offer_negotiates_nothing() {
    assert_eq!(negotiate(None), Ok(None));
    for offer in ["x-webkit-deflate-frame", "permessage_deflate", "foo; a=b"] {
        assert_eq!(answer(offer), Ok(None), "{offer:?}");
    }
}

#[test]
fn the_window_bits_are_read_back_and_never_outside_eight_to_fifteen() {
    let deflate = answer("permessage-deflate; server_max_window_bits=8; client_max_window_bits=10")
        .expect("a valid offer")
        .expect("deflate");
    assert_eq!(deflate.server_max_window_bits(), Some(8));
    assert_eq!(deflate.client_max_window_bits(), Some(10));
    let none = answer("permessage-deflate; client_max_window_bits")
        .expect("a valid offer")
        .expect("deflate");
    assert_eq!(none.server_max_window_bits(), None);
    assert_eq!(none.client_max_window_bits(), None);
}

#[test]
fn eight_is_deflated_at_nine_and_every_other_value_as_given() {
    assert_eq!(deflate_window(None), 15);
    assert_eq!(deflate_window(Some(8)), 9);
    for bits in 9..=15u8 {
        assert_eq!(deflate_window(Some(bits)), bits);
    }
}

#[test]
fn every_window_constructor_builds_without_panicking() {
    // flate2 panics outside 9..=15; 8 never reaches it, and every value a
    // negotiation can produce is built here.
    for bits in 8..=15u8 {
        let _ = Deflater::new(deflate_window(Some(bits)));
        let _ = Inflating::new();
    }
    assert_eq!(deflate_window(None), INFLATE_WINDOW);
    assert_eq!(INFLATE_WINDOW, 15);
}

#[test]
fn rsv1_without_a_negotiated_extension_is_a_protocol_error() {
    assert!(parse_first([0xc2, 0x80], false).is_err());
    assert_eq!(
        parse_first([0xc2, 0x80], false)
            .err()
            .map(|error| error.to_string()),
        Some("Invalid WebSocket frame: RSV1 must be clear".to_owned())
    );
    // A negotiated socket accepts it on a new data frame, and never on a continuation.
    assert!(parse_first([0xc2, 0x80], true).is_ok());
    assert!(parse_first([0xc0, 0x80], true).is_err());
    assert!(parse_first([0xc9, 0x80], true).is_err());
}

/// A masked client frame the server reads, with RSV1 chosen.
fn masked(rsv1: bool, opcode: u8, payload: &[u8]) -> Vec<u8> {
    let mask = [0x11u8, 0x22, 0x33, 0x44];
    let mut frame = vec![
        0x80 | (if rsv1 { 0x40 } else { 0 }) | opcode,
        0x80 | payload.len() as u8,
    ];
    frame.extend_from_slice(&mask);
    frame.extend(
        payload
            .iter()
            .enumerate()
            .map(|(index, byte)| byte ^ mask[index % 4]),
    );
    frame
}

/// Reads one frame from `server` through a reader that collects messages in
/// `body`, after `bytes` reaches the other end of the duplex.
async fn first_frame(bytes: Vec<u8>, body: Body) -> Result<Option<Frame>, FrameError> {
    let (mut server, mut client) = tokio::io::duplex(64 * 1024);
    let mut reader = FrameReader::with_body(&mut server, body);
    client
        .write_all(&bytes)
        .await
        .expect("the frame is written");
    match reader.next().await {
        Some(Ok(frame)) => Ok(Some(frame)),
        Some(Err(error)) => Err(error),
        None => Ok(None),
    }
}

#[tokio::test]
async fn a_socket_that_never_negotiated_refuses_an_rsv1_data_frame() {
    let error = first_frame(masked(true, 0x2, b"hello"), Body::plain())
        .await
        .expect_err("RSV1 is a violation without an extension");
    assert_eq!(error.close_code(), Some(1002));
}

#[tokio::test]
async fn a_negotiated_socket_accepts_an_rsv1_data_frame_and_refuses_it_on_a_continuation() {
    let frame = first_frame(masked(true, 0x2, b"hello"), Body::compressed())
        .await
        .expect("a negotiated socket reads it")
        .expect("a frame");
    assert!(frame.rsv1);
    let error = first_frame(masked(true, 0x0, b"more"), Body::compressed())
        .await
        .expect_err("a continuation never carries RSV1");
    assert_eq!(error.close_code(), Some(1002));
}

#[test]
fn the_threshold_is_ws_s_own() {
    assert!(may_compress(Opcode::Binary, THRESHOLD, true));
    assert!(!may_compress(Opcode::Binary, THRESHOLD - 1, true));
    assert!(!may_compress(Opcode::Binary, THRESHOLD, false));
    assert!(!may_compress(Opcode::Close, 2, true));
    assert!(!may_compress(Opcode::Ping, 125, true));
    assert!(may_compress(Opcode::Text, 8 * 1024, true));
}

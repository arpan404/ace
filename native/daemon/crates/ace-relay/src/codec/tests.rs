//! The channel's framing and the codec over a real handshake. `apps/relay/src/channel.ts` has no
//! test file of its own: its cases are driven through real streams by `relay.process.test.ts`,
//! `flow-control.process.test.ts` and `compression.process.test.ts`, and these pin the same rules
//! at the codec. `flow-credit.test.ts`'s accounting lives beside `flow.rs`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::{
    Assembler, BINARY_MESSAGE_LIMIT, CHUNK, Codec, Kind, LOGICAL_MESSAGE_LIMIT, Message, decode,
    deflate, fragments, inflate,
};
use crate::noise::{KeyPair, NoiseXx};
use crate::wire::STREAM_PROLOGUE;

/// Two codecs wired by a real XX handshake, so the frames are the ones the relay carries.
fn pair() -> (Codec, Codec) {
    let mut client = NoiseXx::initiator(
        KeyPair::from_private([1u8; 32]),
        KeyPair::from_private([2u8; 32]),
        STREAM_PROLOGUE,
        None,
    );
    let mut server = NoiseXx::responder(
        KeyPair::from_private([3u8; 32]),
        KeyPair::from_private([4u8; 32]),
        STREAM_PROLOGUE,
    );
    let first = client.write_message(&[]).unwrap();
    server.read_message(&first).unwrap();
    let second = server.write_message(&[]).unwrap();
    client.read_message(&second).unwrap();
    let third = client.write_message(&[]).unwrap();
    server.read_message(&third).unwrap();
    (
        Codec::new(client.into_transport().unwrap()),
        Codec::new(server.into_transport().unwrap()),
    )
}

fn send(codec: &mut Codec, kind: Kind, payload: &[u8], compress: bool) -> Vec<Vec<u8>> {
    codec
        .outbound(kind, payload, compress)
        .unwrap()
        .into_iter()
        .map(|plain| codec.seal(&plain).unwrap())
        .collect()
}

#[test]
fn a_message_is_split_into_full_fragments_and_reassembled() {
    let payload = vec![b'x'; CHUNK * 2 + 5];
    let frames = fragments(Kind::Json, &payload).unwrap();
    assert_eq!(frames.len(), 3);
    assert_eq!(frames[0].len(), CHUNK + 1, "a full fragment and its flag");
    assert_eq!(frames[0][0], 0, "a JSON fragment that is not the last");
    assert_eq!(frames[1][0], 0);
    assert_eq!(frames[2][0], 1, "the last fragment's flag is one higher");

    let mut assembler = Assembler::default();
    assert!(assembler.push(&frames[0]).unwrap().is_none());
    assert!(assembler.push(&frames[1]).unwrap().is_none());
    let (kind, bytes) = assembler.push(&frames[2]).unwrap().unwrap();
    assert_eq!(kind, Kind::Json);
    assert_eq!(bytes, payload);
}

#[test]
fn a_short_non_last_fragment_and_mixed_kinds_are_refused() {
    // A fragment that is not the last must fill the frame: anything shorter is malformed.
    assert!(Assembler::default().push(&[0u8, b'x']).is_err());
    // A JSON fragment cannot start and a binary one finish the same message.
    let frames = fragments(Kind::Json, &vec![b'x'; CHUNK + 1]).unwrap();
    let mut assembler = Assembler::default();
    assert!(assembler.push(&frames[0]).unwrap().is_none());
    assert!(assembler.push(&[3u8, b'y']).is_err());
    // The credit flag is not a data kind.
    assert!(Assembler::default().push(&[7u8, 0]).is_err());
}

#[test]
fn every_kind_holds_its_own_message_limit() {
    assert!(fragments(Kind::Binary, &vec![0u8; BINARY_MESSAGE_LIMIT]).is_ok());
    assert!(fragments(Kind::Binary, &vec![0u8; BINARY_MESSAGE_LIMIT + 1]).is_err());
    assert!(fragments(Kind::Json, &vec![0u8; LOGICAL_MESSAGE_LIMIT + 1]).is_err());
    assert!(fragments(Kind::Json, &[]).is_err(), "a message has bytes");

    // A peer can still send two full frames: the assembler applies the binary bound as they
    // arrive, so a message built that way never hands 128 KiB to a handler.
    let full = fragments(Kind::Binary, &vec![0u8; CHUNK + 1])
        .unwrap()
        .remove(0);
    let mut assembler = Assembler::default();
    assert!(assembler.push(&full).unwrap().is_none());
    assert!(assembler.push(&full).is_err(), "past 64 KiB + 16");
}

#[test]
fn deflated_json_shrinks_and_round_trips_but_small_or_plain_messages_do_not_deflate() {
    let json = format!("{{\"text\":\"{}\"}}", "a".repeat(2_000)).into_bytes();
    let deflated = deflate(&json).expect("compressible JSON");
    assert!(deflated.len() < json.len());

    let frames = fragments(Kind::Deflated, &deflated).unwrap();
    let mut assembler = Assembler::default();
    let (kind, bytes) = assembler.push(&frames[0]).unwrap().unwrap();
    assert_eq!(kind, Kind::Deflated);
    assert_eq!(
        decode(kind, bytes).unwrap(),
        Message::Text(String::from_utf8(json).unwrap())
    );

    // Below 1 KiB a deflate is not attempted at all.
    assert!(deflate(b"{\"type\":\"ping\"}").is_none());
    // An inflate is bounded: a bomb is refused rather than allocated.
    let bomb = deflate(&vec![0u8; LOGICAL_MESSAGE_LIMIT + 1]).expect("zeros compress");
    assert!(inflate(&bomb).is_err());
}

#[test]
fn json_that_is_not_utf8_is_refused_and_binary_is_not_decoded() {
    assert!(decode(Kind::Json, vec![0xff, 0xfe]).is_err());
    assert_eq!(
        decode(Kind::Binary, vec![0xff, 0xfe]).unwrap(),
        Message::Binary(vec![0xff, 0xfe])
    );
}

#[test]
fn a_codec_carries_json_and_binary_and_deflates_only_when_asked() {
    let (mut client, mut server) = pair();
    let frames = send(&mut client, Kind::Json, br#"{"type":"ping"}"#, false);
    let received = server.open(&frames[0]).unwrap();
    assert_eq!(
        received.message,
        Some(Message::Text(r#"{"type":"ping"}"#.to_owned()))
    );

    let binary: Vec<u8> = (0..=255).collect();
    let frames = send(&mut client, Kind::Binary, &binary, false);
    let received = server.open(&frames[0]).unwrap();
    assert_eq!(received.message, Some(Message::Binary(binary)));

    // A compressible message goes as the deflated kind and arrives as the same text.
    let big = format!("{{\"type\":\"events\",\"text\":\"{}\"}}", "a".repeat(4_000));
    let frames = send(&mut client, Kind::Json, big.as_bytes(), true);
    assert!(frames.len() < 2);
    let received = server.open(&frames[0]).unwrap();
    assert_eq!(received.message, Some(Message::Text(big)));
}

#[test]
fn flow_control_starts_both_ways_and_its_credit_comes_back_over_the_stream() {
    let (mut client, mut server) = pair();
    let start = client.start_flow_control().expect("the start credit");
    let received = server.open(&client.seal(&start).unwrap()).unwrap();
    // The peer's start turns the server's own limit on: the reply is a credit to write.
    let reply = received.credit.expect("the reply start credit");
    let received = client.open(&server.seal(&reply).unwrap()).unwrap();
    assert!(received.credit.is_none(), "the client already started");

    // A message still crosses after both sides are limited.
    let frames = send(&mut client, Kind::Json, br#"{"type":"welcome"}"#, false);
    let received = server.open(&frames[0]).unwrap();
    assert_eq!(
        received.message,
        Some(Message::Text(r#"{"type":"welcome"}"#.to_owned()))
    );
    assert!(client.may_send(crate::codec::fragment_cost(CHUNK)));
}

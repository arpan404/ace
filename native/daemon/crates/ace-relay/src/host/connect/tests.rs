//! `apps/relay/src/host.ts`'s channel rules at the codec: what a client may send first, what
//! crosses in either direction, and the refusals the relay reads. The registration loop itself is
//! proven by the daemon's process files against a local relay (slice 7's composition).

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use super::{Context, LinkChannel, reject};
use crate::codec::{Codec, Kind, Message};
use crate::error::RelayError;
use crate::host::frame_io::{FrameIo, Pipe};
use crate::host::link::Incoming;
use crate::host::{ClientSlots, HostOptions, RejectReason};
use crate::noise::{KeyPair, NoiseXx, SessionKeys};
use crate::socket::{Frame, HostChannel};
use crate::wire::STREAM_PROLOGUE;

fn data(io: &mut dyn FrameIo) -> Vec<u8> {
    match io.read().unwrap() {
        Incoming::Data(frame) => frame,
        other => panic!("expected data, got {other:?}"),
    }
}

/// Two pipes wired through a real XX handshake: the client's socket and keys, and the peer's.
fn wired() -> (Pipe, SessionKeys, Pipe, SessionKeys) {
    let (client_io, server_io) = Pipe::pair();
    let client = std::thread::spawn(move || {
        let mut io = client_io;
        let mut xx = NoiseXx::initiator(
            KeyPair::from_private([1u8; 32]),
            KeyPair::from_private([2u8; 32]),
            STREAM_PROLOGUE,
            None,
        );
        io.send(&xx.write_message(&[]).unwrap()).unwrap();
        let second = data(&mut io);
        xx.read_message(&second).unwrap();
        io.send(&xx.write_message(&[]).unwrap()).unwrap();
        let keys = xx.take_transport().unwrap();
        (io, keys)
    });
    let mut io = server_io;
    let mut xx = NoiseXx::responder(
        KeyPair::from_private([3u8; 32]),
        KeyPair::from_private([4u8; 32]),
        STREAM_PROLOGUE,
    );
    let first = data(&mut io);
    xx.read_message(&first).unwrap();
    io.send(&xx.write_message(&[]).unwrap()).unwrap();
    let third = data(&mut io);
    xx.read_message(&third).unwrap();
    let server_keys = xx.take_transport().unwrap();
    let (client_io, client_keys) = client.join().unwrap();
    (client_io, client_keys, io, server_keys)
}

fn channel(io: Pipe, keys: SessionKeys, nk: bool) -> LinkChannel<Pipe> {
    LinkChannel::new(
        io,
        Codec::new(keys),
        true,
        Arc::new(AtomicBool::new(false)),
        Arc::new(|| 1_000),
        HostOptions::default().idle_timeout_ms,
        nk,
    )
}

#[test]
fn a_channel_carries_the_hellos_both_ways_after_the_handshake() {
    let (client_io, client_keys, mut server_io, server_keys) = wired();
    let mut client = channel(client_io, client_keys, false);
    let mut server = Codec::new(server_keys);

    // The client's hello arrives whole.
    client
        .send_text(r#"{"type":"hello","protocolVersion":1}"#, false)
        .unwrap();
    let sealed = data(&mut server_io);
    let received = server.open(&sealed).unwrap();
    assert_eq!(
        received.message,
        Some(Message::Text(
            r#"{"type":"hello","protocolVersion":1}"#.to_owned()
        ))
    );

    // The peer's first message is the hello, so the channel takes it and hands it on.
    let plain = server
        .outbound(Kind::Json, br#"{"type":"hello"}"#, false)
        .unwrap();
    server_io.send(&server.seal(&plain[0]).unwrap()).unwrap();
    assert_eq!(
        client.receive(),
        Some(Frame::Text(r#"{"type":"hello"}"#.to_owned()))
    );

    // Binary input is carried as bytes.
    client.send_binary(&[1, 2, 3]).unwrap();
    let sealed = data(&mut server_io);
    assert_eq!(
        server.open(&sealed).unwrap().message,
        Some(Message::Binary(vec![1, 2, 3]))
    );
}

#[test]
fn a_first_message_that_is_not_the_hello_closes_the_channel() {
    let (client_io, client_keys, mut server_io, server_keys) = wired();
    let mut client = channel(client_io, client_keys, false);
    let mut server = Codec::new(server_keys);
    // A binary first message: never a hello.
    let plain = server.outbound(Kind::Binary, &[9, 9], false).unwrap();
    server_io.send(&server.seal(&plain[0]).unwrap()).unwrap();
    assert_eq!(client.receive(), None);
    assert_eq!(
        client.closed_cause(),
        Some(RelayError::Protocol("First message must be hello"))
    );
}

#[test]
fn an_nk_channels_first_message_must_be_the_confirmation() {
    let (client_io, client_keys, mut server_io, server_keys) = wired();
    let mut client = channel(client_io, client_keys, true);
    let mut server = Codec::new(server_keys);
    let plain = server
        .outbound(Kind::Json, br#"{"type":"hello"}"#, false)
        .unwrap();
    server_io.send(&server.seal(&plain[0]).unwrap()).unwrap();
    assert_eq!(client.receive(), None);
    assert_eq!(
        client.closed_cause(),
        Some(RelayError::Protocol("First message must be hello.confirm"))
    );
}

#[test]
fn the_relays_refusals_are_the_two_json_shapes() {
    let (mut client_io, mut client_keys, mut server_io, mut server_keys) = wired();
    reject(&mut server_io, &mut server_keys, "abc", None).unwrap();
    let plain = client_keys.receive(&data(&mut client_io)).unwrap();
    assert_eq!(
        std::str::from_utf8(&plain).unwrap(),
        r#"{"type":"reject","ticket":"abc"}"#
    );
    reject(
        &mut server_io,
        &mut server_keys,
        "abc",
        Some(RejectReason::Off),
    )
    .unwrap();
    let plain = client_keys.receive(&data(&mut client_io)).unwrap();
    assert_eq!(
        std::str::from_utf8(&plain).unwrap(),
        r#"{"type":"reject","ticket":"abc","reason":"off"}"#
    );
}

#[test]
fn the_context_types_line_up_with_the_options_a_channel_is_opened_under() {
    let _ = Context {
        relay_url: String::new(),
        host_id: String::new(),
        keys: KeyPair::from_private([5u8; 32]),
        options: HostOptions::default(),
        ace_client: None,
        clock: Arc::new(|| 0),
        entropy: Arc::new(|size| vec![0; size]),
        nk: None,
        slots: Arc::new(std::sync::Mutex::new(ClientSlots::new(64))),
        pending: Arc::new(std::sync::Mutex::new(Default::default())),
        on_client: Arc::new(|_| {}),
    };
    let mut slots = ClientSlots::new(1);
    assert!(slots.reserve("one").accepted);
    slots.authorize("one").unwrap();
    // Every slot is authorized: a new ticket is refused rather than evicting a device.
    assert!(!slots.reserve("two").accepted);
    slots.release("one");
    assert!(slots.reserve("two").accepted);
}

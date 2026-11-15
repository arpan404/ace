// SPDX-License-Identifier: Apache-2.0
//! Delivery on the real binary (D1): a client's media connection on the direct listener, the
//! pieces it gets, the ack window that paces them, and every direct refusal from "Media
//! connection authorization". Each negative case tries the attack and checks that nothing of
//! the source reaches the wrong party.
#![cfg(unix)]
mod support;

use media_core::envelope::Assembler;
use media_core::headers::decode_video;
use media_wire::control::{FromMedia, Lane};
use media_wire::frame::MediaFrame;
use media_wire::media_link::{close, hello};
use serde_json::{Value, json};
use std::io::{ErrorKind, Write};
use std::net::TcpStream;
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use support::*;
use tokio_tungstenite::tungstenite::{self, Message, WebSocket};

type Client = WebSocket<TcpStream>;

fn wall_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn owner(device: &str, admission: Value) -> Value {
    json!({ "session": format!("session-{device}"), "device": device, "admission": admission })
}

/// A pairing admission: generations are opaque strings (credential hashes) the daemon gives.
fn pairing(generation: u64) -> Value {
    json!({ "kind": "pairing", "generation": format!("{generation:032x}") })
}

fn ticket(media: &mut Media, connection: &str, owner: &Value, issued: u64, ms: u64, bytes: u8) {
    media.send(
        json!({ "type": "media.ticket", "connection": connection, "owner": owner,
                "issued": issued, "expiresAt": wall_ms() + ms }),
        &[bytes; 32],
    );
}

fn view(media: &mut Media, viewer: &str, connection: &str, owner: &Value, issued: u64) {
    media.send(
        json!({ "type": "viewer.open", "viewer": viewer, "connection": connection,
                "owner": owner, "issued": issued, "source": "s1",
                "target": { "kind": "browser", "threadId": "t1" },
                "codecs": ["avc1.42E033"],
                "viewport": { "width": 800, "height": 600, "dpr": 1, "scale": 1 },
                "local": true, "audio": false }),
        &[],
    );
}

/// Opens a media connection and presents `bytes` as its ticket. The welcome, or the close code.
fn connect(media: &Media, bytes: u8) -> Result<Client, u16> {
    connect_to(media.listen_port, bytes)
}

fn connect_to(port: u32, bytes: u8) -> Result<Client, u16> {
    let Ok(stream) = TcpStream::connect(("127.0.0.1", port as u16)) else {
        panic!("the direct listener refused the connection");
    };
    let url = format!("ws://127.0.0.1:{port}/media");
    let Ok((mut client, _)) = tungstenite::client(url.as_str(), stream) else {
        panic!("the handshake failed");
    };
    let _ = client
        .get_mut()
        .set_read_timeout(Some(Duration::from_secs(3)));
    let _ = client.send(Message::Binary(hello(&[bytes; 32]).to_vec().into()));
    match next(&mut client) {
        Some(Message::Text(text)) if text.contains("media.welcome") => Ok(client),
        Some(Message::Close(Some(frame))) => Err(u16::from(frame.code)),
        other => panic!("expected a welcome or a close, got {other:?}"),
    }
}

/// The next message, or None when the read timed out or the socket closed.
fn next(client: &mut Client) -> Option<Message> {
    match client.read() {
        Ok(message) => Some(message),
        Err(tungstenite::Error::Io(e))
            if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
        {
            None
        }
        Err(_) => None,
    }
}

/// The close code the client sees next, skipping pieces still on the way.
fn closed_with(client: &mut Client) -> Option<u16> {
    loop {
        match next(client)? {
            Message::Close(frame) => return frame.map(|f| u16::from(f.code)),
            _ => continue,
        }
    }
}

/// The video units the client assembles before the read times out: (sequence, key, payload).
fn units(client: &mut Client, timeout: Duration) -> Vec<(u64, bool, Vec<u8>)> {
    let _ = client.get_mut().set_read_timeout(Some(timeout));
    let mut assembler = Assembler::new();
    let mut out = Vec::new();
    while let Some(message) = next(client) {
        let Message::Binary(bytes) = message else {
            continue;
        };
        let Ok(Some(envelope)) = assembler.push(&bytes) else {
            continue;
        };
        if envelope.kind != 2 {
            continue;
        }
        let Ok(video) = decode_video(envelope.meta, envelope.payload) else {
            panic!("a piece that doesn't decode");
        };
        assert_eq!(video.thread_id, "t1");
        out.push((video.sequence as u64, video.key, envelope.payload.to_vec()));
    }
    out
}

fn unit(key: bool, n: u8) -> Vec<u8> {
    let frame = MediaFrame {
        kind: 1,
        flags: u32::from(key),
        age_us: 0,
        width: 640,
        height: 400,
        display_width: 640,
        display_height: 400,
        scale: 1000,
        rotation: 0,
        codec: 1,
        encode: 0,
        epoch: 1,
        codec_string: "avc1.42E033".into(),
        description: Vec::new(),
        extension: Vec::new(),
        payload: vec![0, 0, 0, 1, if key { 0x65 } else { 0x41 }, n],
    };
    match frame.encode() {
        Ok(bytes) => bytes,
        Err(_) => panic!("unit did not encode"),
    }
}

fn producer(ingest: &str, token: u8) -> UnixStream {
    let Ok(mut producer) = UnixStream::connect(ingest) else {
        panic!("ingest socket refused the connection");
    };
    let _ = producer.write_all(&media_frame(5, 0, vec![token; 32]));
    producer
}

/// Waits for a normal-lane message `matches` picks, skipping the rest.
fn wait_for(media: &mut Media, mut matches: impl FnMut(&FromMedia) -> bool) -> FromMedia {
    for _ in 0..500 {
        let message = media.read();
        if matches(&message) {
            return message;
        }
    }
    panic!("the message never came");
}

fn settle(media: &mut Media, id: &str) {
    media.send(json!({ "type": "ping", "id": id }), &[]);
    wait_for(
        media,
        |m| matches!(m, FromMedia::Pong { id: got, .. } if got.get() == id),
    );
}

struct Lanes {
    priority: UnixStream,
    _egress: UnixStream,
}

fn lanes(control: &str) -> Lanes {
    let (Some(priority), Some(egress)) = (lane(control, 1, SECRET), lane(control, 2, SECRET))
    else {
        panic!("lanes refused");
    };
    Lanes {
        priority,
        _egress: egress,
    }
}

fn revoke(lanes: &mut Lanes, issued: u64, device: &str, admission: Option<Value>) -> Duration {
    let mut message = json!({ "type": "revoke", "id": format!("r{issued}"), "issued": issued,
                              "device": device });
    if let Some(admission) = admission {
        message["admission"] = admission;
    }
    let at = Instant::now();
    let _ = lanes
        .priority
        .write_all(&frame(message, &[], Lane::Priority));
    match read_frame(&mut lanes.priority, Lane::Priority) {
        FromMedia::Revoked { .. } => at.elapsed(),
        other => panic!("expected revoked, got {other:?}"),
    }
}

/// A source with one viewer on an open media connection, and its producer.
fn watching(name: &str) -> (Media, Lanes, Client, UnixStream) {
    let mut media = Media::spawn(name);
    let (control, ingest, _) = media.start();
    let lanes = lanes(&control);
    open_source(&mut media, "s1", 1, 3);
    let me = owner("phone", pairing(1));
    ticket(&mut media, "mc_one", &me, 1, 30_000, 9);
    settle(&mut media, "ticketed");
    let Ok(client) = connect(&media, 9) else {
        panic!("a fresh ticket was refused");
    };
    view(&mut media, "v1", "mc_one", &me, 2);
    wait_for(&mut media, |m| matches!(m, FromMedia::SourceWant { .. }));
    let producer = producer(&ingest, 3);
    (media, lanes, client, producer)
}

#[test]
fn a_viewer_gets_its_sources_units_as_pieces_and_its_acks_pace_them() {
    let (mut media, _lanes, mut client, mut producer) = watching("deliver");
    let _ = producer.write_all(&unit(true, 0));
    for n in 1..=80 {
        let _ = producer.write_all(&unit(false, n));
    }
    let got = units(&mut client, Duration::from_millis(1500));
    assert!(
        got.first().is_some_and(|(_, key, _)| *key),
        "starts at a keyframe"
    );
    assert_eq!(
        got.first().map(|u| u.2.as_slice()),
        Some(&[0, 0, 0, 1, 0x65, 0][..])
    );
    // The ack window holds 60 units in flight; a delta past it is dropped, and the viewer
    // waits for the producer's next keyframe, which ace-media asks for.
    assert_eq!(got.len(), 60, "{} units before any ack", got.len());
    wait_for(
        &mut media,
        |m| matches!(m, FromMedia::SourceKeyframe { source, encode: 0, .. } if source.get() == "s1"),
    );
    let last = got.last().map_or(0, |u| u.0);
    assert!(
        got.iter().zip(1..).all(|(u, i)| u.0 == i),
        "in order, none repeated"
    );
    let _ = client.send(Message::Text(
        json!({ "type": "browser.ack", "threadId": "t1", "sequence": last, "video": true })
            .to_string()
            .into(),
    ));
    let _ = producer.write_all(&unit(true, 90));
    for n in 91..=95 {
        let _ = producer.write_all(&unit(false, n));
    }
    let more = units(&mut client, Duration::from_millis(1500));
    let payloads: Vec<u8> = more.iter().map(|u| u.2[5]).collect();
    assert_eq!(
        payloads,
        [90, 91, 92, 93, 94, 95],
        "the next group, from its keyframe"
    );
    assert!(more[0].1);
}

#[test]
fn a_ticket_opens_its_connection_once_and_only_before_it_expires() {
    let mut media = Media::spawn("tickets");
    let (control, _, _) = media.start();
    let _lanes = lanes(&control);
    let me = owner("phone", pairing(1));
    ticket(&mut media, "mc_reuse", &me, 1, 30_000, 4);
    ticket(&mut media, "mc_late", &me, 2, 200, 5);
    settle(&mut media, "ticketed");
    assert!(connect(&media, 4).is_ok());
    assert_eq!(connect(&media, 4).err(), Some(close::REFUSED), "reused");
    assert_eq!(
        connect(&media, 6).err(),
        Some(close::REFUSED),
        "never issued"
    );
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(connect(&media, 5).err(), Some(close::REFUSED), "expired");
    wait_for(&mut media, |m| {
        matches!(m, FromMedia::ConnectionClosed { connection, reason }
            if connection.get() == "mc_late" && reason == "expired")
    });
}

#[test]
fn a_grant_naming_another_owners_connection_is_refused_and_sends_it_nothing() {
    let (mut media, _lanes, mut client, mut producer) = watching("owner");
    // Another device's grant on this connection, sent straight to ace-media.
    let other = owner("laptop", pairing(1));
    media.send(
        json!({ "type": "viewer.open", "viewer": "v2", "connection": "mc_one",
                "owner": other, "issued": 3, "source": "s1",
                "target": { "kind": "browser", "threadId": "t2" }, "codecs": ["avc1.42E033"],
                "viewport": { "width": 800, "height": 600, "dpr": 1, "scale": 1 },
                "local": true, "audio": false }),
        &[],
    );
    let refused = wait_for(&mut media, |m| matches!(m, FromMedia::GrantRefused { .. }));
    assert!(matches!(refused, FromMedia::GrantRefused { id, reason, .. }
        if id.get() == "v2" && reason == media_wire::control::Refusal::Owner));
    let _ = producer.write_all(&unit(true, 0));
    // Only the owner's view gets units: `units` asserts each one names thread t1.
    assert_eq!(units(&mut client, Duration::from_millis(800)).len(), 1);
}

#[test]
fn a_client_sending_anything_but_acks_and_pings_is_closed() {
    for (name, sent) in [
        (
            "subscribe",
            json!({ "type": "browser.subscribe", "requestId": "r", "threadId": "t1" }),
        ),
        (
            "rpc",
            json!({ "type": "command", "command": { "type": "thread.stop" } }),
        ),
        ("keys", json!({ "type": "relay.keys", "stream": "s" })),
    ] {
        let (_media, _lanes, mut client, _producer) = watching(&format!("rule-{name}"));
        let _ = client.send(Message::Text(sent.to_string().into()));
        assert_eq!(closed_with(&mut client), Some(close::PROTOCOL), "{name}");
    }
    // An HTTP request that isn't the media upgrade gets nothing but a refusal.
    let media = Media::spawn("http");
    let mut media = media;
    media.start();
    let (code, _) = websocket(media.listen_port, "/ingest", "app://video-encoder");
    assert_eq!(code, 404);
    let Ok(mut plain) = TcpStream::connect(("127.0.0.1", media.listen_port as u16)) else {
        panic!("listener refused");
    };
    let _ = plain.write_all(b"GET /media HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    let _ = plain.set_read_timeout(Some(Duration::from_secs(3)));
    let mut answer = String::new();
    let _ = std::io::Read::read_to_string(&mut plain, &mut answer);
    assert!(
        !answer.contains(" 101 "),
        "no upgrade without a WebSocket handshake"
    );
}

#[test]
fn a_revocation_closes_its_connections_within_250_ms_and_leaves_the_other_admission_open() {
    let mut media = Media::spawn("revoke");
    let (control, _, _) = media.start();
    let mut lanes = lanes(&control);
    let paired = owner("phone", pairing(1));
    let account = owner("phone", json!({ "kind": "account", "account": "acct-1" }));
    ticket(&mut media, "mc_pair", &paired, 1, 30_000, 1);
    ticket(&mut media, "mc_acct", &account, 2, 30_000, 2);
    settle(&mut media, "ticketed");
    let (Ok(mut pair), Ok(mut acct)) = (connect(&media, 1), connect(&media, 2)) else {
        panic!("fresh tickets refused");
    };
    let at = Instant::now();
    revoke(&mut lanes, 3, "phone", Some(pairing(1)));
    assert_eq!(closed_with(&mut pair), Some(close::REVOKED));
    let took = at.elapsed();
    assert!(took < Duration::from_millis(250), "closed after {took:?}");
    // The account-admitted connection of the same device stays open: it still answers pings.
    let _ = acct.send(Message::Text(json!({ "type": "ping" }).to_string().into()));
    assert!(matches!(next(&mut acct), Some(Message::Text(t)) if t.contains("pong")));
    // And the reverse: an account revocation closes only the account's.
    revoke(
        &mut lanes,
        4,
        "phone",
        Some(json!({ "kind": "account", "account": "acct-1" })),
    );
    assert_eq!(closed_with(&mut acct), Some(close::REVOKED));
}

#[test]
fn grants_issued_before_a_revocation_never_take_effect() {
    let mut media = Media::spawn("queued");
    let (control, _, _) = media.start();
    let mut lanes = lanes(&control);
    let me = owner("phone", pairing(1));
    revoke(&mut lanes, 5, "phone", Some(pairing(1)));
    // Both were issued before the revocation that reached ace-media first.
    ticket(&mut media, "mc_stale", &me, 4, 30_000, 8);
    let refused = wait_for(&mut media, |m| matches!(m, FromMedia::GrantRefused { .. }));
    assert!(matches!(refused, FromMedia::GrantRefused { reason, .. }
        if reason == media_wire::control::Refusal::Revoked));
    assert_eq!(connect(&media, 8).err(), Some(close::REFUSED));
}

#[test]
fn a_hello_that_comes_before_its_ticket_waits_for_it() {
    let mut media = Media::spawn("early");
    let (control, _, _) = media.start();
    let _lanes = lanes(&control);
    let port = media.listen_port;
    let early = std::thread::spawn(move || connect_to(port, 7).is_ok());
    std::thread::sleep(Duration::from_millis(300));
    ticket(
        &mut media,
        "mc_early",
        &owner("phone", pairing(1)),
        1,
        30_000,
        7,
    );
    assert!(
        early.join().unwrap_or(false),
        "the hello was refused before its ticket came"
    );
}

#[test]
fn a_zero_ticket_is_refused_on_the_listener() {
    let mut media = Media::spawn("zero");
    let (control, _, _) = media.start();
    let _lanes = lanes(&control);
    ticket(
        &mut media,
        "mc_zero",
        &owner("phone", pairing(1)),
        1,
        30_000,
        0,
    );
    ticket(
        &mut media,
        "mc_real",
        &owner("phone", pairing(1)),
        2,
        30_000,
        3,
    );
    settle(&mut media, "ticketed");
    assert_eq!(connect(&media, 0).err(), Some(close::REFUSED));
    assert!(connect(&media, 3).is_ok(), "the real client is admitted");
}

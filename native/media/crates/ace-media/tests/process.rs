// SPDX-License-Identifier: Apache-2.0
//! The real binary over its real pipes and sockets: what the pure engine tests can't cover is
//! the start, lane authentication on the socket, ingest connections and exit on stdin EOF.
#![cfg(unix)]
mod support;

use media_wire::control::{FromMedia, Lane, Status};
use serde_json::json;
use std::io::Write;
use std::os::unix::net::UnixStream;
use std::time::Duration;
use support::*;

#[test]
fn starts_authenticates_its_lanes_once_serves_both_lanes_and_exits_when_stdin_closes() {
    let mut media = Media::spawn("lanes");
    let (control, ingest_socket, _) = media.start();

    // A wrong secret and an unknown tag are closed without an answer; the real lanes still
    // authenticate, once each, and nothing after them.
    assert!(lane(&control, 1, [8; 32]).is_none());
    assert!(lane(&control, 9, SECRET).is_none());
    let Some(mut priority) = lane(&control, 1, SECRET) else {
        panic!("priority lane refused");
    };
    assert!(lane(&control, 1, SECRET).is_none(), "repeated tag");
    let Some(_egress) = lane(&control, 2, SECRET) else {
        panic!("egress lane refused");
    };
    assert!(
        lane(&control, 2, SECRET).is_none(),
        "after both lanes are up"
    );

    media.send(json!({ "type": "ping", "id": "p1" }), &[]);
    assert!(
        matches!(media.read(), FromMedia::Pong { id, stats } if id.get() == "p1" && stats.rss_bytes.get() > 0)
    );

    let revoke = json!({ "type": "revoke", "id": "r1", "issued": 1, "device": "d1" });
    let _ = priority.write_all(&frame(revoke, &[], Lane::Priority));
    assert!(
        matches!(read_frame(&mut priority, Lane::Priority), FromMedia::Revoked { id } if id.get() == "r1")
    );

    // A producer streams on the ingest socket after its hello.
    open_source(&mut media, "s1", 1, 3);
    let Ok(mut producer) = UnixStream::connect(&ingest_socket) else {
        panic!("ingest socket refused the connection");
    };
    let _ = producer.write_all(&media_frame(5, 0, vec![3; 32]));
    let _ = producer.write_all(&media_frame(1, 1, vec![0; 1000]));
    assert_eq!(status_of(media.read()), ("s1".into(), Status::Playing));
    drop(producer);
    assert_eq!(status_of(media.read()), ("s1".into(), Status::Retrying));

    drop(media.stdin.take());
    assert_eq!(media.exits_within(Duration::from_secs(1)), Some(0));
    assert!(
        !std::path::Path::new(&control).exists(),
        "sockets removed at exit"
    );
}

#[test]
fn a_first_message_other_than_a_valid_init_is_a_protocol_error() {
    let mut media = Media::spawn("noinit");
    media.send(json!({ "type": "ping", "id": "p1" }), &[]);
    assert_eq!(media.exits_within(Duration::from_secs(2)), Some(2));

    let mut media = Media::spawn("badinit");
    let mut bytes = frame(
        json!({ "type": "init", "protocol": 1, "version": "x", "runtimeDir": "/tmp",
                "dataDir": "/tmp", "settings": { "recordings": "legacy", "stills": "legacy",
                "encode": "legacy", "delivery": "legacy" } }),
        &SECRET,
        Lane::Normal,
    );
    // The same frame claiming protocol 2.
    let at = bytes.windows(12).position(|w| w == b"\"protocol\":1");
    let Some(at) = at else {
        panic!("protocol field not found");
    };
    bytes[at + 11] = b'2';
    media.write(&bytes);
    assert_eq!(media.exits_within(Duration::from_secs(2)), Some(2));
}

#[test]
fn the_ingest_websocket_admits_only_its_path_and_allowed_origins() {
    let mut media = Media::spawn("ws");
    let (_, _, port) = media.start();
    let extension = "chrome-extension://ldgefbphhfgphnecebnomhhopapknllk";
    for (path, origin, admitted) in [
        ("/ingest", "https://example.com", false),
        (
            "/ingest",
            "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            false,
        ),
        ("/other", extension, false),
        ("/ingest", "app://video-encoder", true),
    ] {
        let (code, _) = websocket(port, path, origin);
        assert_eq!(code == 101, admitted, "{path} from {origin}: {code}");
    }

    open_source(&mut media, "s1", 1, 4);
    let (code, mut socket) = websocket(port, "/ingest", extension);
    assert_eq!(code, 101);
    let _ = socket.write_all(&binary_message(&media_frame(5, 0, vec![4; 32])));
    let _ = socket.write_all(&binary_message(&media_frame(1, 1, vec![0; 500])));
    assert_eq!(status_of(media.read()), ("s1".into(), Status::Playing));
}

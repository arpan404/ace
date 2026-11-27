//! The address rules of `apps/relay/src/socket.ts` and a dial against a real local WebSocket
//! server (plain `ws`: the tests never touch TLS or the hosted relay).

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::net::TcpListener;
use std::sync::mpsc;
use std::time::Duration;

use tungstenite::Message;

use super::{Incoming, Link, Timeouts, relay_address};

fn timeouts() -> Timeouts {
    Timeouts {
        connect: Duration::from_secs(2),
        read: Duration::from_millis(250),
    }
}

#[test]
fn a_relay_address_keeps_its_origin_and_replaces_the_path_and_query() {
    assert_eq!(
        relay_address("wss://relay.example/somewhere?old=1#frag", "/host", &[]).unwrap(),
        "wss://relay.example/host"
    );
    assert_eq!(
        relay_address(
            "ws://127.0.0.1:9000/",
            "/join",
            &[("ticket", "ab"), ("hostId", "CD")]
        )
        .unwrap(),
        "ws://127.0.0.1:9000/join?ticket=ab&hostId=CD"
    );
    // Only a WebSocket address is a relay.
    assert!(relay_address("https://relay.example", "/host", &[]).is_err());
    assert!(relay_address("not a url", "/host", &[]).is_err());
}

/// One local relay socket: the accepted connection, read from the test's side.
fn serve_once(
    listener: TcpListener,
) -> mpsc::Receiver<tungstenite::WebSocket<std::net::TcpStream>> {
    let (ready, accepted) = mpsc::channel();
    std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let socket = tungstenite::accept(stream).unwrap();
        ready.send(socket).unwrap();
    });
    accepted
}

#[test]
fn a_dial_carries_binary_frames_both_ways_and_reports_a_close() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("ws://{}/host", listener.local_addr().unwrap());
    let server = serve_once(listener);

    let mut link = Link::dial(&address, &[], None, timeouts()).unwrap();
    link.send(b"hello relay").unwrap();
    let mut socket = server.recv().unwrap();
    assert_eq!(
        socket.read().unwrap(),
        Message::Binary(tungstenite::Bytes::from_static(b"hello relay"))
    );

    socket
        .send(Message::Binary(tungstenite::Bytes::from_static(b"welcome")))
        .unwrap();
    assert_eq!(link.read().unwrap(), Incoming::Data(b"welcome".to_vec()));

    // Nothing read before the read timeout passes: the caller pings instead of blocking forever.
    assert_eq!(link.read().unwrap(), Incoming::Idle);

    socket.send(Message::Close(None)).unwrap();
    match link.read().unwrap() {
        Incoming::Closed { code, .. } => assert_eq!(code, 1005),
        other => panic!("expected a close, got {other:?}"),
    }
}

#[test]
fn a_text_frame_is_refused_because_every_relay_frame_is_binary() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("ws://{}/join", listener.local_addr().unwrap());
    let server = serve_once(listener);
    let mut link = Link::dial(&address, &[], None, timeouts()).unwrap();
    let mut socket = server.recv().unwrap();
    socket.send(Message::Text("not binary".into())).unwrap();
    assert!(link.read().is_err());
}

#[test]
#[allow(clippy::result_large_err)] // tungstenite's own `ErrorResponse` shape
fn the_upgrade_carries_the_subprotocol_and_this_apps_name() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("ws://{}/host", listener.local_addr().unwrap());
    let (seen, observed) = mpsc::channel();
    std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let accepted = tungstenite::accept_hdr(
            stream,
            |request: &tungstenite::handshake::server::Request,
             mut response: tungstenite::handshake::server::Response| {
                let header = |name: &str| {
                    request
                        .headers()
                        .get(name)
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or_default()
                        .to_owned()
                };
                seen.send((header("sec-websocket-protocol"), header("x-ace-client")))
                    .unwrap();
                // The client requires the server to name the subprotocol it accepted.
                if let Ok(protocol) = "ace-grant.v1".parse() {
                    response
                        .headers_mut()
                        .insert("sec-websocket-protocol", protocol);
                }
                Ok(response)
            },
        );
        assert!(accepted.is_ok());
    });
    let mut link = Link::dial(
        &address,
        &["ace-grant.v1".to_owned()],
        Some("ace test"),
        timeouts(),
    )
    .unwrap();
    assert_eq!(
        observed.recv_timeout(Duration::from_secs(2)).unwrap(),
        ("ace-grant.v1".to_owned(), "ace test".to_owned())
    );
    let _ = link.ping();
}

// SPDX-License-Identifier: Apache-2.0
//! The handshake's decision table: every refusal's exact bytes as `ws` writes
//! them, the accepted `101`, the header view, and the raw handler on a real
//! loopback connection.

use super::handshake::{Refusal, handshake, version_13_or_8};
use super::*;

use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::BodyExt;
use tokio::io::AsyncReadExt;
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

use crate::driver::{Grace, UpgradeIo};
use crate::head::{self, Parsed};
use crate::peer::Peer;
use crate::prefixed::{Prefixed, WRITE_TIMEOUT};

const KEY: &str = "dGhlIHNhbXBsZSBub25jZQ==";
const ACCEPT: &str = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";

fn head(raw: &str) -> RequestHead {
    match head::parse(raw.as_bytes()) {
        Parsed::Head(head, _) => head,
        other => panic!("expected a request head, got {other:?}"),
    }
}

/// A candidate head with the fields given, in order.
fn request(method: &str, fields: &[(&str, &str)]) -> RequestHead {
    let mut raw = format!("{method} / HTTP/1.1\r\nHost: localhost\r\n");
    for (name, value) in fields {
        raw.push_str(&format!("{name}: {value}\r\n"));
    }
    raw.push_str("\r\n");
    head(&raw)
}

fn candidate() -> Vec<(&'static str, &'static str)> {
    vec![
        ("Upgrade", "websocket"),
        ("Connection", "Upgrade"),
        ("Sec-WebSocket-Key", KEY),
        ("Sec-WebSocket-Version", "13"),
    ]
}

fn with(
    fields: &[(&'static str, &'static str)],
    name: &str,
    value: &'static str,
) -> Vec<(&'static str, &'static str)> {
    fields
        .iter()
        .map(|&(field, field_value)| {
            (
                field,
                if field.eq_ignore_ascii_case(name) {
                    value
                } else {
                    field_value
                },
            )
        })
        .collect()
}

fn refusal(fields: &[(&'static str, &'static str)]) -> Vec<u8> {
    match handshake(&request("GET", fields)) {
        Err(refusal) => refusal.bytes(),
        Ok(_) => panic!("expected a refusal for {fields:?}"),
    }
}

#[test]
fn every_refusal_is_exactly_abort_handshakes_bytes() {
    const METHOD: &[u8] = b"HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Type: text/html\r\nContent-Length: 19\r\n\r\nInvalid HTTP method";
    assert_eq!(
        match handshake(&request("POST", &candidate())) {
            Err(refusal) => refusal.bytes(),
            Ok(_) => panic!("expected a refusal"),
        },
        METHOD
    );

    const UPGRADE: &[u8] = b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: text/html\r\nContent-Length: 22\r\n\r\nInvalid Upgrade header";
    assert_eq!(refusal(&with(&candidate(), "Upgrade", "h2c")), UPGRADE);

    const KEY: &[u8] = b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: text/html\r\nContent-Length: 43\r\n\r\nMissing or invalid Sec-WebSocket-Key header";
    let without_key: Vec<_> = candidate()
        .into_iter()
        .filter(|(name, _)| *name != "Sec-WebSocket-Key")
        .collect();
    assert_eq!(refusal(&without_key), KEY);
    assert_eq!(
        refusal(&with(&candidate(), "Sec-WebSocket-Key", "short==")),
        KEY
    );

    const VERSION: &[u8] = b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: text/html\r\nContent-Length: 47\r\nSec-WebSocket-Version: 13, 8\r\n\r\nMissing or invalid Sec-WebSocket-Version header";
    for spelled in ["9", "+0xd", "13abc"] {
        assert_eq!(
            refusal(&with(&candidate(), "Sec-WebSocket-Version", spelled)),
            VERSION,
            "{spelled:?}"
        );
    }

    const PROTOCOL: &[u8] = b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: text/html\r\nContent-Length: 37\r\n\r\nInvalid Sec-WebSocket-Protocol header";
    for offered in ["a b", "a,a", ""] {
        let mut fields = candidate();
        fields.push(("Sec-WebSocket-Protocol", offered));
        assert_eq!(refusal(&fields), PROTOCOL, "{offered:?}");
    }

    const CLOSING: &[u8] = b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Type: text/html\r\nContent-Length: 19\r\n\r\nService Unavailable";
    assert_eq!(Refusal::CLOSING.bytes(), CLOSING);

    const UPGRADE_VERSION: &[u8] = b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: text/html\r\nContent-Length: 25\r\n\r\nUpgrade requires HTTP/1.1";
    assert_eq!(Refusal::UPGRADE_VERSION.bytes(), UPGRADE_VERSION);
}

#[test]
fn an_accepted_handshake_is_exactly_complete_upgrades_bytes() {
    let accepted = handshake(&request("GET", &candidate())).expect("a valid handshake");
    let expected = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {ACCEPT}\r\n\r\n"
    );
    assert_eq!(accepted.bytes(), expected.as_bytes());
    // `+value` equals 8 or 13: Number() accepts these spellings and no sign.
    for version in ["0xd", " 13 ", "13.0", "1.3e1"] {
        let accepted = handshake(&request(
            "GET",
            &with(&candidate(), "Sec-WebSocket-Version", version),
        ))
        .expect("a valid version");
        assert_eq!(accepted.bytes(), expected.as_bytes(), "{version:?}");
    }

    let mut offered = candidate();
    offered.push(("Sec-WebSocket-Protocol", "chat, superchat"));
    let accepted = handshake(&request("GET", &offered)).expect("a valid handshake");
    let expected = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {ACCEPT}\r\nSec-WebSocket-Protocol: chat\r\n\r\n"
    );
    assert_eq!(accepted.bytes(), expected.as_bytes());
}

#[test]
fn the_version_header_is_read_like_ws_numeric_coercion() {
    for accepted in [
        "13", "8", " 13 ", "+13", "13.0", "1.3e1", "0xd", "0o15", "013",
    ] {
        assert!(
            version_13_or_8(accepted.as_bytes()),
            "{accepted:?} is 13 or 8"
        );
    }
    for refused in ["", "9", "13, 8", "13abc", "Infinity", "0x", "+0xd", "-0xd"] {
        assert!(
            !version_13_or_8(refused.as_bytes()),
            "{refused:?} is neither"
        );
    }
}

#[test]
fn the_request_keeps_the_raw_target_and_node_header_values() {
    let head = head(
        "GET //?x HTTP/1.1\r\nOrigin: http://a\r\nOrigin: http://b\r\nUser-Agent: one\r\nUser-Agent: two\r\n\r\n",
    );
    let peer = Peer {
        remote: "127.0.0.1:1".parse::<SocketAddr>().expect("an address"),
        local: "127.0.0.1:2".parse::<SocketAddr>().expect("an address"),
    };
    let request = UpgradeRequest::from_head(&head, peer);
    assert_eq!(request.target, "//?x");
    assert_eq!(request.origin.as_deref(), Some("http://a, http://b"));
    // Node keeps only the first of a duplicated User-Agent.
    assert_eq!(request.user_agent.as_deref(), Some("one"));
}

struct StubAdmission {
    outcome: StdMutex<Option<AdmissionOutcome>>,
    requests: StdMutex<Vec<UpgradeRequest>>,
    writing: StdMutex<Vec<u64>>,
    released: StdMutex<Vec<u64>>,
}

impl StubAdmission {
    fn new(outcome: AdmissionOutcome) -> Self {
        Self {
            outcome: StdMutex::new(Some(outcome)),
            requests: StdMutex::new(Vec::new()),
            writing: StdMutex::new(Vec::new()),
            released: StdMutex::new(Vec::new()),
        }
    }

    /// A decision that never arrives, as a client that went away finds it.
    fn never() -> Self {
        Self {
            outcome: StdMutex::new(None),
            requests: StdMutex::new(Vec::new()),
            writing: StdMutex::new(Vec::new()),
            released: StdMutex::new(Vec::new()),
        }
    }
}

impl UpgradeAdmission for StubAdmission {
    fn admit(
        &self,
        request: UpgradeRequest,
    ) -> Pin<Box<dyn Future<Output = AdmissionOutcome> + Send>> {
        self.requests.lock().expect("the stub's lock").push(request);
        match self.outcome.lock().expect("the stub's lock").take() {
            Some(outcome) => Box::pin(async move { outcome }),
            None => Box::pin(std::future::pending()),
        }
    }

    fn writing(&self, reservation: u64) -> bool {
        self.writing
            .lock()
            .expect("the stub's lock")
            .push(reservation);
        true
    }

    fn release(&self, reservation: u64) {
        self.released
            .lock()
            .expect("the stub's lock")
            .push(reservation);
    }
}

#[derive(Default)]
struct RecordingSink(StdMutex<Vec<(u64, Option<String>)>>);

impl SocketSink for RecordingSink {
    fn opened(&self, reservation: u64, stream: Box<dyn UpgradeIo>, user_agent: Option<String>) {
        drop(stream);
        self.0
            .lock()
            .expect("the sink's lock")
            .push((reservation, user_agent));
    }
}

/// Run one raw upgrade on a real loopback connection and read what it wrote.
async fn raw(
    request: &str,
    outcome: AdmissionOutcome,
    closing: bool,
) -> (Vec<u8>, Vec<u64>, Vec<u64>, Vec<(u64, Option<String>)>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a listener");
    let address = listener.local_addr().expect("the listener's address");
    let mut client = TcpStream::connect(address).await.expect("a client");
    let (server, _) = listener.accept().await.expect("the connection");
    let peer = Peer::of(&server).expect("the socket's addresses");
    let admission = Arc::new(StubAdmission::new(outcome));
    let sink = Arc::new(RecordingSink::default());
    let upgrades = WebSocketUpgrades::new(admission.clone(), sink.clone());
    let shutdown = CancellationToken::new();
    if closing {
        shutdown.cancel();
    }
    upgrades
        .upgrade_raw(
            head(request),
            Prefixed::new(Bytes::new(), server, WRITE_TIMEOUT),
            peer,
            shutdown,
            Grace::new(),
        )
        .await;
    let mut written = Vec::new();
    client.read_to_end(&mut written).await.expect("the answer");
    let writing = admission.writing.lock().expect("the stub's lock").clone();
    let released = admission.released.lock().expect("the stub's lock").clone();
    let opened = sink.0.lock().expect("the sink's lock").clone();
    (written, writing, released, opened)
}

fn valid(method: &str) -> String {
    format!(
        "{method} / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {KEY}\r\nSec-WebSocket-Version: 13\r\nUser-Agent: probe\r\n\r\n"
    )
}

#[tokio::test]
async fn a_raw_upgrade_answers_in_ws_bytes_and_releases_only_on_refusal() {
    let accept = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {ACCEPT}\r\n\r\n"
    );

    let accepted = AdmissionOutcome::Decided(AdmissionDecision::Accept { reservation: 7 });
    let (written, writing, released, opened) = raw(&valid("GET"), accepted, false).await;
    assert_eq!(written, accept.as_bytes());
    assert_eq!(writing, vec![7], "the 101 is written past every deadline");
    assert!(released.is_empty());
    assert_eq!(opened, vec![(7, Some("probe".to_owned()))]);

    let (written, _, _, opened) = raw(
        &valid("GET"),
        AdmissionOutcome::Decided(AdmissionDecision::Drop),
        false,
    )
    .await;
    assert!(written.is_empty(), "a drop writes nothing");
    assert!(opened.is_empty());

    let (written, _, released, _) = raw(
        &valid("GET"),
        AdmissionOutcome::Decided(AdmissionDecision::Forbidden),
        false,
    )
    .await;
    assert_eq!(written, FORBIDDEN);
    assert!(released.is_empty(), "nothing was reserved");

    for outcome in [
        AdmissionOutcome::Decided(AdmissionDecision::Unavailable),
        AdmissionOutcome::TimedOut,
    ] {
        let (written, _, released, _) = raw(&valid("GET"), outcome, false).await;
        assert_eq!(written, UNAVAILABLE);
        assert!(released.is_empty());
    }

    let (written, _, released, _) = raw(
        &valid("GET"),
        AdmissionOutcome::Decided(AdmissionDecision::Closing),
        false,
    )
    .await;
    assert_eq!(
        written,
        Refusal::CLOSING.bytes(),
        "a draining listener answers ws's closing 503, not admission's"
    );
    assert!(released.is_empty(), "a closing refusal reserves nothing");

    let (written, writing, released, opened) = raw(&valid("POST"), accepted, false).await;
    assert_eq!(written, Refusal::INVALID_METHOD.bytes());
    assert!(
        writing.is_empty(),
        "a failed check never reaches the 101, so nothing is writing"
    );
    assert_eq!(released, vec![7]);
    assert!(opened.is_empty());

    let missing_key = "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n";
    let (written, writing, released, opened) = raw(missing_key, accepted, false).await;
    assert_eq!(written, Refusal::INVALID_KEY.bytes());
    assert!(writing.is_empty());
    assert_eq!(released, vec![7]);
    assert!(opened.is_empty());

    let (written, writing, released, opened) = raw(&valid("GET"), accepted, true).await;
    assert_eq!(written, Refusal::CLOSING.bytes());
    assert!(writing.is_empty(), "a closing listener writes no 101");
    assert_eq!(released, vec![7]);
    assert!(opened.is_empty());
}

#[tokio::test]
async fn an_http_1_0_upgrade_is_refused_before_admission() {
    let admission = Arc::new(StubAdmission::new(AdmissionOutcome::Decided(
        AdmissionDecision::Accept { reservation: 7 },
    )));
    let sink = Arc::new(RecordingSink::default());
    let upgrades = WebSocketUpgrades::new(admission.clone(), sink.clone());
    let peer = Peer {
        remote: "127.0.0.1:1".parse::<SocketAddr>().expect("an address"),
        local: "127.0.0.1:2".parse::<SocketAddr>().expect("an address"),
    };
    let http_1_0 = valid("GET").replace("HTTP/1.1", "HTTP/1.0");
    let reply = upgrades
        .upgrade_hyper(
            head(&http_1_0),
            peer,
            CancellationToken::new(),
            Grace::new(),
        )
        .await;

    let UpgradeReply::Refuse(response) = reply else {
        panic!("an HTTP/1.0 upgrade is never switched");
    };
    assert_eq!(response.status(), http::StatusCode::BAD_REQUEST);
    assert_eq!(
        response.headers().get(http::header::CONNECTION),
        Some(&http::HeaderValue::from_static("close"))
    );
    assert_eq!(
        response
            .into_body()
            .collect()
            .await
            .expect("the body")
            .to_bytes(),
        Bytes::from_static(b"Upgrade requires HTTP/1.1")
    );
    assert!(
        admission
            .requests
            .lock()
            .expect("the stub's lock")
            .is_empty(),
        "the refusal comes before admission is asked"
    );
    assert!(sink.0.lock().expect("the sink's lock").is_empty());
}

#[tokio::test]
async fn a_client_with_bytes_waiting_is_not_mistaken_for_one_that_left() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a listener");
    let address = listener.local_addr().expect("the listener's address");
    let mut client = TcpStream::connect(address).await.expect("a client");
    let (server, _) = listener.accept().await.expect("the connection");
    let peer = Peer::of(&server).expect("the socket's addresses");
    let admission = Arc::new(StubAdmission::never());
    let sink = Arc::new(RecordingSink::default());
    let upgrades = WebSocketUpgrades::new(admission.clone(), sink.clone());

    let upgrade = upgrades.upgrade_raw(
        head(&valid("GET")),
        Prefixed::new(Bytes::new(), server, WRITE_TIMEOUT),
        peer,
        CancellationToken::new(),
        Grace::new(),
    );
    tokio::pin!(upgrade);
    // Bytes the client sent before its `101`: a client that is there, not gone.
    client
        .write_all(b"x")
        .await
        .expect("the client sends a byte");
    assert!(
        tokio::time::timeout(Duration::from_millis(150), &mut upgrade)
            .await
            .is_err(),
        "a client with bytes waiting is waited for, not abandoned"
    );
    assert!(
        admission
            .released
            .lock()
            .expect("the stub's lock")
            .is_empty(),
        "nothing was reserved, so nothing is released"
    );
    assert!(sink.0.lock().expect("the sink's lock").is_empty());
}

#[tokio::test]
async fn a_client_that_leaves_while_its_decision_is_pending_is_abandoned() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a listener");
    let address = listener.local_addr().expect("the listener's address");
    let client = TcpStream::connect(address).await.expect("a client");
    let (server, _) = listener.accept().await.expect("the connection");
    let peer = Peer::of(&server).expect("the socket's addresses");
    let admission = Arc::new(StubAdmission::never());
    let sink = Arc::new(RecordingSink::default());
    let upgrades = WebSocketUpgrades::new(admission.clone(), sink.clone());

    let upgrade = upgrades.upgrade_raw(
        head(&valid("GET")),
        Prefixed::new(Bytes::new(), server, WRITE_TIMEOUT),
        peer,
        CancellationToken::new(),
        Grace::new(),
    );
    tokio::pin!(upgrade);
    tokio::time::sleep(Duration::from_millis(50)).await;
    drop(client);

    tokio::time::timeout(Duration::from_secs(2), upgrade)
        .await
        .expect("a gone client ends the wait for its decision");
    assert_eq!(
        admission.requests.lock().expect("the stub's lock").len(),
        1,
        "the decision was asked for"
    );
    assert!(
        admission
            .released
            .lock()
            .expect("the stub's lock")
            .is_empty(),
        "nothing was reserved, so nothing is released"
    );
    assert!(sink.0.lock().expect("the sink's lock").is_empty());
}

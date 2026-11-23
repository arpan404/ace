// SPDX-License-Identifier: Apache-2.0
//! Behaviour tests for local daemon discovery, HTTP `/v1/*`, and WebSocket request/reply.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::Duration;

use cli_wire::{
    CliErrorCode, ConnectConfig, Connection, Home, HttpMethod, Local, LocalOrigin, Probe,
    ProbeAnswer, TcpProbe, Token, WireError, http_request_local, reach_local,
};
use serde::{Deserialize, Serialize};
use tungstenite::Message;
use tungstenite::protocol::CloseFrame;
use tungstenite::protocol::frame::coding::CloseCode;

const TEST_TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

struct TempHome(PathBuf);

impl TempHome {
    fn new() -> Self {
        let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("cli-wire-beh-{}-{seq}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn home(&self) -> Home {
        Home::new(self.0.clone())
    }

    fn write_connection(&self, endpoint: &str, token: &str) {
        fs::write(self.0.join("daemon-endpoint"), endpoint).unwrap();
        fs::write(self.0.join("daemon-token"), token).unwrap();
    }
}

impl Drop for TempHome {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct StubProbe(ProbeAnswer);

impl Probe for StubProbe {
    fn probe(&self, _host: &str, _port: u16, _timeout: Duration) -> ProbeAnswer {
        self.0
    }
}

fn local_for(addr: SocketAddr) -> Local {
    let origin = LocalOrigin::parse(&format!("http://127.0.0.1:{}/", addr.port())).unwrap();
    let token = Token::parse(TEST_TOKEN).unwrap();
    Local::new(origin, token)
}

fn spawn_ws_server<F>(handler: F) -> (SocketAddr, thread::JoinHandle<()>)
where
    F: FnOnce(tungstenite::WebSocket<std::net::TcpStream>) + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let ws = tungstenite::accept(stream).unwrap();
        handler(ws);
    });
    (addr, handle)
}

fn read_text(ws: &mut tungstenite::WebSocket<std::net::TcpStream>) -> String {
    loop {
        match ws.read().unwrap() {
            Message::Text(text) => return text.to_string(),
            Message::Pong(_) => {}
            other => unreachable!("unexpected frame: {other:?}"),
        }
    }
}

#[test]
fn daemon_down_vs_up_vs_slow_exits_4_only_when_refused() {
    // Missing files -> daemon_down (exit 4).
    let missing = TempHome::new();
    let err = reach_local(&missing.home(), &StubProbe(ProbeAnswer::Up)).unwrap_err();
    assert!(matches!(err, WireError::DaemonDown));
    assert_eq!(err.exit_code(), 4);
    assert_eq!(err.failure().code, CliErrorCode::DaemonDown);

    // Closed port (refused) -> real TcpProbe reports down -> daemon_down (exit 4).
    let closed_listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let closed_addr = closed_listener.local_addr().unwrap();
    drop(closed_listener);

    let dir = TempHome::new();
    dir.write_connection(
        &format!("http://127.0.0.1:{}/", closed_addr.port()),
        TEST_TOKEN,
    );
    let err_down = reach_local(&dir.home(), &TcpProbe).unwrap_err();
    assert!(matches!(err_down, WireError::DaemonDown));
    assert_eq!(err_down.exit_code(), 4);

    // Direct WS connect to refused port also maps to daemon_down (exit 4).
    let err_ws = Connection::open_local(&local_for(closed_addr), &ConnectConfig::default())
        .err()
        .unwrap();
    assert!(matches!(err_ws, WireError::DaemonDown));
    assert_eq!(err_ws.exit_code(), 4);

    // Slow / ambiguous probe (ProbeAnswer::Unknown) must NOT report daemon_down.
    let slow_local = reach_local(&dir.home(), &StubProbe(ProbeAnswer::Unknown)).unwrap();
    assert_eq!(slow_local.origin().port(), closed_addr.port());

    // Listening daemon -> real TcpProbe reports up.
    let open_listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let open_addr = open_listener.local_addr().unwrap();
    dir.write_connection(
        &format!("http://127.0.0.1:{}/", open_addr.port()),
        TEST_TOKEN,
    );
    let up_local = reach_local(&dir.home(), &TcpProbe).unwrap();
    assert_eq!(up_local.origin().port(), open_addr.port());
    drop(open_listener);
}

#[test]
fn request_reply_round_trip_keeps_unknown_fields() {
    #[derive(Serialize)]
    struct ListOp {
        #[serde(rename = "type")]
        msg_type: &'static str,
    }

    #[derive(Deserialize)]
    struct BorrowedReply<'a> {
        ok: bool,
        label: &'a str,
    }

    // WebSocket handshake + request/reply with unknown fields in both welcome and reply.
    let (ws_addr, ws_server) = spawn_ws_server(|mut ws| {
        let hello: serde_json::Value = serde_json::from_str(&read_text(&mut ws)).unwrap();
        assert_eq!(hello["type"], "hello");
        assert_eq!(hello["token"], TEST_TOKEN);
        ws.send(Message::Text(
            r#"{"type":"welcome","hostId":"host-1","protocolVersion":1,"headSeq":7,"futureWelcome":true}"#.into(),
        ))
        .unwrap();

        let req: serde_json::Value = serde_json::from_str(&read_text(&mut ws)).unwrap();
        let id = req["requestId"].as_str().unwrap();
        ws.send(Message::Text(
            format!(
                r#"{{"type":"threads.list.ok","requestId":"{id}","ok":true,"label":"inbox","unknownFuture":[1,2,3]}}"#
            )
            .into(),
        ))
        .unwrap();
    });

    let mut conn = Connection::open_local(&local_for(ws_addr), &ConnectConfig::default()).unwrap();
    let reply = conn
        .request(&ListOp {
            msg_type: "threads.list",
        })
        .unwrap();
    assert!(reply.as_str().contains(r#""unknownFuture":[1,2,3]"#));
    let decoded: BorrowedReply<'_> = reply.decode().unwrap();
    assert!(decoded.ok);
    assert_eq!(decoded.label, "inbox");
    conn.close();
    ws_server.join().unwrap();

    // HTTP /v1/status preserves unknown fields verbatim in RawValue and decodes known fields.
    let http_listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let http_addr = http_listener.local_addr().unwrap();
    let http_server = thread::spawn(move || {
        let (mut stream, _) = http_listener.accept().unwrap();
        let mut req_buf = [0_u8; 2048];
        let _ = stream.read(&mut req_buf).unwrap();
        let body = r#"{"ok":true,"label":"status","futureField":42}"#;
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(resp.as_bytes()).unwrap();
    });

    let http_reply = http_request_local(
        &local_for(http_addr),
        HttpMethod::Get,
        "/v1/status",
        None,
        Duration::from_secs(2),
    )
    .unwrap();
    assert!(http_reply.as_str().contains(r#""futureField":42"#));
    let http_decoded: BorrowedReply<'_> = http_reply.decode().unwrap();
    assert!(http_decoded.ok);
    assert_eq!(http_decoded.label, "status");
    http_server.join().unwrap();
}

#[test]
fn auth_failure_exits_4() {
    // WebSocket close code 4001 -> Auth (exit 4).
    let (ws_addr, ws_server) = spawn_ws_server(|mut ws| {
        let _ = read_text(&mut ws);
        ws.close(Some(CloseFrame {
            code: CloseCode::from(4001),
            reason: "Unauthorized".into(),
        }))
        .unwrap();
    });
    let ws_err = Connection::open_local(&local_for(ws_addr), &ConnectConfig::default())
        .err()
        .unwrap();
    assert!(matches!(ws_err, WireError::Auth { .. }));
    assert_eq!(ws_err.exit_code(), 4);
    ws_server.join().unwrap();

    // HTTP 401 -> Auth (exit 4).
    let http_listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let http_addr = http_listener.local_addr().unwrap();
    let http_server = thread::spawn(move || {
        let (mut stream, _) = http_listener.accept().unwrap();
        let mut buf = [0_u8; 1024];
        let _ = stream.read(&mut buf);
        let body = r#"{"error":"Unauthorized"}"#;
        let resp = format!(
            "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(resp.as_bytes()).unwrap();
    });
    let http_err = http_request_local(
        &local_for(http_addr),
        HttpMethod::Get,
        "/v1/status",
        None,
        Duration::from_secs(2),
    )
    .unwrap_err();
    assert!(matches!(http_err, WireError::Auth { .. }));
    assert_eq!(http_err.exit_code(), 4);
    http_server.join().unwrap();
}

#[test]
fn timeout_exits_3() {
    // Stalled WS request -> Timeout (exit 3).
    let (ws_addr, ws_server) = spawn_ws_server(|mut ws| {
        let _ = read_text(&mut ws);
        ws.send(Message::Text(
            r#"{"type":"welcome","hostId":"host-1","protocolVersion":1,"headSeq":1}"#.into(),
        ))
        .unwrap();
        let _ = read_text(&mut ws);
        thread::sleep(Duration::from_millis(250));
    });
    let mut conn = Connection::open_local(&local_for(ws_addr), &ConnectConfig::default()).unwrap();
    let ws_err = conn
        .request_raw(r#"{"type":"threads.list"}"#, Duration::from_millis(60))
        .err()
        .unwrap();
    assert!(matches!(ws_err, WireError::Timeout { .. }));
    assert_eq!(ws_err.exit_code(), 3);
    conn.close();
    ws_server.join().unwrap();

    // Stalled HTTP response -> Timeout (exit 3).
    let http_listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let http_addr = http_listener.local_addr().unwrap();
    let http_server = thread::spawn(move || {
        let (_stream, _) = http_listener.accept().unwrap();
        thread::sleep(Duration::from_millis(250));
    });
    let http_err = http_request_local(
        &local_for(http_addr),
        HttpMethod::Get,
        "/v1/status",
        None,
        Duration::from_millis(60),
    )
    .unwrap_err();
    assert!(matches!(http_err, WireError::Timeout { .. }));
    assert_eq!(http_err.exit_code(), 3);
    http_server.join().unwrap();
}

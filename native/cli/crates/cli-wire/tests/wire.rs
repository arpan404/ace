// SPDX-License-Identifier: Apache-2.0
//! Behaviour tests for local daemon discovery, HTTP `/v1/*`, and WebSocket request/reply.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use cli_wire::{
    CliErrorCode, ConnectConfig, Connection, Home, HostFilesError, HttpMethod, Local,
    LocalIdentity, LocalOrigin, Probe, ProbeAnswer, TcpProbe, Token, WireError, http_request_local,
    parse_host_files, reach_local, read_host_files,
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
        &format!("http://127.0.0.1:{}/\n", closed_addr.port()),
        TEST_TOKEN,
    );
    let err_down = reach_local(&dir.home(), &TcpProbe).unwrap_err();
    assert!(matches!(err_down, WireError::DaemonDown));
    assert_eq!(err_down.exit_code(), 4);

    // Direct WS connect to refused port also maps to daemon_down (exit 4).
    let err_ws = Connection::open_local(
        &local_for(closed_addr),
        LocalIdentity::Person,
        &ConnectConfig::default(),
    )
    .err()
    .unwrap();
    assert!(matches!(err_ws, WireError::DaemonDown));
    assert_eq!(err_ws.exit_code(), 4);

    // Slow / ambiguous probe (ProbeAnswer::Unknown) must NOT report daemon_down.
    let slow_local = reach_local(&dir.home(), &StubProbe(ProbeAnswer::Unknown)).unwrap();
    assert_eq!(slow_local.origin().port(), closed_addr.port());

    // Listening daemon with trailing newline in daemon-endpoint -> real TcpProbe reports up.
    let open_listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let open_addr = open_listener.local_addr().unwrap();
    dir.write_connection(
        &format!("http://127.0.0.1:{}/\n", open_addr.port()),
        TEST_TOKEN,
    );
    let up_local = reach_local(&dir.home(), &TcpProbe).unwrap();
    assert_eq!(up_local.origin().port(), open_addr.port());
    drop(open_listener);
}

#[test]
fn request_reply_round_trip_keeps_unknown_fields_and_reassembles_parts() {
    #[derive(Serialize)]
    struct CliOp {
        kind: &'static str,
    }

    #[derive(Deserialize)]
    struct BorrowedReply<'a> {
        ok: bool,
        label: &'a str,
    }

    // Agent shell environment selects ace-agent; plain shell selects ace-cli.
    assert_eq!(LocalIdentity::from_vars(None, None), LocalIdentity::Person);
    let agent_id = LocalIdentity::from_vars(Some("thread-42"), None);
    assert_eq!(agent_id, LocalIdentity::Agent);

    let (ws_addr, ws_server) = spawn_ws_server(|mut ws| {
        let hello: serde_json::Value = serde_json::from_str(&read_text(&mut ws)).unwrap();
        assert_eq!(hello["type"], "hello");
        assert_eq!(hello["token"], TEST_TOKEN);
        assert_eq!(hello["deviceId"], "ace-agent");
        ws.send(Message::Text(
            r#"{"type":"welcome","hostId":"host-1","protocolVersion":1,"headSeq":7,"futureWelcome":true}"#.into(),
        ))
        .unwrap();

        // 1) cli.request: wrong message types with the same requestId must be ignored until cli.result.
        let req1: serde_json::Value = serde_json::from_str(&read_text(&mut ws)).unwrap();
        assert_eq!(req1["type"], "cli.request");
        let id1 = req1["requestId"].as_str().unwrap();
        let packed = format!(
            concat!(
                r#"{{"type":"threads.patch","requestId":"{id}","ignored":true}}"#,
                "\n",
                r#"{{"type":"unexpected.reply","requestId":"{id}","ignored":true}}"#,
                "\n",
                r#"{{"type":"cli.result","requestId":"{id}","ok":true,"label":"inbox","unknownFuture":[1,2,3]}}"#,
            ),
            id = id1,
        );
        ws.send(Message::Text(packed.into())).unwrap();

        // 2) entities.page split into two entities.page.part fragments.
        let req2: serde_json::Value = serde_json::from_str(&read_text(&mut ws)).unwrap();
        let id2 = req2["requestId"].as_str().unwrap();
        let full_page = format!(
            r#"{{"type":"entities.page","requestId":"{id2}","page":{{"threadId":"t-1","collection":"messages","seq":9,"items":[1,2],"extraPage":true}}}}"#
        );
        let split_at = full_page.len() / 2;
        let part0 = serde_json::json!({
            "type": "entities.page.part",
            "requestId": id2,
            "threadId": "t-1",
            "seq": 9,
            "index": 0,
            "done": false,
            "data": &full_page[..split_at],
        });
        let part1 = serde_json::json!({
            "type": "entities.page.part",
            "requestId": id2,
            "threadId": "t-1",
            "seq": 9,
            "index": 1,
            "done": true,
            "data": &full_page[split_at..],
        });
        ws.send(Message::Text(part0.to_string().into())).unwrap();
        ws.send(Message::Text(part1.to_string().into())).unwrap();
    });

    let mut conn =
        Connection::open_local(&local_for(ws_addr), agent_id, &ConnectConfig::default()).unwrap();

    let reply = conn.cli_request(&CliOp { kind: "list" }).unwrap();
    assert_eq!(reply.msg_type(), "cli.result");
    assert!(reply.as_str().contains(r#""unknownFuture":[1,2,3]"#));
    let decoded: BorrowedReply<'_> = reply.decode().unwrap();
    assert!(decoded.ok);
    assert_eq!(decoded.label, "inbox");

    let page_reply = conn
        .request_raw(
            r#"{"type":"entities.page","threadId":"t-1","collection":"messages"}"#,
            Duration::from_secs(2),
        )
        .unwrap();
    assert_eq!(page_reply.msg_type(), "entities.page");
    assert!(page_reply.as_str().contains(r#""extraPage":true"#));
    assert!(page_reply.as_str().contains(r#""items":[1,2]"#));
    conn.close();
    ws_server.join().unwrap();

    assert_http_status_preserves_unknown_fields();
}

fn assert_http_status_preserves_unknown_fields() {
    #[derive(Deserialize)]
    struct BorrowedReply<'a> {
        ok: bool,
        label: &'a str,
    }

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
    let ws_err = Connection::open_local(
        &local_for(ws_addr),
        LocalIdentity::Person,
        &ConnectConfig::default(),
    )
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
fn timeouts_and_trickled_frames_match_ts_outcomes() {
    // Trickling partial WS frame bytes every 15 ms must still fail at the 80 ms absolute deadline.
    let (ws_addr, ws_server) = spawn_ws_server(|mut ws| {
        let _ = read_text(&mut ws);
        ws.send(Message::Text(
            r#"{"type":"welcome","hostId":"host-1","protocolVersion":1,"headSeq":1}"#.into(),
        ))
        .unwrap();
        let _ = read_text(&mut ws);
        // Write a valid RFC 6455 text frame header claiming 100 payload bytes, then trickle 1 byte
        // every 15 ms on the raw TCP stream so a naive relative SO_RCVTIMEO would never expire.
        let raw = ws.get_mut();
        let _ = raw.write_all(&[0x81, 100]);
        for _ in 0..20 {
            thread::sleep(Duration::from_millis(15));
            if raw.write_all(b"{").is_err() {
                break;
            }
        }
    });
    let mut conn = Connection::open_local(
        &local_for(ws_addr),
        LocalIdentity::Person,
        &ConnectConfig::default(),
    )
    .unwrap();
    let started = Instant::now();
    let ws_err = conn
        .request_raw(r#"{"type":"threads.list"}"#, Duration::from_millis(80))
        .err()
        .unwrap();
    let elapsed = started.elapsed();
    assert!(matches!(ws_err, WireError::Timeout { .. }));
    assert_eq!(ws_err.exit_code(), 3);
    assert!(
        elapsed < Duration::from_millis(250),
        "trickled bytes extended past absolute deadline: {elapsed:?}"
    );
    conn.close();
    ws_server.join().unwrap();

    // Stalled HTTP /v1/* response -> Offline (uncertain, exit 5), matching TS accessRequest.
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
    assert!(matches!(http_err, WireError::Offline { .. }));
    assert_eq!(http_err.exit_code(), 5);
    assert_eq!(http_err.failure().code, CliErrorCode::Uncertain);
    http_server.join().unwrap();
}

#[test]
fn corrupt_daemon_files_report_how_they_fail() {
    // Unparseable endpoint: the runtime's own `Invalid URL`, not daemon_down.
    assert_eq!(
        parse_host_files("garbage", TEST_TOKEN),
        Err(HostFilesError::InvalidUrl)
    );
    assert_eq!(
        parse_host_files("", TEST_TOKEN),
        Err(HostFilesError::InvalidUrl)
    );
    // Well-formed URL that is not this machine's daemon: a shape failure.
    assert_eq!(
        parse_host_files("http://example.com/", TEST_TOKEN),
        Err(HostFilesError::InvalidEndpoint)
    );
    // A malformed token: a shape failure, anchored at both ends exactly.
    assert_eq!(
        parse_host_files("http://127.0.0.1:1/", "garbage"),
        Err(HostFilesError::InvalidToken)
    );
    assert_eq!(
        parse_host_files("http://127.0.0.1:1/", &format!("{TEST_TOKEN}\n")),
        Err(HostFilesError::InvalidToken)
    );
    assert!(parse_host_files("http://127.0.0.1:1/", TEST_TOKEN).is_ok());

    // Missing files read as a stopped daemon, never a parse failure.
    let missing = TempHome::new();
    assert_eq!(
        read_host_files(&missing.home()),
        Err(HostFilesError::Unreadable(std::io::ErrorKind::NotFound))
    );
}

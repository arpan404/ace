// SPDX-License-Identifier: Apache-2.0
//! Local mock-daemon WebSocket tests for [`cli_wire::Connection`].
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::net::{SocketAddr, TcpListener};
use std::thread;
use std::time::Duration;

use cli_wire::{
    CliErrorCode, ConnectConfig, Connection, HostId, Local, LocalOrigin, Token, WireError,
};
use serde::{Deserialize, Serialize};
use tungstenite::Message;
use tungstenite::protocol::CloseFrame;
use tungstenite::protocol::frame::coding::CloseCode;

const TEST_TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn local_for(addr: SocketAddr) -> Local {
    let origin = LocalOrigin::parse(&format!("http://127.0.0.1:{}", addr.port())).unwrap();
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

#[derive(Serialize)]
struct ListThreadsOp<'a> {
    #[serde(rename = "type")]
    msg_type: &'static str,
    filter: &'a str,
}

#[derive(Serialize)]
struct CapsOp {
    op: &'static str,
}

#[derive(Deserialize)]
struct BorrowedReply<'a> {
    #[serde(rename = "type")]
    msg_type: &'a str,
    ok: bool,
    label: &'a str,
}

#[test]
fn handshake_and_sequential_requests_preserve_raw_json_and_ignore_unknown_fields() {
    let (addr, server) = spawn_ws_server(|mut ws| {
        let hello: serde_json::Value = serde_json::from_str(&read_text(&mut ws)).unwrap();
        assert_eq!(hello["type"], "hello");
        assert_eq!(hello["protocolVersion"], 1);
        assert_eq!(hello["deviceId"], "ace-cli");
        assert_eq!(hello["token"], TEST_TOKEN);

        ws.send(Message::Text(
            r#"{"type":"welcome","hostId":"host-1","protocolVersion":1,"headSeq":42,"databaseId":"db-9","futureField":{"nested":true}}"#.into(),
        ))
        .unwrap();

        let req1: serde_json::Value = serde_json::from_str(&read_text(&mut ws)).unwrap();
        assert_eq!(req1["type"], "threads.list");
        assert_eq!(req1["filter"], "active");
        let id1 = req1["requestId"].as_str().unwrap().to_owned();

        // Interleave WebSocket ping, unsolicited push, progress, and uncorrelated error before reply.
        ws.send(Message::Ping(vec![1, 2, 3].into())).unwrap();
        let pong = ws.read().unwrap();
        assert!(matches!(pong, Message::Pong(p) if p.as_ref() == [1, 2, 3]));

        ws.send(Message::Text(
            format!(
                "{{\"type\":\"event.push\",\"seq\":43}}\n{{\"type\":\"history.operation.progress\",\"requestId\":\"{id1}\",\"done\":1}}"
            )
            .into(),
        ))
        .unwrap();
        ws.send(Message::Text(
            r#"{"type":"error","code":"busy","message":"uncorrelated noise"}"#.into(),
        ))
        .unwrap();

        // Raw JSON with extra unknown fields and specific formatting to verify --json passthrough.
        ws.send(Message::Text(
            format!(
                r#"{{"type":"threads.list.ok","requestId":"{id1}","ok":true,"label":"inbox","unknownFuture":[1,2,3]}}"#
            )
            .into(),
        ))
        .unwrap();

        // Second request via cli_request helper.
        let req2: serde_json::Value = serde_json::from_str(&read_text(&mut ws)).unwrap();
        assert_eq!(req2["type"], "cli.request");
        assert_eq!(req2["operation"]["op"], "capabilities");
        let id2 = req2["requestId"].as_str().unwrap().to_owned();
        assert_ne!(id1, id2);
        ws.send(Message::Text(
            format!(r#"{{"type":"cli.response","requestId":"{id2}","ok":true,"label":"caps"}}"#)
                .into(),
        ))
        .unwrap();

        // Application ping/pong.
        let ping_msg: serde_json::Value = serde_json::from_str(&read_text(&mut ws)).unwrap();
        assert_eq!(ping_msg["type"], "ping");
        ws.send(Message::Text(r#"{"type":"pong"}"#.into())).unwrap();
    });

    let local = local_for(addr);
    let mut conn = Connection::open_local(&local, &ConnectConfig::default()).unwrap();
    assert_eq!(conn.welcome().host_id.as_str(), "host-1");
    assert_eq!(conn.welcome().head_seq, 42);
    assert_eq!(conn.welcome().database_id.as_deref(), Some("db-9"));

    let reply1 = conn
        .request(&ListThreadsOp {
            msg_type: "threads.list",
            filter: "active",
        })
        .unwrap();
    assert_eq!(reply1.msg_type(), "threads.list.ok");
    assert!(reply1.as_str().contains(r#""unknownFuture":[1,2,3]"#));
    let decoded: BorrowedReply<'_> = reply1.decode().unwrap();
    assert_eq!(decoded.msg_type, "threads.list.ok");
    assert!(decoded.ok);
    assert_eq!(decoded.label, "inbox");

    let reply2 = conn.cli_request(&CapsOp { op: "capabilities" }).unwrap();
    assert_eq!(reply2.msg_type(), "cli.response");
    let decoded2: BorrowedReply<'_> = reply2.decode().unwrap();
    assert_eq!(decoded2.label, "caps");

    conn.ping().unwrap();
    conn.close();
    server.join().unwrap();
}

#[test]
fn cold_start_starting_frame_extends_handshake_deadline() {
    let (addr, server) = spawn_ws_server(|mut ws| {
        let _ = read_text(&mut ws);
        ws.send(Message::Text(r#"{"type":"starting"}"#.into()))
            .unwrap();
        thread::sleep(Duration::from_millis(120));
        ws.send(Message::Text(
            r#"{"type":"welcome","hostId":"host-cold","protocolVersion":1,"headSeq":0}"#.into(),
        ))
        .unwrap();
    });

    let cfg = ConnectConfig {
        handshake_timeout: Duration::from_millis(80),
        cold_start_timeout: Duration::from_millis(600),
        ..ConnectConfig::default()
    };
    let conn = Connection::open_local(&local_for(addr), &cfg).unwrap();
    assert_eq!(conn.welcome().host_id.as_str(), "host-cold");
    conn.close();
    server.join().unwrap();
}

#[test]
fn unauthorized_error_and_close_codes_map_to_auth_and_machine_code() {
    // 1) Error frame with code "unauthorized"
    let (addr1, s1) = spawn_ws_server(|mut ws| {
        let _ = read_text(&mut ws);
        ws.send(Message::Text(
            r#"{"type":"error","code":"unauthorized","message":"Bad token"}"#.into(),
        ))
        .unwrap();
    });
    let err1 = Connection::open_local(&local_for(addr1), &ConnectConfig::default())
        .err()
        .unwrap();
    assert!(matches!(err1, WireError::Auth { revoked: false, .. }));
    assert_eq!(err1.exit_code(), 4);
    assert_eq!(err1.failure().code, CliErrorCode::Refused);
    assert_eq!(err1.cli_code(), "refused");
    s1.join().unwrap();

    // 2) Close code 4001
    let (addr2, s2) = spawn_ws_server(|mut ws| {
        let _ = read_text(&mut ws);
        ws.close(Some(CloseFrame {
            code: CloseCode::from(4001),
            reason: "Unauthorized".into(),
        }))
        .unwrap();
    });
    let err2 = Connection::open_local(&local_for(addr2), &ConnectConfig::default())
        .err()
        .unwrap();
    assert!(matches!(err2, WireError::Auth { revoked: false, .. }));
    assert_eq!(err2.exit_code(), 4);
    s2.join().unwrap();

    // 3) Close code 4003 Device revoked
    let (addr3, s3) = spawn_ws_server(|mut ws| {
        let _ = read_text(&mut ws);
        ws.close(Some(CloseFrame {
            code: CloseCode::from(4003),
            reason: "Device revoked".into(),
        }))
        .unwrap();
    });
    let err3 = Connection::open_local(&local_for(addr3), &ConnectConfig::default())
        .err()
        .unwrap();
    assert!(matches!(err3, WireError::Auth { revoked: true, .. }));
    assert_eq!(err3.exit_code(), 4);
    s3.join().unwrap();

    // 4) Close code 4011 Machine code required
    let (addr4, s4) = spawn_ws_server(|mut ws| {
        let _ = read_text(&mut ws);
        ws.close(Some(CloseFrame {
            code: CloseCode::from(4011),
            reason: "Machine code required".into(),
        }))
        .unwrap();
    });
    let err4 = Connection::open_local(&local_for(addr4), &ConnectConfig::default())
        .err()
        .unwrap();
    assert!(matches!(err4, WireError::MachineCode { .. }));
    assert_eq!(err4.exit_code(), 5);
    assert_eq!(err4.failure().code, CliErrorCode::Uncertain);
    s4.join().unwrap();
}

#[test]
fn refused_connection_maps_to_daemon_down() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);

    let err = Connection::open_local(&local_for(addr), &ConnectConfig::default())
        .err()
        .unwrap();
    assert!(matches!(err, WireError::DaemonDown));
    assert_eq!(err.exit_code(), 4);
    assert_eq!(err.failure().code, CliErrorCode::DaemonDown);
    assert_eq!(err.cli_code(), "daemon_down");
}

#[test]
fn handshake_and_request_timeouts_map_to_timeout_exit_3() {
    // Handshake stalls after hello.
    let (addr1, s1) = spawn_ws_server(|mut ws| {
        let _ = read_text(&mut ws);
        thread::sleep(Duration::from_millis(250));
    });
    let cfg = ConnectConfig {
        handshake_timeout: Duration::from_millis(60),
        ..ConnectConfig::default()
    };
    let err1 = Connection::open_local(&local_for(addr1), &cfg)
        .err()
        .unwrap();
    assert!(matches!(err1, WireError::Timeout { .. }));
    assert_eq!(err1.exit_code(), 3);
    s1.join().unwrap();

    // Request stalls after welcome.
    let (addr2, s2) = spawn_ws_server(|mut ws| {
        let _ = read_text(&mut ws);
        ws.send(Message::Text(
            r#"{"type":"welcome","hostId":"host-1","protocolVersion":1,"headSeq":1}"#.into(),
        ))
        .unwrap();
        let _ = read_text(&mut ws);
        thread::sleep(Duration::from_millis(250));
    });
    let mut conn = Connection::open_local(&local_for(addr2), &ConnectConfig::default()).unwrap();
    let err2 = conn
        .request_raw(r#"{"type":"threads.list"}"#, Duration::from_millis(60))
        .err()
        .unwrap();
    assert!(matches!(err2, WireError::Timeout { .. }));
    assert_eq!(err2.exit_code(), 3);
    conn.close();
    s2.join().unwrap();
}

#[test]
fn daemon_error_malformed_json_and_host_id_mismatch_map_correctly() {
    // Correlated daemon error and malformed JSON.
    let (addr1, s1) = spawn_ws_server(|mut ws| {
        let _ = read_text(&mut ws);
        ws.send(Message::Text(
            r#"{"type":"welcome","hostId":"host-1","protocolVersion":1,"headSeq":1}"#.into(),
        ))
        .unwrap();

        let req1: serde_json::Value = serde_json::from_str(&read_text(&mut ws)).unwrap();
        let id1 = req1["requestId"].as_str().unwrap();
        ws.send(Message::Text(
            format!(
                r#"{{"type":"error","requestId":"{id1}","code":"not_found","message":"Missing thread"}}"#
            )
            .into(),
        ))
        .unwrap();

        let _req2 = read_text(&mut ws);
        ws.send(Message::Text("not valid json {{{".into())).unwrap();
    });

    let mut conn = Connection::open_local(&local_for(addr1), &ConnectConfig::default()).unwrap();
    let err_daemon = conn
        .request_raw(r#"{"type":"thread.get"}"#, Duration::from_secs(2))
        .err()
        .unwrap();
    assert!(matches!(
        err_daemon,
        WireError::Daemon { ref code, ref message }
            if code == "not_found" && message == "Missing thread"
    ));
    assert_eq!(err_daemon.exit_code(), 5);

    let err_proto = conn
        .request_raw(r#"{"type":"thread.get"}"#, Duration::from_secs(2))
        .err()
        .unwrap();
    assert!(matches!(err_proto, WireError::Protocol { .. }));
    assert_eq!(err_proto.exit_code(), 5);
    conn.close();
    s1.join().unwrap();

    // Expected hostId mismatch -> WireError::Identity (exit 5).
    let (addr2, s2) = spawn_ws_server(|mut ws| {
        let _ = read_text(&mut ws);
        ws.send(Message::Text(
            r#"{"type":"welcome","hostId":"host-actual","protocolVersion":1,"headSeq":1}"#.into(),
        ))
        .unwrap();
    });
    let cfg = ConnectConfig {
        expected_host_id: Some(HostId::parse("host-expected").unwrap()),
        ..ConnectConfig::default()
    };
    let err_id = Connection::open_local(&local_for(addr2), &cfg)
        .err()
        .unwrap();
    assert!(matches!(err_id, WireError::Identity { .. }));
    assert_eq!(err_id.exit_code(), 5);
    s2.join().unwrap();
}

// SPDX-License-Identifier: Apache-2.0
//! The hello and authentication cases against the real daemon's socket:
//! `auth.server.process.test.ts`'s frames, sent to `ace-daemon` itself.

mod support;

use std::time::Duration;

use support::Home;

/// One exchange on the real daemon's socket: the frames it sent and its close code.
fn websocket(
    endpoint: &str,
    frames: &[tokio_tungstenite::tungstenite::Message],
) -> (Vec<serde_json::Value>, Option<u16>) {
    use futures_util::{SinkExt, StreamExt};

    let url = endpoint.replacen("http://", "ws://", 1);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build();
    let Ok(runtime) = runtime else {
        panic!("a runtime for the client");
    };
    runtime.block_on(async move {
        let connected = tokio::time::timeout(
            Duration::from_secs(5),
            tokio_tungstenite::connect_async(&url),
        )
        .await;
        let Ok(Ok((mut socket, _response))) = connected else {
            panic!("the daemon's socket accepts the handshake");
        };
        for frame in frames {
            let _ = socket.send(frame.clone()).await;
        }
        let mut messages = Vec::new();
        let mut close = None;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            match tokio::time::timeout_at(deadline, socket.next()).await {
                Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text)))) => {
                    if let Ok(value) = serde_json::from_str(&text) {
                        messages.push(value);
                    }
                }
                Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Close(frame)))) => {
                    close = frame.map(|frame| u16::from(frame.code));
                    break;
                }
                Ok(Some(Ok(_))) => {}
                Ok(Some(Err(_))) | Ok(None) | Err(_) => break,
            }
        }
        (messages, close)
    })
}

fn text_frame(body: &str) -> tokio_tungstenite::tungstenite::Message {
    tokio_tungstenite::tungstenite::Message::Text(body.into())
}

/// `auth.server.process.test.ts`: "closes without sending data for a non-hello
/// first frame", and the same for a token prefix, a bad version and a missing
/// token; and "rejects a binary first frame even when it contains a valid hello".
#[test]
fn a_hello_that_authenticates_nothing_is_refused_with_4001() {
    let home = Home::new("auth");
    let mut daemon = home.start(false);
    let endpoint = daemon.ready(&home);
    let token = home.token();
    let hello = format!(
        "{{\"type\":\"hello\",\"protocolVersion\":1,\"deviceId\":\"device\",\"token\":\"{token}\"}}"
    );
    let cases: Vec<(&str, tokio_tungstenite::tungstenite::Message)> = vec![
        ("non-hello first frame", text_frame("{\"type\":\"ping\"}")),
        (
            "token prefix followed by extra bytes",
            text_frame(&hello.replace(&format!("\"{token}\""), &format!("\"{token}suffix\""))),
        ),
        (
            "unsupported protocol version",
            text_frame(&hello.replace("\"protocolVersion\":1", "\"protocolVersion\":2")),
        ),
        (
            "missing token",
            text_frame("{\"type\":\"hello\",\"protocolVersion\":1,\"deviceId\":\"device\"}"),
        ),
        (
            "binary first frame",
            tokio_tungstenite::tungstenite::Message::Binary(hello.clone().into_bytes().into()),
        ),
    ];
    for (name, frame) in cases {
        let (messages, close) = websocket(&endpoint, std::slice::from_ref(&frame));
        let error = messages.iter().find(|message| {
            message.get("type").and_then(serde_json::Value::as_str) == Some("error")
        });
        assert_eq!(
            error
                .and_then(|message| message.get("code"))
                .and_then(serde_json::Value::as_str),
            Some("unauthorized"),
            "{name}: {messages:?}"
        );
        assert_eq!(close, Some(4001), "{name}");
    }
    let status = daemon.terminate();
    assert_eq!(status.code(), Some(0));
}

/// `auth.server.process.test.ts`: a host token on loopback welcomes the socket,
/// answers a ping, and refuses a second hello without another welcome.
#[test]
fn a_host_token_welcomes_the_socket_and_a_second_hello_is_refused() {
    let home = Home::new("welcome");
    let mut daemon = home.start(false);
    let endpoint = daemon.ready(&home);
    let token = home.token();
    let host_id = std::fs::read_to_string(home.ace_home.join("host-id")).unwrap_or_default();
    let hello = text_frame(&format!(
        "{{\"type\":\"hello\",\"protocolVersion\":1,\"deviceId\":\"device\",\"token\":\"{token}\"}}"
    ));
    let (messages, close) = websocket(
        &endpoint,
        &[hello.clone(), text_frame("{\"type\":\"ping\"}")],
    );
    let welcome = messages
        .iter()
        .find(|message| message.get("type").and_then(serde_json::Value::as_str) == Some("welcome"));
    assert_eq!(
        welcome
            .and_then(|message| message.get("hostId"))
            .and_then(serde_json::Value::as_str),
        Some(host_id.as_str()),
        "{messages:?}"
    );
    assert!(
        messages
            .iter()
            .any(|message| message.get("type").and_then(serde_json::Value::as_str) == Some("pong")),
        "the authenticated ping is answered: {messages:?}"
    );
    assert_eq!(close, None, "the socket stays open");

    let (messages, close) = websocket(&endpoint, &[hello.clone(), hello]);
    assert!(
        messages.iter().any(|message| {
            message.get("type").and_then(serde_json::Value::as_str) == Some("error")
                && message.get("message").and_then(serde_json::Value::as_str)
                    == Some("Hello is only valid once")
        }),
        "{messages:?}"
    );
    assert_eq!(close, Some(4001));
    let status = daemon.terminate();
    assert_eq!(status.code(), Some(0));
}

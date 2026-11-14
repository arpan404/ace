// SPDX-License-Identifier: Apache-2.0
//! The real binary over its real pipes and sockets: what the pure engine tests can't cover is
//! the start, lane authentication on the socket, ingest connections and exit on stdin EOF.
#![cfg(unix)]
use media_wire::control::{ControlFrame, FromMedia, Lane, Status, ToMedia};
use media_wire::frame::MediaFrame;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

const SECRET: [u8; 32] = [7; 32];

fn frame(value: Value, payload: &[u8], lane: Lane) -> Vec<u8> {
    let message: ToMedia = match serde_json::from_value(value) {
        Ok(message) => message,
        Err(error) => panic!("bad message: {error}"),
    };
    let control = ControlFrame {
        message,
        payload: Zeroizing::new(payload.to_vec()),
    };
    let Ok(mut bytes) = control.header(lane) else {
        panic!("message did not encode");
    };
    bytes.extend_from_slice(payload);
    bytes
}

fn read_frame(reader: &mut impl Read, lane: Lane) -> FromMedia {
    let mut prefix = [0u8; 4];
    if let Err(error) = reader.read_exact(&mut prefix) {
        panic!("no frame: {error}");
    }
    let mut bytes = prefix.to_vec();
    bytes.resize(4 + u32::from_be_bytes(prefix) as usize, 0);
    if let Err(error) = reader.read_exact(&mut bytes[4..]) {
        panic!("cut-off frame: {error}");
    }
    match ControlFrame::<FromMedia>::decode(&bytes, lane) {
        Ok(frame) => frame.message,
        Err(_) => panic!("invalid frame from ace-media"),
    }
}

struct Media {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: ChildStdout,
    dir: PathBuf,
}

impl Drop for Media {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Media {
    fn spawn(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("am-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        if let Err(error) = std::fs::create_dir_all(&dir) {
            panic!("runtime dir: {error}");
        }
        let child = Command::new(env!("CARGO_BIN_EXE_ace-media"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn();
        let Ok(mut child) = child else {
            panic!("ace-media did not start");
        };
        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            panic!("no pipes");
        };
        Self {
            child,
            stdin: Some(stdin),
            stdout,
            dir,
        }
    }

    fn write(&mut self, bytes: &[u8]) {
        let Some(stdin) = &mut self.stdin else {
            panic!("stdin closed");
        };
        if let Err(error) = stdin.write_all(bytes) {
            panic!("stdin: {error}");
        }
    }

    fn send(&mut self, value: Value, payload: &[u8]) {
        self.write(&frame(value, payload, Lane::Normal));
    }

    fn read(&mut self) -> FromMedia {
        read_frame(&mut self.stdout, Lane::Normal)
    }

    /// Sends `init` and returns the control socket, the ingest socket and the WebSocket port.
    fn start(&mut self) -> (String, String, u32) {
        let init = json!({ "type": "init", "protocol": 1, "version": "0.0.0-test",
            "runtimeDir": self.dir.to_string_lossy(), "dataDir": self.dir.to_string_lossy(),
            "settings": { "recordings": "legacy", "stills": "auto", "encode": "legacy", "delivery": "legacy" } });
        self.send(init, &SECRET);
        match self.read() {
            FromMedia::Ready {
                pid,
                version,
                capabilities,
                control,
                ingest,
                ..
            } => {
                assert_eq!(pid, self.child.id());
                assert_eq!(version, env!("CARGO_PKG_VERSION"));
                assert!(!capabilities.is_empty(), "the CPU path is always reported");
                (control.socket, ingest.socket, ingest.websocket_port)
            }
            other => panic!("expected ready, got {other:?}"),
        }
    }

    fn exits_within(&mut self, limit: Duration) -> Option<i32> {
        let end = Instant::now() + limit;
        while Instant::now() < end {
            if let Ok(Some(status)) = self.child.try_wait() {
                return status.code();
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        None
    }
}

/// Connects a socket lane and returns it once accepted, or None when ace-media closed it
/// without answering.
fn lane(path: &str, tag: u8, secret: [u8; 32]) -> Option<UnixStream> {
    let Ok(mut socket) = UnixStream::connect(path) else {
        panic!("control socket refused the connection");
    };
    let _ = socket.set_read_timeout(Some(Duration::from_secs(5)));
    let mut hello = b"ACEL".to_vec();
    hello.push(tag);
    hello.extend_from_slice(&secret);
    let _ = socket.write_all(&hello);
    let mut answer = [0u8; 1];
    match socket.read(&mut answer) {
        Ok(1) if answer[0] == 1 => Some(socket),
        Ok(0) => None,
        other => panic!("unexpected lane answer {other:?}"),
    }
}

fn media_frame(kind: u8, flags: u32, payload: Vec<u8>) -> Vec<u8> {
    let frame = MediaFrame {
        kind,
        flags,
        age_us: 0,
        width: 2,
        height: 2,
        display_width: 2,
        display_height: 2,
        scale: 1000,
        rotation: 0,
        codec: if kind == 5 { 0 } else { 1 },
        encode: 0,
        epoch: 0,
        codec_string: String::new(),
        description: Vec::new(),
        extension: Vec::new(),
        payload,
    };
    match frame.encode() {
        Ok(bytes) => bytes,
        Err(_) => panic!("frame did not encode"),
    }
}

fn status_of(message: FromMedia) -> (String, Status) {
    match message {
        FromMedia::SourceStatus { source, status, .. } => (source.get().to_owned(), status),
        other => panic!("expected source.status, got {other:?}"),
    }
}

fn open_source(media: &mut Media, source: &str, handle: u32, token: u8) {
    media.send(
        json!({ "type": "source.open", "source": source, "handle": handle, "epoch": 1,
                "origin": { "kind": "tab" } }),
        &[token; 32],
    );
    assert_eq!(
        status_of(media.read()),
        (source.to_owned(), Status::Starting)
    );
}

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

/// Opens the ingest WebSocket by hand (RFC 6455 §4.1) and returns the status code.
fn websocket(port: u32, path: &str, origin: &str) -> (u16, TcpStream) {
    let Ok(mut socket) = TcpStream::connect(("127.0.0.1", port as u16)) else {
        panic!("websocket port refused the connection");
    };
    let _ = socket.set_read_timeout(Some(Duration::from_secs(5)));
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: {origin}\r\n\r\n"
    );
    let _ = socket.write_all(request.as_bytes());
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") && matches!(socket.read(&mut byte), Ok(1)) {
        head.push(byte[0]);
    }
    let text = String::from_utf8_lossy(&head);
    let code = text
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    (code, socket)
}

/// One masked binary message, as a client must send it.
fn binary_message(payload: &[u8]) -> Vec<u8> {
    let mask = [1u8, 2, 3, 4];
    let mut bytes = vec![0x82];
    match payload.len() {
        n if n < 126 => bytes.push(0x80 | n as u8),
        n => {
            bytes.push(0x80 | 126);
            bytes.extend_from_slice(&(n as u16).to_be_bytes());
        }
    }
    bytes.extend_from_slice(&mask);
    bytes.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
    bytes
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

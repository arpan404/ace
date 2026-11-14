// SPDX-License-Identifier: Apache-2.0
//! Driving the real binary: spawning it in a private runtime directory, its control frames,
//! lanes, ingest frames and a hand-made WebSocket client.
#![allow(dead_code)]
use media_wire::control::{ControlFrame, FromMedia, Lane, Status, ToMedia};
use media_wire::frame::MediaFrame;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

pub const SECRET: [u8; 32] = [7; 32];

pub fn frame(value: Value, payload: &[u8], lane: Lane) -> Vec<u8> {
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

pub fn read_frame(reader: &mut impl Read, lane: Lane) -> FromMedia {
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

pub struct Media {
    pub child: Child,
    pub stdin: Option<ChildStdin>,
    pub stdout: ChildStdout,
    pub dir: PathBuf,
}

impl Drop for Media {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Media {
    pub fn spawn(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("am-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        if let Err(error) = std::fs::create_dir_all(&dir) {
            panic!("runtime dir: {error}");
        }
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
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

    pub fn write(&mut self, bytes: &[u8]) {
        let Some(stdin) = &mut self.stdin else {
            panic!("stdin closed");
        };
        if let Err(error) = stdin.write_all(bytes) {
            panic!("stdin: {error}");
        }
    }

    pub fn send(&mut self, value: Value, payload: &[u8]) {
        self.write(&frame(value, payload, Lane::Normal));
    }

    pub fn read(&mut self) -> FromMedia {
        read_frame(&mut self.stdout, Lane::Normal)
    }

    /// Sends `init` and returns the control socket, the ingest socket and the WebSocket port.
    pub fn start(&mut self) -> (String, String, u32) {
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

    pub fn exits_within(&mut self, limit: Duration) -> Option<i32> {
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
pub fn lane(path: &str, tag: u8, secret: [u8; 32]) -> Option<UnixStream> {
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

pub fn media_frame(kind: u8, flags: u32, payload: Vec<u8>) -> Vec<u8> {
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

pub fn status_of(message: FromMedia) -> (String, Status) {
    match message {
        FromMedia::SourceStatus { source, status, .. } => (source.get().to_owned(), status),
        other => panic!("expected source.status, got {other:?}"),
    }
}

pub fn open_source(media: &mut Media, source: &str, handle: u32, token: u8) {
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

/// Opens the ingest WebSocket by hand (RFC 6455 §4.1) and returns the status code.
pub fn websocket(port: u32, path: &str, origin: &str) -> (u16, TcpStream) {
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
pub fn binary_message(payload: &[u8]) -> Vec<u8> {
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

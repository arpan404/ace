// SPDX-License-Identifier: Apache-2.0
//! Driving the real binary: spawning it in a private runtime directory, its control frames,
//! lanes, ingest frames and a hand-made WebSocket client.
#![allow(dead_code)]
use media_wire::control::{Capability, ControlFrame, FromMedia, Lane, Status, ToMedia};
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

#[cfg(target_os = "macos")]
#[path = "probed.rs"]
pub mod probed;

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

/// The next frame, or none once the stream ends.
pub fn try_read_frame(reader: &mut impl Read, lane: Lane) -> Option<FromMedia> {
    let mut prefix = [0u8; 4];
    reader.read_exact(&mut prefix).ok()?;
    let mut bytes = prefix.to_vec();
    bytes.resize(4 + u32::from_be_bytes(prefix) as usize, 0);
    reader.read_exact(&mut bytes[4..]).ok()?;
    match ControlFrame::<FromMedia>::decode(&bytes, lane) {
        Ok(frame) => Some(frame.message),
        Err(_) => panic!("invalid frame from ace-media"),
    }
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
    /// The direct listener's loopback port, from `ready`.
    pub listen_port: u32,
    /// The binary's capability list: `ready`'s, replaced by each `capabilities.changed`.
    pub capabilities: Vec<Capability>,
    /// The optional features `ready` agreed to.
    pub features: Option<Vec<String>>,
}

impl Drop for Media {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Media {
    /// ace-media as this daemon starts it: offered the optional features it speaks.
    pub fn spawn(name: &str) -> Self {
        Self::spawn_offering(name, Some("source.ingest,source.sync,picture-ingest"))
    }

    /// ace-media as an older daemon starts it: offered nothing.
    pub fn spawn_unoffered(name: &str) -> Self {
        Self::spawn_offering(name, None)
    }

    fn spawn_offering(name: &str, offer: Option<&str>) -> Self {
        let dir = std::env::temp_dir().join(format!("am-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        if let Err(error) = std::fs::create_dir_all(&dir) {
            panic!("runtime dir: {error}");
        }
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        let mut command = Command::new(env!("CARGO_BIN_EXE_ace-media"));
        match offer {
            Some(offer) => command.env("ACE_MEDIA_FEATURES", offer),
            None => command.env_remove("ACE_MEDIA_FEATURES"),
        };
        let child = command
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
            listen_port: 0,
            features: None,
            capabilities: Vec::new(),
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

    /// The next message, after applying any `capabilities.changed` before it: one may arrive
    /// at any time after `ready` (a trial that finished late), between any two others.
    pub fn read(&mut self) -> FromMedia {
        loop {
            match read_frame(&mut self.stdout, Lane::Normal) {
                FromMedia::CapabilitiesChanged { capabilities } => self.capabilities = capabilities,
                message => {
                    if let FromMedia::Ready { capabilities, .. } = &message {
                        self.capabilities = capabilities.clone();
                    }
                    return message;
                }
            }
        }
    }

    /// Waits, after `ready` and before any source opens, until the binary holds what this Mac's
    /// VideoToolbox trial finally finds: every step that trial found working is reported the
    /// same way. On a busy machine some arrive only as `capabilities.changed`; a test that
    /// decides from `ready` alone reads them too early. Bounded: a child that never reports
    /// them fails the test, naming what's missing.
    #[cfg(target_os = "macos")]
    pub fn settle_probe(&mut self) {
        let expected: Vec<Capability> = probed::probed()
            .into_iter()
            .filter(|c| c.state == media_wire::control::TrialState::Ok)
            .collect();
        let within = probed::settle_within();
        if let Err(missing) = self.try_settle_probe(&expected, within) {
            panic!("ace-media never reported, within {within:?}:\n{missing}");
        }
    }

    /// `settle_probe` against `expected`, failing after `within` with the expected entries the
    /// child still hasn't reported. A child that stays silent is killed at the bound, so the
    /// blocked read ends.
    #[cfg(target_os = "macos")]
    pub fn try_settle_probe(
        &mut self,
        expected: &[Capability],
        within: Duration,
    ) -> Result<(), String> {
        let family = |c: &Capability| {
            let codec = c.codec.as_deref().unwrap_or("");
            (c.step, codec.get(..4).unwrap_or(codec).to_owned())
        };
        let missing = |held: &[Capability]| -> Vec<Capability> {
            expected
                .iter()
                .filter(|want| {
                    !held.iter().any(|c| {
                        c.backend == want.backend
                            && family(c) == family(want)
                            && c.state == want.state
                            && c.hardware == want.hardware
                    })
                })
                .cloned()
                .collect()
        };
        let (settled, watching) = std::sync::mpsc::channel::<()>();
        let pid = self.child.id().to_string();
        std::thread::spawn(move || {
            if let Err(std::sync::mpsc::RecvTimeoutError::Timeout) = watching.recv_timeout(within) {
                let _ = Command::new("kill").args(["-9", &pid]).status();
            }
        });
        loop {
            let left = missing(&self.capabilities);
            if left.is_empty() {
                let _ = settled.send(());
                return Ok(());
            }
            let Some(message) = try_read_frame(&mut self.stdout, Lane::Normal) else {
                let left: Vec<&Capability> = left.iter().collect();
                return Err(probed::describe(&left));
            };
            match message {
                FromMedia::CapabilitiesChanged { capabilities } => self.capabilities = capabilities,
                FromMedia::Log { .. } => {}
                other => {
                    let _ = settled.send(());
                    return Err(format!(
                        "expected capabilities.changed while the probe settles, got {other:?}"
                    ));
                }
            }
        }
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
                listen,
                features,
                ..
            } => {
                self.listen_port = listen.loopback_port;
                self.features = features;
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

/// A lane after its hello, as the daemon holds it: reads open records, writes seal them.
pub struct SealedLane {
    stream: UnixStream,
    records: ace_media::lane_cipher::Records,
    /// Raw bytes of a record still arriving (a read can time out mid-record).
    raw: Vec<u8>,
    /// Opened plaintext not yet read.
    plain: std::collections::VecDeque<u8>,
}

impl SealedLane {
    pub fn set_read_timeout(&self, timeout: Option<Duration>) -> std::io::Result<()> {
        self.stream.set_read_timeout(timeout)
    }

    /// Reads raw bytes until one whole record is buffered, then opens it.
    fn next_record(&mut self) -> std::io::Result<()> {
        loop {
            if self.raw.len() >= 2 {
                let length = 2 + usize::from(u16::from_be_bytes([self.raw[0], self.raw[1]]));
                if self.raw.len() >= length {
                    let mut body: Vec<u8> = self.raw.drain(..length).skip(2).collect();
                    let plain = self
                        .records
                        .open(&mut body)
                        .map_err(|_| std::io::Error::other("a lane record failed to open"))?;
                    self.plain.extend(plain.iter());
                    return Ok(());
                }
            }
            let mut chunk = [0u8; 16 * 1024];
            let n = self.stream.read(&mut chunk)?;
            if n == 0 {
                return Err(std::io::ErrorKind::UnexpectedEof.into());
            }
            self.raw.extend_from_slice(&chunk[..n]);
        }
    }
}

impl Read for SealedLane {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.plain.is_empty() {
            match self.next_record() {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(0),
                Err(error) => return Err(error),
            }
        }
        let n = buf.len().min(self.plain.len());
        for (slot, byte) in buf.iter_mut().zip(self.plain.drain(..n)) {
            *slot = byte;
        }
        Ok(n)
    }
}

impl Write for SealedLane {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let n = buf.len().min(ace_media::lane_cipher::MAX_PLAIN);
        let mut out = Vec::new();
        self.records
            .seal(&buf[..n], &mut out)
            .map_err(|_| std::io::Error::other("sealing a lane record failed"))?;
        self.stream.write_all(&out)?;
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.stream.flush()
    }
}

/// Connects a socket lane and returns it once accepted, or None when ace-media closed it
/// without answering. The daemon's side of the lane hello (`media_wire::lane`): it sends its
/// proof even when ace-media's doesn't check out against `secret`, so a test with the wrong
/// secret sees ace-media itself refuse it. An accepted lane carries records from then on, the
/// accept byte first.
pub fn lane(path: &str, tag: u8, secret: [u8; 32]) -> Option<SealedLane> {
    use media_wire::lane::{self, NONCE_LEN, SERVER_REPLY_LEN};
    let Ok(mut socket) = UnixStream::connect(path) else {
        panic!("control socket refused the connection");
    };
    let _ = socket.set_read_timeout(Some(Duration::from_secs(5)));
    let mut nonce = [0u8; NONCE_LEN];
    let _ = ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut nonce);
    let hello = lane::hello(tag, &nonce).unwrap_or_else(|| {
        let mut bytes = [0u8; lane::HELLO_LEN];
        bytes[..4].copy_from_slice(lane::MAGIC);
        bytes[4] = tag;
        bytes
    });
    let _ = socket.write_all(&hello);
    let mut reply = [0u8; SERVER_REPLY_LEN];
    if socket.read_exact(&mut reply).is_err() {
        return None;
    }
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, &secret);
    let server_ok =
        ring::hmac::verify(&key, &lane::server_message(tag, &nonce), &reply[..32]).is_ok();
    let mut server_nonce = [0u8; NONCE_LEN];
    server_nonce.copy_from_slice(&reply[32..]);
    let proof = ring::hmac::sign(&key, &lane::client_message(tag, &nonce, &server_nonce));
    let _ = socket.write_all(proof.as_ref());
    let held = ace_media::secret::LaneSecret::from_payload(&secret)?;
    let mut server_proof = [0u8; 32];
    server_proof.copy_from_slice(&reply[..32]);
    let mut client_proof = [0u8; 32];
    client_proof.copy_from_slice(proof.as_ref());
    let transcript = lane::transcript(tag, &nonce, &server_nonce, &server_proof, &client_proof);
    let keys = ace_media::lane_cipher::derive(&held, &transcript);
    let records = ace_media::lane_cipher::Records::daemon_side(keys).ok()?;
    let mut sealed = SealedLane {
        stream: socket,
        records,
        raw: Vec::new(),
        plain: std::collections::VecDeque::new(),
    };
    let mut answer = [0u8; 1];
    match sealed.read(&mut answer) {
        Ok(1) if answer[0] == 1 && server_ok => Some(sealed),
        Ok(1) if answer[0] == 1 => panic!("accepted a lane whose server proof failed"),
        Ok(0) => None,
        Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => None,
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

/// A producer's ingest connection, after its hello with the source's token: JPEG pictures go on
/// it as still-picture frames (kind 3, codec JPEG), as the daemon's picture sources send them.
#[cfg(unix)]
pub struct PictureProducer(std::os::unix::net::UnixStream);

#[cfg(unix)]
impl PictureProducer {
    pub fn connect(ingest: &str, token: u8) -> Self {
        use std::io::Write;
        let mut socket = match std::os::unix::net::UnixStream::connect(ingest) {
            Ok(socket) => socket,
            Err(error) => panic!("ingest socket: {error}"),
        };
        if let Err(error) = socket.write_all(&media_frame(5, 0, vec![token; 32])) {
            panic!("ingest hello: {error}");
        }
        Self(socket)
    }

    pub fn picture(&mut self, jpeg: &[u8], width: u16, height: u16) {
        use std::io::Write;
        let frame = MediaFrame {
            kind: 3,
            flags: 1,
            age_us: 0,
            width,
            height,
            display_width: width,
            display_height: height,
            scale: 1000,
            rotation: 0,
            codec: 7,
            encode: 0,
            epoch: 1,
            codec_string: String::new(),
            description: Vec::new(),
            extension: Vec::new(),
            payload: jpeg.to_vec(),
        };
        let Ok(bytes) = frame.encode() else {
            panic!("picture did not encode");
        };
        if let Err(error) = self.0.write_all(&bytes) {
            panic!("ingest picture: {error}");
        }
    }
}

/// The source a `source.ingest` names: ace-media bound a producer's hello to it.
pub fn ingest_of(message: FromMedia) -> String {
    match message {
        FromMedia::SourceIngest { source } => source.get().to_owned(),
        other => panic!("expected source.ingest, got {other:?}"),
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

// SPDX-License-Identifier: Apache-2.0

//! A test client that speaks `files-wire` to the real `ace-files` binary.
//!
//! Test-only code: a fixture that cannot start, or a binary that stops answering, should fail the
//! test loudly rather than hang it.
#![allow(dead_code)]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::VecDeque;
use std::fs;
use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use files_wire::{ChangeKind, Decoder, EventPayload, Frame, Message, Op, PROTOCOL, Reply, encode};

/// How long a test waits for a frame before calling the binary hung.
pub const TIMEOUT: Duration = Duration::from_secs(20);

/// A running `ace-files` and the frames it sent that the test has not read yet.
pub struct Client {
    child: Child,
    stdin: Option<ChildStdin>,
    frames: Receiver<Frame>,
    pending: VecDeque<Message>,
    bodies: VecDeque<(u64, Vec<u8>)>,
    stderr: Option<Receiver<String>>,
    last_id: u64,
}

/// The `error` message a request got.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireError {
    /// The request it answers.
    pub id: u64,
    /// The stable code, such as `NOT_FOUND`.
    pub code: String,
    /// The sentence the binary wrote.
    pub message: String,
    /// The version a conflict found, when it carried one.
    pub current: Option<String>,
}

impl Client {
    /// Spawn the binary with its stdio piped and a thread decoding its stdout.
    pub fn start() -> Client {
        Client::launch(&[], false)
    }

    /// Spawn the binary with the live-root counter on, keeping its stderr for the test.
    pub fn with_live_roots() -> Client {
        Client::launch(&[("ACE_FILES_LIVE_ROOTS", "1")], true)
    }

    /// Spawn the binary with extra environment and, when asked, a stderr the test can read.
    pub fn launch(env: &[(&str, &str)], capture_stderr: bool) -> Client {
        let mut command = Command::new(env!("CARGO_BIN_EXE_ace-files"));
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(if capture_stderr {
                Stdio::piped()
            } else {
                Stdio::inherit()
            });
        for (key, value) in env {
            command.env(key, value);
        }
        let mut child = command.spawn().expect("the ace-files binary starts");
        let stdin = child.stdin.take().expect("a stdin pipe");
        let stdout = child.stdout.take().expect("a stdout pipe");
        let stderr = child.stderr.take().map(|stderr| {
            let (sender, lines) = mpsc::channel();
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines() {
                    let Ok(line) = line else { return };
                    eprintln!("{line}");
                    if sender.send(line).is_err() {
                        return;
                    }
                }
            });
            lines
        });
        let (sender, frames) = mpsc::channel();
        std::thread::spawn(move || {
            let mut stdout = stdout;
            let mut decoder = Decoder::new();
            let mut chunk = [0u8; 64 * 1024];
            loop {
                match stdout.read(&mut chunk) {
                    Ok(0) | Err(_) => return,
                    Ok(read) => {
                        decoder.push(&chunk[..read]);
                        loop {
                            match decoder.poll() {
                                Ok(Some(frame)) => {
                                    if sender.send(frame).is_err() {
                                        return;
                                    }
                                }
                                Ok(None) => break,
                                Err(_) => return,
                            }
                        }
                    }
                }
            }
        });
        Client {
            child,
            stdin: Some(stdin),
            frames,
            pending: VecDeque::new(),
            bodies: VecDeque::new(),
            stderr,
            last_id: 0,
        }
    }

    /// Spawn the binary and complete the handshake.
    pub fn greeted() -> Client {
        let mut client = Client::start();
        client.hello();
        client
    }

    /// Send `hello` and check the answer.
    pub fn hello(&mut self) {
        self.send(&Message::Hello {
            protocol: 1,
            version: None,
        });
        match self.incoming() {
            Message::Hello { protocol, version } => {
                assert_eq!(protocol, PROTOCOL, "the binary speaks this protocol");
                assert_eq!(
                    version.as_deref(),
                    Some(env!("CARGO_PKG_VERSION")),
                    "the binary reports its build version"
                );
            }
            other => panic!("expected hello, got {other:?}"),
        }
    }

    /// The next id either side has not used.
    pub fn next_id(&mut self) -> u64 {
        self.last_id += 1;
        self.last_id
    }

    /// Send one message.
    pub fn send(&mut self, message: &Message) {
        let frame = encode(message).expect("a test message fits a frame");
        self.write(&frame);
    }

    /// Send a frame holding raw JSON, for the messages a typed API cannot build.
    pub fn send_text(&mut self, text: &str) {
        let mut frame = Vec::new();
        let length = u32::try_from(text.len() + 1).expect("a small test payload");
        frame.extend_from_slice(&length.to_le_bytes());
        frame.push(1);
        frame.extend_from_slice(text.as_bytes());
        self.write(&frame);
    }

    /// Declare a frame of `length` bytes without sending it.
    pub fn send_header(&mut self, length: u32) {
        self.write(&length.to_le_bytes());
    }

    /// Send the body frame of a `write` or `createFile`.
    pub fn send_body(&mut self, id: u64, bytes: &[u8]) {
        let frame = files_wire::encode_body(id, bytes).expect("a test body fits a frame");
        self.write(&frame);
    }

    /// Send a request and hand back its id.
    pub fn request(&mut self, op: Op) -> u64 {
        let id = self.next_id();
        self.send(&Message::Request { id, op });
        id
    }

    /// Open a checkout and hand back its number.
    pub fn open_root(&mut self, path: &Path) -> u64 {
        let id = self.request(Op::OpenRoot {
            path: path.to_string_lossy().into_owned(),
        });
        match self.reply(id) {
            Reply::Root { root } => root,
            other => panic!("openRoot answered {other:?}"),
        }
    }

    /// A message matching `wanted`: first from what has already arrived, then from the wire.
    ///
    /// Everything read on the way stays in `pending`, so a reply and an event that arrive in the
    /// same chunk can be collected in either order.
    fn take_matching(&mut self, mut wanted: impl FnMut(&Message) -> bool) -> Message {
        if let Some(position) = self.pending.iter().position(&mut wanted)
            && let Some(message) = self.pending.remove(position)
        {
            return message;
        }
        loop {
            let message = self.incoming();
            if wanted(&message) {
                return message;
            }
            self.pending.push_back(message);
        }
    }

    /// The next body frame.
    pub fn next_body(&mut self) -> (u64, Vec<u8>) {
        if let Some(body) = self.bodies.pop_front() {
            return body;
        }
        loop {
            match self.frame() {
                Frame::Body { id, bytes } => return (id, bytes),
                Frame::Message(message) => self.pending.push_back(message),
            }
        }
    }

    /// The reply to one request.
    pub fn reply(&mut self, id: u64) -> Reply {
        match self.take_matching(|message| match message {
            Message::Response { id: got, .. } | Message::Error { id: got, .. } => *got == id,
            _ => false,
        }) {
            Message::Response { result, .. } => result,
            Message::Error {
                code,
                message,
                current,
                ..
            } => panic!("request {id} failed: {code}: {message} ({current:?})"),
            other => panic!("expected a reply to {id}, got {other:?}"),
        }
    }

    /// The error one request got.
    pub fn error(&mut self, id: u64) -> WireError {
        match self.take_matching(|message| match message {
            Message::Response { id: got, .. } | Message::Error { id: got, .. } => *got == id,
            _ => false,
        }) {
            Message::Error {
                code,
                message,
                current,
                ..
            } => WireError {
                id,
                code,
                message,
                current,
            },
            Message::Response { .. } => {
                panic!("request {id} succeeded where the test expected an error")
            }
            other => panic!("expected an answer to {id}, got {other:?}"),
        }
    }

    /// The next event of one subscription.
    pub fn event(&mut self, subscription: u64) -> EventPayload {
        match self.take_matching(|message| {
            matches!(message, Message::Event { subscription: got, .. } if *got == subscription)
        }) {
            Message::Event { payload, .. } => payload,
            other => panic!("expected an event for {subscription}, got {other:?}"),
        }
    }

    /// Check that no event arrives for `subscription` within `window`.
    ///
    /// Used after `closeRoot`, where a watcher that outlived its root would still report batches.
    pub fn expect_no_event(&mut self, subscription: u64, window: Duration) {
        let deadline = Instant::now() + window;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return;
            }
            match self.frames.recv_timeout(remaining) {
                Err(_) => return,
                Ok(Frame::Body { id, bytes }) => self.bodies.push_back((id, bytes)),
                Ok(Frame::Message(message)) => {
                    if let Message::Event {
                        subscription: got, ..
                    } = &message
                        && *got == subscription
                    {
                        panic!("subscription {subscription} reported {message:?} after closeRoot");
                    }
                    self.pending.push_back(message);
                }
            }
        }
    }

    /// Wait for the binary to report `wanted` live roots, as `ACE_FILES_LIVE_ROOTS` makes it.
    ///
    /// A root the process forgot to release (a watcher that still points at it, say) never reaches
    /// zero, so this fails with the last count it saw.
    pub fn await_live_roots(&mut self, wanted: usize) {
        let stderr = self
            .stderr
            .as_mut()
            .expect("this client was launched with the live-root counter");
        let deadline = Instant::now() + TIMEOUT;
        let mut last = None;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let line = stderr.recv_timeout(remaining).unwrap_or_else(|_| {
                panic!("no live-root count reached {wanted}; last was {last:?}")
            });
            let Some(count) = line
                .strip_prefix("ace-files: live-roots ")
                .and_then(|count| count.parse::<usize>().ok())
            else {
                continue;
            };
            last = Some(count);
            if count == wanted {
                return;
            }
        }
    }

    /// Close the daemon's end of stdin.
    pub fn close_stdin(&mut self) {
        self.stdin.take();
    }

    /// Wait for the process to exit, failing the test when it outstays the timeout.
    pub fn wait(&mut self) -> ExitStatus {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            match self.child.try_wait().expect("the child can be polled") {
                Some(status) => return status,
                None if Instant::now() > deadline => {
                    let _ = self.child.kill();
                    panic!("the binary did not exit within {TIMEOUT:?}");
                }
                None => std::thread::sleep(Duration::from_millis(10)),
            }
        }
    }

    /// Read one frame, or fail the test when none arrives.
    fn frame(&mut self) -> Frame {
        match self.frames.recv_timeout(TIMEOUT) {
            Ok(frame) => frame,
            Err(error) => panic!("no frame from the binary in {TIMEOUT:?}: {error}"),
        }
    }

    /// Read one message frame, keeping body frames for `next_body`.
    fn incoming(&mut self) -> Message {
        loop {
            match self.frame() {
                Frame::Message(message) => return message,
                Frame::Body { id, bytes } => self.bodies.push_back((id, bytes)),
            }
        }
    }

    fn write(&mut self, bytes: &[u8]) {
        let stdin = self.stdin.as_mut().expect("the client's stdin is open");
        stdin.write_all(bytes).expect("the binary reads its stdin");
        stdin.flush().expect("the pipe is writable");
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        self.stdin.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A temp checkout holding the given files, with their parent folders created.
pub fn checkout(files: &[(&str, &str)]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("a temp dir");
    for (path, contents) in files {
        write_file(dir.path(), path, contents);
    }
    dir
}

/// Write one file inside a checkout, creating its parents.
pub fn write_file(base: &Path, path: &str, contents: &str) {
    let full = base.join(path);
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).expect("the parent folder");
    }
    fs::write(&full, contents).expect("the file");
}

/// How long a watcher may take to report one small change.
pub const WATCH_DEADLINE: Duration = Duration::from_secs(10);

/// Subscribe to a root's changes and hand back the subscription.
pub fn watch(client: &mut Client, root: u64) -> u64 {
    let id = client.request(Op::Watch { root });
    match client.reply(id) {
        Reply::Subscription { subscription } => subscription,
        other => panic!("watch answered {other:?}"),
    }
}

/// Wait until a watch reports `path` as created.
pub fn await_created(client: &mut Client, subscription: u64, path: &str) {
    let deadline = Instant::now() + WATCH_DEADLINE;
    loop {
        assert!(
            Instant::now() < deadline,
            "no change batch named {path} within {WATCH_DEADLINE:?}"
        );
        match client.event(subscription) {
            EventPayload::Changes { changes } => {
                if changes
                    .iter()
                    .any(|change| change.path == path && change.kind == ChangeKind::Created)
                {
                    return;
                }
            }
            // A degraded watcher (the polling fallback) still reports batches; keep waiting.
            EventPayload::Warning { .. } | EventPayload::Rescan { .. } => {}
            other => panic!("unexpected watch event {other:?}"),
        }
    }
}

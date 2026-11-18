// SPDX-License-Identifier: Apache-2.0

//! A test client that speaks `files-wire` to the real `ace-files` binary.
//!
//! Test-only code: a fixture that cannot start, or a binary that stops answering, should fail the
//! test loudly rather than hang it.
#![allow(dead_code)]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::VecDeque;
use std::fs;
use std::io::{Read as _, Write as _};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use files_wire::{Decoder, EventPayload, Frame, Message, Op, PROTOCOL, Reply, encode};

/// How long a test waits for a frame before calling the binary hung.
pub const TIMEOUT: Duration = Duration::from_secs(20);

/// A running `ace-files` and the frames it sent that the test has not read yet.
pub struct Client {
    child: Child,
    stdin: Option<ChildStdin>,
    frames: Receiver<Frame>,
    pending: VecDeque<Message>,
    bodies: VecDeque<(u64, Vec<u8>)>,
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
        let mut child = Command::new(env!("CARGO_BIN_EXE_ace-files"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("the ace-files binary starts");
        let stdin = child.stdin.take().expect("a stdin pipe");
        let stdout = child.stdout.take().expect("a stdout pipe");
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

    /// The next message, with anything already read waiting in front.
    pub fn next_message(&mut self) -> Message {
        if let Some(message) = self.pending.pop_front() {
            return message;
        }
        self.incoming()
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
        loop {
            match self.incoming() {
                Message::Response { id: got, result } if got == id => return result,
                Message::Error {
                    id: got,
                    code,
                    message,
                    current,
                } if got == id => panic!("request {id} failed: {code}: {message} ({current:?})"),
                other => self.pending.push_back(other),
            }
        }
    }

    /// The error one request got.
    pub fn error(&mut self, id: u64) -> WireError {
        loop {
            match self.incoming() {
                Message::Error {
                    id: got,
                    code,
                    message,
                    current,
                } if got == id => {
                    return WireError {
                        id,
                        code,
                        message,
                        current,
                    };
                }
                Message::Response { id: got, .. } if got == id => {
                    panic!("request {id} succeeded where the test expected an error")
                }
                other => self.pending.push_back(other),
            }
        }
    }

    /// The next event of one subscription.
    pub fn event(&mut self, subscription: u64) -> EventPayload {
        loop {
            match self.incoming() {
                Message::Event {
                    subscription: got,
                    payload,
                } if got == subscription => return payload,
                other => self.pending.push_back(other),
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

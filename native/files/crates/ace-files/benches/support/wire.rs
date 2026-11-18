// SPDX-License-Identifier: Apache-2.0

//! A bench-only `files-wire` client: one child process, framed stdio, and its pid.
//!
//! The integration tests' client (`tests/common`) is built for assertions with 20 s deadlines.
//! A bench measures a million-file checkout that can take minutes and reads the process's memory,
//! so it owns its own small client: no assertions, a long timeout, and the child's pid.

use std::collections::VecDeque;
use std::io::{Read as _, Write as _};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::Duration;

use files_wire::{Decoder, EventPayload, Frame, Message, Op, PROTOCOL, Reply, encode};

/// How long the bench waits for any one frame before calling the binary hung.
pub const TIMEOUT: Duration = Duration::from_secs(600);

/// A running `ace-files` and the frames it sent that the bench has not read yet.
pub struct Wire {
    child: Child,
    stdin: Option<ChildStdin>,
    frames: Receiver<Frame>,
    pending: VecDeque<Message>,
    bodies: VecDeque<(u64, Vec<u8>)>,
    last_id: u64,
}

impl Wire {
    /// Spawn the binary with its stdio piped and a thread decoding its stdout.
    pub fn start(binary: &Path) -> Result<Wire, String> {
        let mut child = Command::new(binary)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| format!("cannot start {}: {error}", binary.display()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "the binary has no stdin pipe".to_owned())?;
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| "the binary has no stdout pipe".to_owned())?;
        let (sender, frames) = mpsc::channel();
        std::thread::spawn(move || {
            let mut decoder = Decoder::new();
            let mut chunk = [0u8; 256 * 1024];
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
        Ok(Wire {
            child,
            stdin: Some(stdin),
            frames,
            pending: VecDeque::new(),
            bodies: VecDeque::new(),
            last_id: 0,
        })
    }

    /// The process id, for `ps`.
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// Say `hello` and check the answer.
    pub fn hello(&mut self) -> Result<(), String> {
        self.send(&Message::Hello {
            protocol: 1,
            version: None,
        })?;
        match self.incoming()? {
            Message::Hello { protocol, .. } if protocol == PROTOCOL => Ok(()),
            other => Err(format!("hello answered {other:?}")),
        }
    }

    /// Send one request and hand back its id.
    pub fn request(&mut self, op: Op) -> Result<u64, String> {
        self.last_id += 1;
        let id = self.last_id;
        self.send(&Message::Request { id, op })?;
        Ok(id)
    }

    /// The reply to one request, with a failed request reported as an error string.
    pub fn answer(&mut self, id: u64) -> Result<Reply, String> {
        match self.take_matching(|message| match message {
            Message::Response { id: got, .. } | Message::Error { id: got, .. } => *got == id,
            _ => false,
        })? {
            Message::Response { result, .. } => Ok(result),
            Message::Error { code, message, .. } => Err(format!("{code}: {message}")),
            other => Err(format!("expected a reply to {id}, got {other:?}")),
        }
    }

    /// The next event of one subscription, if one arrives within `window`.
    pub fn try_event(
        &mut self,
        subscription: u64,
        window: Duration,
    ) -> Result<Option<EventPayload>, String> {
        if let Some(position) = self.pending.iter().position(|message| {
            matches!(message, Message::Event { subscription: got, .. } if *got == subscription)
        }) && let Some(Message::Event { payload, .. }) = self.pending.remove(position)
        {
            return Ok(Some(payload));
        }
        let deadline = std::time::Instant::now() + window;
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Ok(None);
            }
            match self.frames.recv_timeout(remaining) {
                Err(_) => return Ok(None),
                Ok(Frame::Body { id, bytes }) => self.bodies.push_back((id, bytes)),
                Ok(Frame::Message(message)) => match message {
                    Message::Event {
                        subscription: got,
                        payload,
                    } if got == subscription => return Ok(Some(payload)),
                    other => self.pending.push_back(other),
                },
            }
        }
    }

    /// Close the binary's stdin and wait for it to exit, killing it if it outstays the deadline.
    pub fn stop(&mut self) {
        self.stdin.take();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                _ => {
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                    return;
                }
            }
        }
    }

    /// A message matching `wanted`: first from what has already arrived, then from the wire.
    fn take_matching(
        &mut self,
        mut wanted: impl FnMut(&Message) -> bool,
    ) -> Result<Message, String> {
        if let Some(position) = self.pending.iter().position(&mut wanted)
            && let Some(message) = self.pending.remove(position)
        {
            return Ok(message);
        }
        loop {
            let message = self.incoming()?;
            if wanted(&message) {
                return Ok(message);
            }
            self.pending.push_back(message);
        }
    }

    fn incoming(&mut self) -> Result<Message, String> {
        loop {
            match self.frames.recv_timeout(TIMEOUT) {
                Ok(Frame::Message(message)) => return Ok(message),
                Ok(Frame::Body { id, bytes }) => self.bodies.push_back((id, bytes)),
                Err(RecvTimeoutError::Timeout) => {
                    return Err(format!("no frame from the binary in {TIMEOUT:?}"));
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err("the binary closed its stdout".to_owned());
                }
            }
        }
    }

    fn send(&mut self, message: &Message) -> Result<(), String> {
        let frame = encode(message).map_err(|error| format!("cannot encode a message: {error}"))?;
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| "the client's stdin is closed".to_owned())?;
        stdin
            .write_all(&frame)
            .and_then(|()| stdin.flush())
            .map_err(|error| format!("cannot write to the binary: {error}"))
    }
}

impl Drop for Wire {
    fn drop(&mut self) {
        self.stop();
    }
}

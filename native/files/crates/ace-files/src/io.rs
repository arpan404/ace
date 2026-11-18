// SPDX-License-Identifier: Apache-2.0

//! The two stdio edges: a reader thread that decodes incoming frames and the one writer thread
//! that owns stdout.
//!
//! Neither edge runs on a runtime worker, and neither ever does filesystem work: the reader hands
//! whole frames to the dispatcher, and the dispatcher hands finished frames to the writer. A slow
//! disk therefore cannot stall a response, and a slow pipe cannot stall a listing.

use std::io::{ErrorKind, Read as _, Write as _};

use files_wire::{Decoder, Frame, Message, encode, encode_body};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};

use crate::error::Failure;

/// Bytes read from stdin in one call.
const READ_CHUNK: usize = 64 * 1024;

/// What the reader hands the dispatcher.
pub enum Input {
    /// One decoded frame.
    Frame(Frame),
    /// A frame that could not be decoded. The request it belonged to still gets an answer when its
    /// id came through.
    Failed {
        /// The request the frame still named, when it named one.
        id: Option<u64>,
        /// The stable code the failure becomes.
        code: &'static str,
        /// A sentence for the log and the daemon.
        message: String,
    },
    /// The daemon closed the pipe, so there is nobody left to answer.
    Eof,
}

/// Start the reader thread and hand back the channel the dispatcher drains.
pub fn reader() -> UnboundedReceiver<Input> {
    let (sender, receiver) = mpsc::unbounded_channel();
    let spawned = std::thread::Builder::new()
        .name("ace-files-stdin".to_owned())
        .spawn(move || read_stdin(&sender));
    if let Err(error) = spawned {
        eprintln!("ace-files: cannot start the reader: {error}");
        std::process::exit(1);
    }
    receiver
}

/// Read stdin until it closes, decoding every frame it holds.
fn read_stdin(sender: &UnboundedSender<Input>) {
    let stdin = std::io::stdin();
    let mut stdin = stdin.lock();
    let mut decoder = Decoder::new();
    let mut chunk = vec![0u8; READ_CHUNK];
    loop {
        match stdin.read(&mut chunk) {
            Ok(0) => {
                let _ = sender.send(Input::Eof);
                return;
            }
            Ok(read) => {
                decoder.push(&chunk[..read]);
                loop {
                    match decoder.poll() {
                        Ok(Some(frame)) => {
                            if sender.send(Input::Frame(frame)).is_err() {
                                return;
                            }
                        }
                        Ok(None) => break,
                        Err(error) => {
                            // An oversize declaration is the one failure that ends the stream: the
                            // next frame cannot be trusted to start where it says, so the process
                            // stops instead of guessing.
                            if error.code() == "TOO_LARGE" {
                                eprintln!("ace-files: {error}");
                                std::process::exit(2);
                            }
                            let failed = Input::Failed {
                                id: error.id(),
                                code: error.code(),
                                message: error.to_string(),
                            };
                            if sender.send(failed).is_err() {
                                return;
                            }
                        }
                    }
                }
            }
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(error) => {
                eprintln!("ace-files: cannot read stdin: {error}");
                std::process::exit(2);
            }
        }
    }
}

/// One frame on its way out.
enum Item {
    /// A JSON message.
    Message(Message),
    /// The bytes of a `read`, tagged with the response's id.
    Body { id: u64, bytes: Vec<u8> },
}

/// The handle every task writes through. Frames reach stdout in the order they were sent, which is
/// what makes a `read` response and its body arrive in order.
#[derive(Clone)]
pub struct Out {
    sender: UnboundedSender<Item>,
}

impl Out {
    /// Start the writer thread.
    pub fn start() -> Out {
        let (sender, receiver) = mpsc::unbounded_channel();
        let spawned = std::thread::Builder::new()
            .name("ace-files-stdout".to_owned())
            .spawn(move || write_stdout(receiver));
        if let Err(error) = spawned {
            eprintln!("ace-files: cannot start the writer: {error}");
            std::process::exit(1);
        }
        Out { sender }
    }

    /// Queue one message.
    pub fn send(&self, message: Message) {
        if self.sender.send(Item::Message(message)).is_err() {
            eprintln!("ace-files: the writer stopped");
        }
    }

    /// Queue the body of a `read` response.
    pub fn send_body(&self, id: u64, bytes: Vec<u8>) {
        if self.sender.send(Item::Body { id, bytes }).is_err() {
            eprintln!("ace-files: the writer stopped");
        }
    }

    /// Log a failed request and answer it. Every error takes exactly this path, so the log carries
    /// one line per error and stdout carries nothing but frames.
    pub fn error(&self, id: u64, failure: Failure) {
        eprintln!(
            "ace-files: request {id} failed: {}: {}",
            failure.code, failure.message
        );
        self.send(Message::Error {
            id,
            code: failure.code.to_owned(),
            message: failure.message,
            current: failure.current,
        });
    }
}

/// Write frames until the dispatcher drops its handle.
fn write_stdout(mut items: UnboundedReceiver<Item>) {
    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();
    while let Some(item) = items.blocking_recv() {
        let frame = match item {
            Item::Message(message) => encode(&message),
            Item::Body { id, bytes } => encode_body(id, &bytes),
        };
        let frame = match frame {
            Ok(frame) => frame,
            Err(error) => {
                eprintln!("ace-files: cannot encode a frame: {error}");
                continue;
            }
        };
        match stdout.write_all(&frame).and_then(|()| stdout.flush()) {
            Ok(()) => {}
            // The daemon closed stdout: it is gone, and so are we.
            Err(error) if error.kind() == ErrorKind::BrokenPipe => std::process::exit(0),
            Err(error) => {
                eprintln!("ace-files: cannot write stdout: {error}");
                std::process::exit(1);
            }
        }
    }
}

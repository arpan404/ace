// SPDX-License-Identifier: Apache-2.0

//! The stdin edge: one reader thread that decodes incoming frames and hands whole frames to the
//! dispatcher.
//!
//! The reader never runs on a runtime worker and never does filesystem work, and it never blocks
//! on stdout: a slow disk therefore cannot stall a request, and a slow pipe cannot stall reading.

use std::io::{ErrorKind, Read as _};

use files_wire::{Decoder, Frame};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};

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

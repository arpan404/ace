// SPDX-License-Identifier: Apache-2.0

//! The two stdio edges: a reader thread that decodes incoming frames and the one writer thread
//! that owns stdout.
//!
//! Neither edge runs on a runtime worker, and neither ever does filesystem work: the reader hands
//! whole frames to the dispatcher, and the dispatcher hands finished frames to the writer. A slow
//! disk therefore cannot stall a response, and a slow pipe cannot stall a listing.

use std::collections::VecDeque;
use std::io::{ErrorKind, Read as _};

use files_wire::{Decoder, EventPayload, Frame, Message, encode, encode_body};
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
    // Events split to fit a frame go here and are written before anything newer, so a batch keeps
    // its order.
    let mut again = VecDeque::new();
    loop {
        let item = match again.pop_front() {
            Some(item) => item,
            None => match items.blocking_recv() {
                Some(item) => item,
                None => return,
            },
        };
        match write_item(&mut stdout, item, &mut again) {
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

/// Write one queued item, never dropping it silently.
///
/// A frame that cannot be encoded because it is too large is replaced: a response or an error
/// becomes a `TOO_LARGE` error with the same request id, a `changes` event is split in two until
/// the halves fit, and an event with no way to shrink is dropped with a `warning` event on the
/// same subscription. Items the split produces are handed back in `again`.
fn write_item(
    stdout: &mut impl std::io::Write,
    item: Item,
    again: &mut VecDeque<Item>,
) -> std::io::Result<()> {
    match item {
        Item::Message(message) => match encode(&message) {
            Ok(frame) => write_frame(stdout, &frame),
            Err(error) => {
                eprintln!("ace-files: cannot encode a message: {error}");
                write_fallback(stdout, &message, &error, again)
            }
        },
        Item::Body { id, bytes } => match encode_body(id, &bytes) {
            Ok(frame) => write_frame(stdout, &frame),
            Err(error) => {
                eprintln!("ace-files: cannot encode the body of request {id}: {error}");
                too_large(stdout, id, &error.to_string())
            }
        },
    }
}

/// One frame to stdout, flushed so the daemon sees it now.
fn write_frame(stdout: &mut impl std::io::Write, frame: &[u8]) -> std::io::Result<()> {
    stdout.write_all(frame)?;
    stdout.flush()
}

/// Replace a message that does not fit in a frame with the closest thing that does.
fn write_fallback(
    stdout: &mut impl std::io::Write,
    message: &Message,
    error: &files_wire::Error,
    again: &mut VecDeque<Item>,
) -> std::io::Result<()> {
    match message {
        Message::Response { id, .. } => too_large(stdout, *id, &error.to_string()),
        Message::Error { id, code, .. } => too_large(stdout, *id, &format!("{code}: {error}")),
        Message::Event {
            subscription,
            payload,
        } => split_event(stdout, *subscription, payload, again),
        Message::Hello { .. } | Message::Request { .. } | Message::Cancel { .. } => {
            eprintln!("ace-files: dropped a message that does not fit one frame: {error}");
            Ok(())
        }
    }
}

/// Answer a request whose response could not be sent with an error that can.
fn too_large(stdout: &mut impl std::io::Write, id: u64, detail: &str) -> std::io::Result<()> {
    let failure = Message::Error {
        id,
        code: "TOO_LARGE".to_owned(),
        message: format!("the answer does not fit one frame: {detail}"),
        current: None,
    };
    match encode(&failure) {
        Ok(frame) => write_frame(stdout, &frame),
        Err(error) => {
            eprintln!("ace-files: dropped a message that does not fit one frame: {error}");
            Ok(())
        }
    }
}

/// Split an oversize `changes` batch in two and write the halves next. A payload that cannot be
/// split is dropped, and a warning event on the same subscription says so.
fn split_event(
    stdout: &mut impl std::io::Write,
    subscription: u64,
    payload: &EventPayload,
    again: &mut VecDeque<Item>,
) -> std::io::Result<()> {
    if let EventPayload::Changes { changes } = payload
        && changes.len() > 1
    {
        let middle = changes.len() / 2;
        for half in [&changes[..middle], &changes[middle..]] {
            again.push_back(Item::Message(Message::Event {
                subscription,
                payload: EventPayload::Changes {
                    changes: half.to_vec(),
                },
            }));
        }
        return Ok(());
    }
    let warning = Message::Event {
        subscription,
        payload: EventPayload::Warning {
            message: "an event was too large to send and was dropped".to_owned(),
        },
    };
    match encode(&warning) {
        Ok(frame) => write_frame(stdout, &frame),
        Err(error) => {
            eprintln!("ace-files: dropped a message that does not fit one frame: {error}");
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    // Test-only code: a broken frame in the output is a failed assertion, not a gentle error.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use files_wire::{
        Change, ChangeKind, Entry, FileMatches, Kind, LineMatch, Page, Reply, Summary,
    };

    /// Every message the writer produced, in order.
    fn written_messages(bytes: &[u8]) -> Vec<Message> {
        let mut decoder = Decoder::new();
        decoder.push(bytes);
        let mut messages = Vec::new();
        while let Some(frame) = decoder.poll().expect("the writer writes whole frames") {
            match frame {
                Frame::Message(message) => messages.push(message),
                Frame::Body { .. } => panic!("these tests write messages only"),
            }
        }
        messages
    }

    /// Run one item through the writer and hand back what reached the pipe.
    fn write(item: Item) -> (Vec<u8>, VecDeque<Item>) {
        let mut bytes = Vec::new();
        let mut again = VecDeque::new();
        write_item(&mut bytes, item, &mut again).expect("the writer writes");
        while let Some(item) = again.pop_front() {
            write_item(&mut bytes, item, &mut again).expect("the writer writes");
        }
        (bytes, again)
    }

    /// A page of entries long enough that its response cannot fit in one frame.
    fn oversize_page() -> Message {
        let entries: Vec<Entry> = (0..40_000)
            .map(|index| Entry {
                path: format!("{}/file{index}.rs", "folder".repeat(60)),
                name: format!("file{index}.rs"),
                kind: Kind::File,
                size: 0,
                mtime_ms: 0,
                ignored: false,
            })
            .collect();
        Message::Response {
            id: 7,
            result: Reply::Page(Page {
                entries,
                next_cursor: None,
                total: 40_000,
            }),
        }
    }

    fn oversize_changes() -> Vec<Change> {
        (0..60_000)
            .map(|index| Change {
                path: format!("{}/file{index}.rs", "folder".repeat(60)),
                kind: ChangeKind::Created,
                directory: false,
            })
            .collect()
    }

    #[test]
    fn a_response_too_large_for_one_frame_becomes_a_too_large_error() {
        let (bytes, _) = write(Item::Message(oversize_page()));
        let messages = written_messages(&bytes);
        assert_eq!(
            messages.len(),
            1,
            "the request still gets exactly one answer"
        );
        match &messages[0] {
            Message::Error {
                id, code, message, ..
            } => {
                assert_eq!(*id, 7, "the error answers the request it replaced");
                assert_eq!(code, "TOO_LARGE");
                assert!(
                    message.contains("does not fit"),
                    "the message says what happened: {message}"
                );
            }
            other => panic!("a response that cannot be encoded answered {other:?}"),
        }
    }

    #[test]
    fn an_oversize_change_batch_is_split_so_every_change_arrives() {
        let changes = oversize_changes();
        let (bytes, _) = write(Item::Message(Message::Event {
            subscription: 3,
            payload: EventPayload::Changes {
                changes: changes.clone(),
            },
        }));
        let messages = written_messages(&bytes);
        assert!(
            messages.len() > 1,
            "a batch over the frame limit arrives as several events"
        );
        let mut delivered = Vec::new();
        for message in messages {
            match message {
                Message::Event {
                    subscription: 3,
                    payload: EventPayload::Changes { changes },
                } => delivered.extend(changes),
                other => panic!("splitting produced {other:?}"),
            }
        }
        assert_eq!(
            delivered, changes,
            "every change arrives once, in the order the watcher reported it"
        );
    }

    #[test]
    fn an_oversize_event_with_no_split_is_dropped_with_a_warning() {
        let file = FileMatches {
            path: "big.txt".to_owned(),
            lines: (0..40_000)
                .map(|index| LineMatch {
                    line: index,
                    preview: "x".repeat(400),
                    ranges: vec![(0, 1)],
                })
                .collect(),
        };
        let (bytes, _) = write(Item::Message(Message::Event {
            subscription: 9,
            payload: EventPayload::Matches { file },
        }));
        let messages = written_messages(&bytes);
        assert_eq!(
            messages.len(),
            1,
            "the match event is replaced, never dropped"
        );
        match &messages[0] {
            Message::Event {
                subscription: 9,
                payload: EventPayload::Warning { message },
            } => assert!(
                message.contains("too large"),
                "the warning says why nothing arrived: {message}"
            ),
            other => panic!("an unsplittable event became {other:?}"),
        }
    }

    #[test]
    fn a_summary_that_fits_is_written_as_is() {
        let message = Message::Event {
            subscription: 1,
            payload: EventPayload::SearchDone {
                summary: Summary {
                    files: 1,
                    bytes: 2,
                    matches: 3,
                    limit_hit: false,
                },
            },
        };
        let (bytes, _) = write(Item::Message(message.clone()));
        assert_eq!(written_messages(&bytes), vec![message]);
    }
}

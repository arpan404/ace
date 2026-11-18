// SPDX-License-Identifier: Apache-2.0

//! The stdout edge: one writer thread that owns the pipe, and the bounded queue every task hands
//! finished frames to.
//!
//! The queue is bounded so a daemon that stops reading slows the work that produces frames instead
//! of letting the process grow: async tasks wait in [`Out::send`], the sinks that run on their own
//! threads (the watcher's and a search's) block in [`Out::send_blocking`]. Nothing is dropped on
//! the way out, and a frame that cannot be encoded is replaced with one that can.

use std::collections::VecDeque;
use std::io::ErrorKind;

use tokio::sync::mpsc::{self, Receiver, Sender};

use files_wire::{EventPayload, Message, encode, encode_body};

use crate::error::Failure;

/// Frames the writer may hold before the producers wait for it. A daemon that stops reading slows
/// the work that produces frames instead of letting a queue grow without bound; 256 frames is a
/// short burst, not a backlog.
const QUEUE_ITEMS: usize = 256;

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
    sender: Sender<Item>,
}

impl Out {
    /// Start the writer thread.
    pub fn start() -> Out {
        let (sender, receiver) = mpsc::channel(QUEUE_ITEMS);
        let spawned = std::thread::Builder::new()
            .name("ace-files-stdout".to_owned())
            .spawn(move || write_stdout(receiver));
        if let Err(error) = spawned {
            eprintln!("ace-files: cannot start the writer: {error}");
            std::process::exit(1);
        }
        Out { sender }
    }

    /// Queue one message, waiting for room on a slow writer. Async tasks use this.
    pub async fn send(&self, message: Message) {
        self.queue(Item::Message(message)).await;
    }

    /// Queue one message from a thread that is not a task: the watcher's worker and a search's
    /// walkers block here when the daemon is not reading.
    pub fn send_blocking(&self, message: Message) {
        if self.sender.blocking_send(Item::Message(message)).is_err() {
            eprintln!("ace-files: the writer stopped");
        }
    }

    /// Queue the body of a `read` response.
    pub async fn send_body(&self, id: u64, bytes: Vec<u8>) {
        self.queue(Item::Body { id, bytes }).await;
    }

    /// Answer a failed request. Every error takes exactly this path, so stdout carries nothing but
    /// frames, and stderr carries one line only for a failure of the machine rather than of the
    /// request.
    pub async fn error(&self, id: u64, failure: Failure) {
        if crate::error::worth_logging(failure.code) {
            eprintln!(
                "ace-files: request {id} failed: {}: {}",
                failure.code, failure.message
            );
        }
        self.send(Message::Error {
            id,
            code: failure.code.to_owned(),
            message: failure.message,
            current: failure.current,
        })
        .await;
    }

    /// An `Out` whose frames go nowhere, for tests that only care about the state a batch leaves.
    #[cfg(test)]
    pub fn discard() -> Out {
        let (sender, mut items) = mpsc::channel(QUEUE_ITEMS);
        std::thread::spawn(move || while items.blocking_recv().is_some() {});
        Out { sender }
    }

    async fn queue(&self, item: Item) {
        if self.sender.send(item).await.is_err() {
            eprintln!("ace-files: the writer stopped");
        }
    }
}

/// Write frames until the dispatcher drops its handle.
fn write_stdout(mut items: Receiver<Item>) {
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
mod tests;

// SPDX-License-Identifier: Apache-2.0

//! The message loop: the handshake, the fan-out to one task per request, cancel, and body frames.
//!
//! The loop itself never blocks. Reading requests is the reader thread's job, writing answers is
//! the writer thread's job, and every op leaves for a task that does its filesystem work on a
//! blocking thread. That is what keeps one huge folder from stalling every other request.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use files_search::Summary;
use files_wire::{EventPayload, Frame, Message, Op, PROTOCOL, Reply};
use tokio::task::JoinError;

use crate::convert;
use crate::error::{Error, Failure};
use crate::io::{self, Input, Out};
use crate::ops;
use crate::ops::read_write::{ReadOp, WriteOp};
use crate::requests::{Bodies, Cancel, InFlight};
use crate::roots::{RootEntry, Roots};
use crate::subscriptions::Subscriptions;

/// How long a `write` or `createFile` waits for the body frame that carries its bytes.
const BODY_TIMEOUT: Duration = Duration::from_secs(30);

/// Everything the request tasks share.
#[derive(Clone)]
pub struct Shared {
    /// The one way to stdout.
    pub out: Out,
    /// The open checkouts.
    pub roots: Arc<Roots>,
    /// The requests that have not answered yet, so `cancel` reaches them.
    pub requests: Arc<InFlight>,
    /// The writes waiting for their bytes.
    pub bodies: Arc<Bodies>,
    /// The watch and search subscriptions.
    pub subscriptions: Arc<Subscriptions>,
}

impl Shared {
    fn new(out: Out) -> Shared {
        Shared {
            out,
            roots: Arc::new(Roots::default()),
            requests: Arc::new(InFlight::default()),
            bodies: Arc::new(Bodies::default()),
            subscriptions: Arc::new(Subscriptions::default()),
        }
    }

    /// Answer one request with a response or an error, never both.
    pub fn respond(&self, id: u64, result: Result<Reply, Error>) {
        self.requests.finish(id);
        match result {
            Ok(reply) => self.out.send(Message::Response { id, result: reply }),
            Err(error) => self.out.error(id, error.failure()),
        }
    }

    /// Finish a search: the summary when it ran to the end, and an `ABORTED` error when it was
    /// stopped, since the daemon should know the request never finished. A search that ran to the
    /// end after its subscription was closed sends the summary nowhere.
    pub fn finish_search(&self, id: u64, subscription: u64, outcome: Result<Summary, Error>) {
        let open = matches!(self.subscriptions.remove(subscription), Ok(Some(_)));
        match outcome {
            Ok(summary) => {
                self.requests.finish(id);
                if open {
                    self.out.send(Message::Event {
                        subscription,
                        payload: EventPayload::SearchDone {
                            summary: convert::summary(summary),
                        },
                    });
                }
            }
            Err(error) => self.respond(id, Err(error)),
        }
    }
}

/// Serve the daemon until stdin closes.
///
/// Closing stdin means the daemon is gone, so the process exits at once: there is nobody left to
/// answer and no state worth flushing.
pub async fn run(version: &'static str) {
    let shared = Shared::new(Out::start());
    let mut input = io::reader();
    let mut greeted = false;
    while let Some(item) = input.recv().await {
        match item {
            Input::Eof => std::process::exit(0),
            Input::Failed { id, code, message } => match id {
                Some(id) => shared.out.error(id, Failure::new(code, message)),
                None => eprintln!("ace-files: {message}"),
            },
            Input::Frame(Frame::Body { id, bytes }) => {
                if !shared.bodies.deliver(id, bytes) {
                    eprintln!(
                        "ace-files: body frame for request {id}, which is not waiting for one"
                    );
                }
            }
            Input::Frame(Frame::Message(message)) => {
                handle(&shared, &mut greeted, version, message);
            }
        }
    }
    std::process::exit(0);
}

/// Act on one incoming message.
fn handle(shared: &Shared, greeted: &mut bool, version: &'static str, message: Message) {
    match message {
        Message::Hello { .. } => {
            *greeted = true;
            shared.out.send(Message::Hello {
                protocol: PROTOCOL,
                version: Some(version.to_owned()),
            });
        }
        Message::Request { id, op } => {
            if *greeted {
                start(shared, id, op);
            } else {
                shared.out.error(
                    id,
                    Failure::new("UNSUPPORTED", "say hello before asking for anything"),
                );
            }
        }
        Message::Cancel { id } => shared.requests.cancel(id),
        Message::Response { .. } | Message::Error { .. } | Message::Event { .. } => {
            eprintln!("ace-files: the daemon sent a message only ace-files sends");
        }
    }
}

/// Hand one request to the task that will answer it. Every request gets its cancel flag before
/// the op starts, so a `cancel` that arrives first is already set when the work looks.
fn start(shared: &Shared, id: u64, op: Op) {
    let cancel = shared.requests.begin(id);
    match op {
        Op::OpenRoot { path } => open_root(shared, id, cancel, path),
        Op::CloseRoot { root } => close_root(shared, id, root),
        Op::Read {
            root,
            path,
            offset,
            length,
            max_size,
        } => start_read(
            shared,
            id,
            cancel,
            ReadOp {
                root,
                path,
                offset,
                length,
                max_size,
            },
        ),
        Op::Write {
            root,
            path,
            expected,
        } => start_write(
            shared,
            id,
            cancel,
            WriteOp {
                root,
                path,
                expected,
            },
        ),
        Op::CreateFile { root, path } => start_write(
            shared,
            id,
            cancel,
            WriteOp {
                root,
                path,
                expected: None,
            },
        ),
        Op::Watch { root } => ops::watch::start(shared, id, cancel, root),
        Op::Search { root, query } => ops::search::start(shared, id, cancel, root, query),
        Op::Unwatch { subscription } => unwatch(shared, id, subscription),
        op => perform(shared, id, cancel, op),
    }
}

/// Run one blocking op on a blocking thread and answer it.
fn perform(shared: &Shared, id: u64, cancel: Cancel, op: Op) {
    let job = shared.clone();
    tokio::spawn(async move {
        let inner = job.clone();
        let work = tokio::task::spawn_blocking(move || {
            let reply = ops::perform(&inner, op)?;
            if cancel.cancelled() {
                return Err(Error::Aborted);
            }
            Ok(reply)
        });
        job.respond(id, joined(work.await));
    });
}

/// `openRoot`: canonicalize, open the handle, build the lister, then start the index in the
/// background.
fn open_root(shared: &Shared, id: u64, cancel: Cancel, path: String) {
    let job = shared.clone();
    tokio::spawn(async move {
        let inner = job.clone();
        let opened = tokio::task::spawn_blocking(move || inner.roots.open(Path::new(&path))).await;
        match joined(opened) {
            Ok(entry) if cancel.cancelled() => {
                let _ = job.roots.take(entry.id());
                job.respond(id, Err(Error::Aborted));
            }
            Ok(entry) => {
                job.respond(id, Ok(Reply::Root { root: entry.id() }));
                // The index and the watcher both keep the root live: quick open stays right while
                // files change, and listings are invalidated whether or not a client is watching.
                start_watching(&entry, &job);
                entry.start_index();
            }
            Err(error) => job.respond(id, Err(error)),
        }
    });
}

/// Bring a root's watcher up in the background. A root that cannot be watched still lists,
/// searches and indexes, so this reports the failure and keeps going.
fn start_watching(entry: &Arc<RootEntry>, shared: &Shared) {
    let entry = Arc::clone(entry);
    let subscriptions = Arc::clone(&shared.subscriptions);
    let out = shared.out.clone();
    tokio::task::spawn_blocking(move || {
        if let Err(error) = entry.ensure_watcher(&subscriptions, &out) {
            eprintln!("ace-files: cannot watch root {}: {error}", entry.id());
        }
    });
}

/// `closeRoot`: claim the root, end its subscriptions and stop its index build, then release it.
///
/// The watcher's sink holds the last reference to the entry, so the entry is only really released
/// once the watcher is dropped: closing a root takes the watcher out of its slot and drops it on a
/// blocking thread, which joins the watcher's worker off the runtime. Closing a root twice is not
/// an error, since a daemon restart may retry it.
fn close_root(shared: &Shared, id: u64, root: u64) {
    let job = shared.clone();
    tokio::spawn(async move {
        let taken = job.roots.take(root);
        let result = match taken {
            Ok(Some(entry)) => {
                entry.close();
                match job.subscriptions.drop_root(root) {
                    Ok(()) => {
                        let released = tokio::task::spawn_blocking(move || {
                            drop(entry.take_watcher());
                            drop(entry);
                        })
                        .await;
                        match released {
                            Ok(()) => Ok(Reply::Done),
                            Err(error) => Err(worker_stopped(error)),
                        }
                    }
                    Err(error) => Err(error),
                }
            }
            Ok(None) => Ok(Reply::Done),
            Err(error) => Err(error),
        };
        job.respond(id, result);
    });
}

/// `unwatch`: close a watch or search subscription. An id that is already gone is not an error.
fn unwatch(shared: &Shared, id: u64, subscription: u64) {
    let job = shared.clone();
    tokio::spawn(async move {
        let result = job.subscriptions.remove(subscription).map(|_| Reply::Done);
        job.respond(id, result);
    });
}

/// `read`: metadata first, then the bytes as one body frame with the same id.
fn start_read(shared: &Shared, id: u64, cancel: Cancel, op: ReadOp) {
    let job = shared.clone();
    tokio::spawn(async move {
        let inner = job.clone();
        let work = tokio::task::spawn_blocking(move || ops::read_write::read(&inner, &cancel, &op));
        match joined(work.await) {
            Ok((meta, bytes)) => {
                job.requests.finish(id);
                job.out.send(Message::Response {
                    id,
                    result: Reply::Read(meta),
                });
                job.out.send_body(id, bytes);
            }
            Err(error) => job.respond(id, Err(error)),
        }
    });
}

/// `write` and `createFile`: take the body frame that follows the request, then save it.
fn start_write(shared: &Shared, id: u64, cancel: Cancel, op: WriteOp) {
    // Register before the dispatcher looks at the next frame: the body travels right behind the
    // request on the same pipe.
    let body = shared.bodies.wait(id);
    let job = shared.clone();
    tokio::spawn(async move {
        let bytes = tokio::select! {
            received = body => match received {
                Ok(bytes) => bytes,
                Err(_) => {
                    job.respond(id, Err(Error::InvalidArgument(
                        "the body frame of this request was lost".to_owned(),
                    )));
                    return;
                }
            },
            () = cancel.wait() => {
                let _ = job.bodies.forget(id);
                job.respond(id, Err(Error::Aborted));
                return;
            }
            () = tokio::time::sleep(BODY_TIMEOUT) => {
                let _ = job.bodies.forget(id);
                job.respond(id, Err(Error::InvalidArgument(format!(
                    "no body frame arrived within {} seconds",
                    BODY_TIMEOUT.as_secs()
                ))));
                return;
            }
        };
        if cancel.cancelled() {
            job.respond(id, Err(Error::Aborted));
            return;
        }
        let inner = job.clone();
        let work = tokio::task::spawn_blocking(move || ops::read_write::write(&inner, &op, &bytes));
        job.respond(id, joined(work.await));
    });
}

/// A blocking task's outcome, with a stopped thread reported as a system failure.
pub fn joined<T>(result: Result<Result<T, Error>, JoinError>) -> Result<T, Error> {
    match result {
        Ok(done) => done,
        Err(error) => Err(worker_stopped(error)),
    }
}

/// A worker that panicked or was cancelled; the request it served fails rather than hangs.
fn worker_stopped(error: JoinError) -> Error {
    Error::System(std::io::Error::other(format!(
        "an operation thread stopped: {error}"
    )))
}

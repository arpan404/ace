// SPDX-License-Identifier: Apache-2.0

//! A bench-only `files-wire` client: one child process, framed stdio, and its pid.
//!
//! The integration tests' client (`tests/common`) is built for assertions with 20 s deadlines.
//! A bench measures a million-file checkout that can take minutes and reads the process's memory,
//! so it owns its own small client:
//!
//! - one absolute deadline covers a request's write and its reply, and a frame the reader decoded
//!   after that deadline is refused;
//! - the reader timestamps a frame the moment `poll` returns it, and a read error, a frame that
//!   does not decode, a closed stdout and an unexpected body frame all fail the run at once;
//! - the reader's queue and the bench's own queue of skipped messages are bounded, so a watcher
//!   that talks faster than the bench is slowed rather than growing the bench;
//! - a write the binary never takes leaves the client in a terminal state instead of trying again,
//!   and shutdown kills and then waits a bounded time.

use std::collections::VecDeque;
use std::fmt;
use std::io::Write as _;
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::time::{Duration, Instant};

use files_wire::{Decoder, EventPayload, Frame, Message, Op, PROTOCOL, Reply, encode};

/// How long one request may wait for its reply, unless the phase it runs in ends sooner.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// Frames the reader may queue ahead of the bench before it slows the binary's stdout.
const BACKLOG: usize = 1024;

/// Messages the bench may keep aside while waiting for another one before it is out of step.
const PENDING: usize = 10_000;

/// How long the binary gets to exit once its stdin closes.
const GRACEFUL_SHUTDOWN: Duration = Duration::from_secs(10);

/// How long the binary gets to exit after a kill.
const KILLED_SHUTDOWN: Duration = Duration::from_secs(5);

/// A failed wire operation: what to show, and whether a deadline caused it.
#[derive(Debug, Clone)]
pub struct WireError {
    message: String,
    /// True when a deadline passed rather than the stream breaking.
    pub timed_out: bool,
}

impl WireError {
    /// A failure that is not a deadline: the stream broke or the binary said something wrong.
    pub fn failed(message: String) -> WireError {
        WireError {
            message,
            timed_out: false,
        }
    }

    fn timed_out(message: String) -> WireError {
        WireError {
            message,
            timed_out: true,
        }
    }
}

impl fmt::Display for WireError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for WireError {}

/// One decoded frame and the moment the reader decoded it.
struct Arrival {
    at: Instant,
    frame: Result<Frame, String>,
}

/// What one wait for the wire produced.
enum Received {
    /// A frame decoded at or before the wait's cutoff.
    Frame(Instant, Frame),
    /// A frame the reader decoded after the cutoff, so it is too late to count.
    Late,
    /// The reader could not decode the stream, or could not read it.
    Failed(WireError),
    /// No frame before the cutoff.
    TimedOut,
    /// The binary closed its stdout.
    Closed,
}

/// One stretch of the run with its own absolute deadline.
struct Phase {
    name: &'static str,
    deadline: Instant,
}

/// A running `ace-files` and the frames it sent that the bench has not read yet.
pub struct Wire {
    child: Child,
    /// Frames waiting to be written; dropping it closes the binary's stdin.
    outbox: Option<Sender<Vec<u8>>>,
    /// What the writer did with each frame it was handed.
    written: Receiver<std::io::Result<()>>,
    arrivals: Receiver<Arrival>,
    /// Messages that arrived while the bench was waiting for another one, with their decode times.
    pending: VecDeque<(Instant, Message)>,
    last_id: u64,
    phase: Option<Phase>,
    /// Set when the stream or the stdin can no longer be trusted; every later call reports it.
    dead: Option<WireError>,
}

impl Wire {
    /// Spawn the binary with its stdio piped, a thread decoding its stdout and a thread writing
    /// its stdin.
    pub fn start(binary: &Path) -> Result<Wire, WireError> {
        let mut command = Command::new(binary);
        command.stderr(Stdio::inherit());
        Wire::spawn(command)
    }

    /// [`Wire::start`] for a command the caller built, such as the binary wrapped in
    /// `/usr/bin/time`; the caller decides where its stderr goes.
    pub fn spawn(mut command: Command) -> Result<Wire, WireError> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|error| {
                WireError::failed(format!(
                    "cannot start {}: {error}",
                    command.get_program().to_string_lossy()
                ))
            })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| WireError::failed("the binary has no stdin pipe".to_owned()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| WireError::failed("the binary has no stdout pipe".to_owned()))?;
        let (sender, arrivals) = mpsc::sync_channel(BACKLOG);
        std::thread::spawn(move || read_frames(stdout, sender));
        let (outbox, queued) = mpsc::channel();
        let (written, results) = mpsc::channel();
        std::thread::spawn(move || write_frames(stdin, queued, written));
        Ok(Wire {
            child,
            outbox: Some(outbox),
            written: results,
            arrivals,
            pending: VecDeque::new(),
            last_id: 0,
            phase: None,
            dead: None,
        })
    }

    /// The process id, for `ps`.
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// Give the stretch that follows its own absolute deadline, so a phase that stops making
    /// progress fails instead of waiting out a request timeout per call.
    pub fn begin_phase(&mut self, name: &'static str, budget: Duration) {
        self.phase = Some(Phase {
            name,
            deadline: Instant::now() + budget,
        });
    }

    /// Say `hello` and check the answer.
    pub fn hello(&mut self) -> Result<(), WireError> {
        self.alive()?;
        let deadline = self.cutoff()?;
        self.send(
            &Message::Hello {
                protocol: 1,
                version: None,
            },
            deadline,
        )?;
        match self.incoming(deadline)?.1 {
            Message::Hello { protocol, .. } if protocol == PROTOCOL => Ok(()),
            other => Err(self.fail(format!("hello answered {other:?}"))),
        }
    }

    /// One request and its reply under one deadline: the write and the wait share it.
    pub fn ask(&mut self, op: Op) -> Result<Reply, WireError> {
        let deadline = self.cutoff()?;
        self.ask_before(op, deadline)
    }

    /// One request and its reply, never running past `deadline`, which also refuses a frame the
    /// reader decoded after it.
    pub fn ask_until(&mut self, op: Op, deadline: Instant) -> Result<Reply, WireError> {
        let deadline = deadline.min(self.cutoff()?);
        if deadline <= Instant::now() {
            return Err(WireError::timed_out(
                "no time left in the deadline to ask".to_owned(),
            ));
        }
        self.ask_before(op, deadline)
    }

    /// The next event of one subscription, if one arrives within `window`, with the moment the
    /// reader decoded it. A frame decoded after the cutoff does not count.
    pub fn try_event(
        &mut self,
        subscription: u64,
        window: Duration,
    ) -> Result<Option<(Instant, EventPayload)>, WireError> {
        self.alive()?;
        if let Some(position) = self.pending.iter().position(|(_, message)| {
            matches!(message, Message::Event { subscription: got, .. } if *got == subscription)
        }) && let Some((at, Message::Event { payload, .. })) = self.pending.remove(position)
        {
            return Ok(Some((at, payload)));
        }
        let deadline = self.cutoff()?.min(Instant::now() + window);
        loop {
            match self.receive(deadline) {
                Received::Frame(
                    at,
                    Frame::Message(Message::Event {
                        subscription: got,
                        payload,
                    }),
                ) if got == subscription => return Ok(Some((at, payload))),
                Received::Frame(at, Frame::Message(other)) => {
                    if self.pending.len() >= PENDING {
                        return Err(self.fail(format!(
                            "the bench kept {PENDING} messages aside and is out of step with the binary"
                        )));
                    }
                    self.pending.push_back((at, other));
                }
                Received::Frame(_, Frame::Body { id, .. }) => {
                    return Err(self.fail(unexpected_body(id)));
                }
                Received::Late | Received::TimedOut => return Ok(None),
                Received::Failed(error) => return Err(error),
                Received::Closed => {
                    return Err(self.fail(
                        "the binary closed its stdout while the bench waited for an event"
                            .to_owned(),
                    ));
                }
            }
        }
    }

    /// Close the binary's stdin, then wait a bounded time for it to exit, killing it if it does
    /// not, and waiting a bounded time again after the kill.
    pub fn stop(&mut self) {
        self.outbox.take();
        // A timed-out or broken write may leave the writer thread blocked, so stdin may never
        // close on its own: kill at once instead of waiting out the graceful window.
        if self.dead.is_some() {
            let _ = self.child.kill();
        }
        if self.wait_until(Instant::now() + GRACEFUL_SHUTDOWN) {
            return;
        }
        let _ = self.child.kill();
        if !self.wait_until(Instant::now() + KILLED_SHUTDOWN) {
            eprintln!(
                "checkout bench: ace-files {} did not exit after a kill",
                self.child.id()
            );
        }
    }

    /// One request and its reply before one absolute deadline.
    fn ask_before(&mut self, op: Op, deadline: Instant) -> Result<Reply, WireError> {
        self.alive()?;
        self.last_id += 1;
        let id = self.last_id;
        self.send(&Message::Request { id, op }, deadline)?;
        match self.take_matching(deadline, |message| match message {
            Message::Response { id: got, .. } | Message::Error { id: got, .. } => *got == id,
            _ => false,
        })? {
            Message::Response { result, .. } => Ok(result),
            Message::Error { code, message, .. } => Err(self.fail(format!("{code}: {message}"))),
            other => Err(self.fail(format!("expected a reply to {id}, got {other:?}"))),
        }
    }

    /// Refuse every call once the stream has broken.
    fn alive(&self) -> Result<(), WireError> {
        match &self.dead {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }

    /// Remember that the stream can no longer be trusted, and hand the error back.
    fn fail(&mut self, message: String) -> WireError {
        let error = WireError::failed(message);
        self.dead.get_or_insert_with(|| error.clone());
        error
    }

    /// The earlier of the request's budget and the phase's, refused once it has passed.
    fn cutoff(&self) -> Result<Instant, WireError> {
        let now = Instant::now();
        let deadline = match &self.phase {
            Some(phase) => (now + REQUEST_TIMEOUT).min(phase.deadline),
            None => now + REQUEST_TIMEOUT,
        };
        if deadline > now {
            return Ok(deadline);
        }
        Err(self.timeout())
    }

    /// What to say when the deadline passed with no frame.
    fn timeout(&self) -> WireError {
        WireError::timed_out(match &self.phase {
            Some(phase) => format!(
                "no frame from the binary before the {} phase's deadline",
                phase.name
            ),
            None => format!("no frame from the binary within {REQUEST_TIMEOUT:?}"),
        })
    }

    /// A message matching `wanted`: first from what has already arrived, then from the wire, all
    /// before one absolute `deadline`.
    fn take_matching(
        &mut self,
        deadline: Instant,
        mut wanted: impl FnMut(&Message) -> bool,
    ) -> Result<Message, WireError> {
        if let Some(position) = self.pending.iter().position(|(_, message)| wanted(message))
            && let Some((_, message)) = self.pending.remove(position)
        {
            return Ok(message);
        }
        loop {
            let (at, message) = self.incoming(deadline)?;
            if wanted(&message) {
                return Ok(message);
            }
            if self.pending.len() >= PENDING {
                return Err(self.fail(format!(
                    "the bench kept {PENDING} messages aside and is out of step with the binary"
                )));
            }
            self.pending.push_back((at, message));
        }
    }

    /// The next message decoded at or before `deadline`, with the moment it was decoded.
    fn incoming(&mut self, deadline: Instant) -> Result<(Instant, Message), WireError> {
        match self.receive(deadline) {
            Received::Frame(at, Frame::Message(message)) => Ok((at, message)),
            Received::Frame(_, Frame::Body { id, .. }) => Err(self.fail(unexpected_body(id))),
            Received::Late => Err(WireError::timed_out(
                "the binary's frame was decoded after the deadline".to_owned(),
            )),
            Received::Failed(error) => Err(error),
            Received::TimedOut => Err(self.timeout()),
            Received::Closed => Err(self.fail(closed())),
        }
    }

    /// Wait for one frame, or for the cutoff.
    fn receive(&mut self, deadline: Instant) -> Received {
        let wait = deadline.saturating_duration_since(Instant::now());
        match self.arrivals.recv_timeout(wait) {
            Ok(Arrival {
                frame: Err(error), ..
            }) => Received::Failed(WireError::failed(error)),
            Ok(Arrival {
                at,
                frame: Ok(frame),
            }) if at <= deadline => Received::Frame(at, frame),
            Ok(Arrival { .. }) => Received::Late,
            Err(RecvTimeoutError::Timeout) => Received::TimedOut,
            Err(RecvTimeoutError::Disconnected) => Received::Closed,
        }
    }

    /// Write one frame and wait, bounded, for the binary to take it.
    fn send(&mut self, message: &Message, deadline: Instant) -> Result<(), WireError> {
        self.alive()?;
        let frame = encode(message)
            .map_err(|error| self.fail(format!("cannot encode a message: {error}")))?;
        let outbox = match self.outbox.as_ref() {
            Some(outbox) => outbox,
            None => return Err(self.fail("the client's stdin is closed".to_owned())),
        };
        outbox.send(frame).map_err(|_| {
            self.fail("the writer stopped before the request was written".to_owned())
        })?;
        match self
            .written
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(self.fail(format!("cannot write to the binary: {error}"))),
            Err(RecvTimeoutError::Timeout) => {
                let detail = match &self.phase {
                    Some(phase) => format!(" of the {} phase", phase.name),
                    None => String::new(),
                };
                let error = WireError::timed_out(format!(
                    "the binary stopped reading its stdin before the deadline{detail}"
                ));
                self.dead.get_or_insert_with(|| error.clone());
                Err(error)
            }
            Err(RecvTimeoutError::Disconnected) => {
                Err(self.fail("the writer stopped before the request was written".to_owned()))
            }
        }
    }

    /// Wait for the child to exit, at most until `deadline`.
    fn wait_until(&mut self, deadline: Instant) -> bool {
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => return true,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                _ => return false,
            }
        }
    }
}

impl Drop for Wire {
    fn drop(&mut self) {
        self.stop();
    }
}

/// What the bench says when the binary's stdout closed under it.
fn closed() -> String {
    "the binary closed its stdout without a reply".to_owned()
}

/// What the bench says about a body frame: it never asks for one.
fn unexpected_body(id: u64) -> String {
    format!("the binary sent a body frame for request {id}, which the bench never asks for")
}

/// Read the binary's stdout until it closes, decoding and timestamping each frame.
fn read_frames(mut stdout: impl std::io::Read, sender: SyncSender<Arrival>) {
    let mut decoder = Decoder::new();
    let mut chunk = [0u8; 256 * 1024];
    loop {
        match stdout.read(&mut chunk) {
            Ok(0) => return,
            Ok(read) => {
                decoder.push(&chunk[..read]);
                loop {
                    match decoder.poll() {
                        Ok(Some(frame)) => {
                            let at = Instant::now();
                            if sender
                                .send(Arrival {
                                    at,
                                    frame: Ok(frame),
                                })
                                .is_err()
                            {
                                return;
                            }
                        }
                        Ok(None) => break,
                        Err(error) => {
                            let _ = sender.send(Arrival {
                                at: Instant::now(),
                                frame: Err(format!("the binary's stdout did not decode: {error}")),
                            });
                            return;
                        }
                    }
                }
            }
            Err(error) => {
                let _ = sender.send(Arrival {
                    at: Instant::now(),
                    frame: Err(format!("cannot read the binary's stdout: {error}")),
                });
                return;
            }
        }
    }
}

/// Write frames to the binary's stdin, reporting each write so the caller can bound its wait.
fn write_frames(
    mut stdin: ChildStdin,
    queued: Receiver<Vec<u8>>,
    written: Sender<std::io::Result<()>>,
) {
    while let Ok(frame) = queued.recv() {
        let result = stdin.write_all(&frame).and_then(|()| stdin.flush());
        let failed = result.is_err();
        if written.send(result).is_err() || failed {
            return;
        }
    }
    // Dropping stdin here closes the binary's stdin, which is how the bench asks it to exit.
}

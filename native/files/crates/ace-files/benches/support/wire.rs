// SPDX-License-Identifier: Apache-2.0

//! A bench-only `files-wire` client: one child process, framed stdio, and its pid.
//!
//! The integration tests' client (`tests/common`) is built for assertions with 20 s deadlines.
//! A bench measures a million-file checkout that can take minutes and reads the process's memory,
//! so it owns its own small client: the reader timestamps a frame when it decodes it, every wait
//! has an absolute deadline (the request's, or the phase's when that is sooner), and a write to a
//! stdin the binary stopped reading fails instead of blocking forever.
//!
//! A broken stream surfaces at once: a read error or a frame that does not decode ends the reader
//! with that error, a closed stdout is reported as a disconnect, and a body frame is refused
//! because no request in this bench asks for one.

use std::collections::VecDeque;
use std::io::Write as _;
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use files_wire::{Decoder, EventPayload, Frame, Message, Op, PROTOCOL, Reply, encode};

/// How long one request may wait for its reply, unless the phase it runs in ends sooner.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// How long the binary gets to exit once its stdin closes.
const GRACEFUL_SHUTDOWN: Duration = Duration::from_secs(10);

/// How long the binary gets to exit after a kill.
const KILLED_SHUTDOWN: Duration = Duration::from_secs(5);

/// One decoded frame and the moment the reader decoded it.
struct Arrival {
    at: Instant,
    frame: Result<Frame, String>,
}

/// What one wait for the wire produced.
enum Received {
    /// A frame, with the moment the reader decoded it.
    Frame(Instant, Frame),
    /// The reader could not decode the stream, or could not read it.
    Failed(String),
    /// The wait's deadline passed with no frame.
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
}

impl Wire {
    /// Spawn the binary with its stdio piped, a thread decoding its stdout and a thread writing
    /// its stdin.
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
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "the binary has no stdout pipe".to_owned())?;
        let (sender, arrivals) = mpsc::channel();
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
    pub fn hello(&mut self) -> Result<(), String> {
        let deadline = self.deadline()?;
        self.send(&Message::Hello {
            protocol: 1,
            version: None,
        })?;
        match self.incoming(deadline)?.1 {
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
        let deadline = self.deadline()?;
        match self.take_matching(deadline, |message| match message {
            Message::Response { id: got, .. } | Message::Error { id: got, .. } => *got == id,
            _ => false,
        })? {
            Message::Response { result, .. } => Ok(result),
            Message::Error { code, message, .. } => Err(format!("{code}: {message}")),
            other => Err(format!("expected a reply to {id}, got {other:?}")),
        }
    }

    /// The next event of one subscription, if one arrives within `window`, with the moment the
    /// reader decoded it.
    pub fn try_event(
        &mut self,
        subscription: u64,
        window: Duration,
    ) -> Result<Option<(Instant, EventPayload)>, String> {
        if let Some(position) = self.pending.iter().position(|(_, message)| {
            matches!(message, Message::Event { subscription: got, .. } if *got == subscription)
        }) && let Some((at, Message::Event { payload, .. })) = self.pending.remove(position)
        {
            return Ok(Some((at, payload)));
        }
        let deadline = self.deadline()?.min(Instant::now() + window);
        loop {
            match self.receive(deadline) {
                Received::Frame(
                    at,
                    Frame::Message(Message::Event {
                        subscription: got,
                        payload,
                    }),
                ) if got == subscription => return Ok(Some((at, payload))),
                Received::Frame(at, Frame::Message(other)) => self.pending.push_back((at, other)),
                Received::Frame(_, Frame::Body { id, .. }) => {
                    return Err(unexpected_body(id));
                }
                Received::Failed(error) => return Err(error),
                Received::TimedOut => return Ok(None),
                Received::Closed => {
                    return Err(
                        "the binary closed its stdout while the bench waited for an event"
                            .to_owned(),
                    );
                }
            }
        }
    }

    /// Close the binary's stdin, then wait a bounded time for it to exit, killing it if it does
    /// not, and waiting a bounded time again after the kill.
    pub fn stop(&mut self) {
        self.outbox.take();
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

    /// The earlier of the request's budget and the phase's, refused once it has passed.
    fn deadline(&self) -> Result<Instant, String> {
        let now = Instant::now();
        let deadline = match &self.phase {
            Some(phase) => (now + REQUEST_TIMEOUT).min(phase.deadline),
            None => now + REQUEST_TIMEOUT,
        };
        if deadline > now {
            return Ok(deadline);
        }
        Err(match &self.phase {
            Some(phase) if phase.deadline <= now => {
                format!("the {} phase is past its deadline", phase.name)
            }
            _ => format!("the request's {REQUEST_TIMEOUT:?} budget is spent"),
        })
    }

    /// A message matching `wanted`: first from what has already arrived, then from the wire, all
    /// before one absolute `deadline`.
    fn take_matching(
        &mut self,
        deadline: Instant,
        mut wanted: impl FnMut(&Message) -> bool,
    ) -> Result<Message, String> {
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
            self.pending.push_back((at, message));
        }
    }

    /// The next message, with the moment it was decoded.
    fn incoming(&mut self, deadline: Instant) -> Result<(Instant, Message), String> {
        match self.receive(deadline) {
            Received::Frame(at, Frame::Message(message)) => Ok((at, message)),
            Received::Frame(_, Frame::Body { id, .. }) => Err(unexpected_body(id)),
            Received::Failed(error) => Err(error),
            Received::TimedOut => Err(self.no_frame()),
            Received::Closed => Err(closed()),
        }
    }

    /// Wait for one frame or for the deadline.
    fn receive(&mut self, deadline: Instant) -> Received {
        let wait = deadline.saturating_duration_since(Instant::now());
        match self.arrivals.recv_timeout(wait) {
            Ok(Arrival {
                at,
                frame: Ok(frame),
            }) => Received::Frame(at, frame),
            Ok(Arrival {
                frame: Err(error), ..
            }) => Received::Failed(error),
            Err(RecvTimeoutError::Timeout) => Received::TimedOut,
            Err(RecvTimeoutError::Disconnected) => Received::Closed,
        }
    }

    /// What to say when the deadline passed with no frame.
    fn no_frame(&self) -> String {
        match &self.phase {
            Some(phase) => format!(
                "no frame from the binary before the {} phase's deadline",
                phase.name
            ),
            None => format!("no frame from the binary within {REQUEST_TIMEOUT:?}"),
        }
    }

    /// Write one frame and wait, bounded, for the binary to take it.
    fn send(&mut self, message: &Message) -> Result<(), String> {
        let frame = encode(message).map_err(|error| format!("cannot encode a message: {error}"))?;
        let deadline = self.deadline()?;
        let outbox = self
            .outbox
            .as_ref()
            .ok_or_else(|| "the client's stdin is closed".to_owned())?;
        outbox
            .send(frame)
            .map_err(|_| "the writer stopped before the request was written".to_owned())?;
        match self
            .written
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(format!("cannot write to the binary: {error}")),
            Err(RecvTimeoutError::Timeout) => Err(format!(
                "the binary did not read its stdin before the deadline{}",
                self.phase
                    .as_ref()
                    .map(|phase| format!(" of the {} phase", phase.name))
                    .unwrap_or_default()
            )),
            Err(RecvTimeoutError::Disconnected) => {
                Err("the writer stopped before the request was written".to_owned())
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
fn read_frames(mut stdout: impl std::io::Read, sender: Sender<Arrival>) {
    let mut decoder = Decoder::new();
    let mut chunk = [0u8; 256 * 1024];
    loop {
        match stdout.read(&mut chunk) {
            Ok(0) => return,
            Ok(read) => {
                decoder.push(&chunk[..read]);
                loop {
                    let at = Instant::now();
                    match decoder.poll() {
                        Ok(Some(frame)) => {
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
                                at,
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

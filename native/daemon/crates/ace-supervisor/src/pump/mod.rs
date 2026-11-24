// SPDX-License-Identifier: Apache-2.0
//! Moving bytes between a child's pipes and the shell, with node's flow:
//! an output pump keeps at most `MAX_IN_FLIGHT` chunks queued toward the
//! shell; once the shell's stream is full it reads on only up to
//! `PAUSED_READ_BYTES` more (which the stream buffers), so a pipe that ends
//! while nobody reads still reaches EOF and `close`, and a child writing
//! more is held back. It stops when the shell destroys the stream. Stdin
//! writes reach the pipe in order, EOF last, each acknowledged once written.

use crate::errors::NodeIoError;
use crate::spawn::{Delivered, EventSink, OutputStream};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

/// Chunks one output may have queued toward the shell before it waits.
pub const MAX_IN_FLIGHT: usize = 4;
/// The most bytes one read hands the shell.
pub const CHUNK_BYTES: usize = 65_536;
/// How much the process's pumps together read ahead of full shell streams,
/// at most: never past what is left of the process's output budget.
pub const PAUSED_READ_BYTES: usize = 1_048_576;
/// How often a pump at its paused allowance checks whether the pipe hung up.
const HANGUP_POLL: std::time::Duration = std::time::Duration::from_millis(50);

/// What the process's outputs share: its output budget
/// (`maxOutputBytes`), the read-ahead pool both pumps draw on while their
/// shell streams are full, and whether every writer is known gone. A read is
/// reserved against both before it is made and settled after, under one
/// lock, so the two pumps together never overshoot either.
#[derive(Default)]
pub struct OutputBudget {
    limit: Option<u64>,
    shared: Mutex<Shared>,
    /// Every process that could write is gone (Windows: the job emptied).
    writers_gone: std::sync::atomic::AtomicBool,
}

#[derive(Default)]
struct Shared {
    /// Bytes read or reserved, both pumps together.
    read: u64,
    /// Bytes read or reserved while their stream was full.
    ahead: usize,
}

/// How a read is admitted.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Admit {
    /// The shell's stream wants more: a whole chunk, counted.
    Flowing,
    /// The stream is full: within the read-ahead pool and the budget.
    Ahead,
    /// The stream is full and every writer is gone: within the budget.
    Draining,
}

impl OutputBudget {
    pub fn new(limit: Option<u64>) -> Arc<Self> {
        Arc::new(Self {
            limit,
            ..Self::default()
        })
    }

    /// Every writer is gone: what is buffered in the pipes is all there is.
    pub fn mark_writers_gone(&self) {
        self.writers_gone
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    fn writers_gone(&self) -> bool {
        self.writers_gone.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Reserves up to `want` bytes for one read; zero when nothing may be.
    fn reserve(&self, want: usize, admit: Admit) -> usize {
        let Ok(mut shared) = self.shared.lock() else {
            return 0;
        };
        let budget = match self.limit {
            None => usize::MAX,
            Some(limit) => usize::try_from(limit.saturating_sub(shared.read)).unwrap_or(usize::MAX),
        };
        let grant = match admit {
            Admit::Flowing => want,
            Admit::Draining => want.min(budget),
            Admit::Ahead => want
                .min(budget)
                .min(PAUSED_READ_BYTES.saturating_sub(shared.ahead)),
        };
        shared.read = shared
            .read
            .saturating_add(u64::try_from(grant).unwrap_or(u64::MAX));
        if admit != Admit::Flowing {
            shared.ahead += grant;
        }
        grant
    }

    /// Settles a reservation: what the read did not use goes back.
    fn settle(&self, granted: usize, used: usize, admit: Admit) {
        let unused = granted.saturating_sub(used);
        if let Ok(mut shared) = self.shared.lock() {
            shared.read = shared
                .read
                .saturating_sub(u64::try_from(unused).unwrap_or(u64::MAX));
            if admit != Admit::Flowing {
                shared.ahead = shared.ahead.saturating_sub(unused);
            }
        }
    }

    /// Returns read-ahead the shell took up (or dropped with its stream).
    fn give_back_ahead(&self, bytes: usize) {
        if let Ok(mut shared) = self.shared.lock() {
            shared.ahead = shared.ahead.saturating_sub(bytes);
        }
    }
}

/// One output's flow state, shared by its pump and the shell's stream.
pub struct Flow {
    state: Mutex<FlowState>,
    changed: Notify,
    closed: CancellationToken,
    budget: Arc<OutputBudget>,
    /// A diverted child's consumer hears `end` when the flow closes too, not
    /// only at EOF; unset for every stream the shell owns.
    end_on_close: std::sync::atomic::AtomicBool,
}

#[derive(Default)]
struct FlowState {
    in_flight: usize,
    paused: bool,
    /// Bytes read since the shell's stream filled.
    paused_bytes: usize,
    /// The pipe hung up: what is left in it is read past the allowance, so
    /// EOF (and `close`) arrive though nobody reads.
    draining: bool,
}

impl Flow {
    pub fn new(budget: Arc<OutputBudget>) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(FlowState::default()),
            changed: Notify::new(),
            closed: CancellationToken::new(),
            budget,
            end_on_close: std::sync::atomic::AtomicBool::new(false),
        })
    }

    /// The shell's stream is full: from now on reads draw on the shared
    /// read-ahead pool, until `resume`.
    pub fn pause(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.paused = true;
        }
    }

    /// The shell's stream wants more: what it read ahead goes back to the pool.
    pub fn resume(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.paused = false;
        }
        self.give_back();
        self.changed.notify_one();
    }

    /// Returns this stream's read-ahead to the shared pool: it was taken up,
    /// or the stream is done.
    fn give_back(&self) {
        if let Ok(mut state) = self.state.lock() {
            let returned = std::mem::take(&mut state.paused_bytes);
            self.budget.give_back_ahead(returned);
        }
    }

    /// The shell's stream is gone: the pump stops and closes its pipe end.
    pub fn close(&self) {
        self.closed.cancel();
        self.give_back();
    }

    /// A diverted child's consumer keeps hearing `end` when the flow closes:
    /// `OutputControl::close` sets this before it calls `close` (E3.0b).
    pub(crate) fn mark_end_on_close(&self) {
        self.end_on_close
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// Whether a closed pump still emits `end` before it returns.
    fn ends_on_close(&self) -> bool {
        self.end_on_close.load(std::sync::atomic::Ordering::SeqCst)
    }

    pub(crate) fn delivered(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.in_flight = state.in_flight.saturating_sub(1);
        }
        self.changed.notify_one();
    }

    /// Takes a slot and reserves one read: its size and how it was
    /// admitted, or `None` while chunks are queued to the limit or nothing
    /// may be read ahead.
    fn admit(&self) -> Option<(usize, Admit)> {
        let mut state = self.state.lock().ok()?;
        if state.in_flight >= MAX_IN_FLIGHT {
            return None;
        }
        let admit = if !state.paused {
            Admit::Flowing
        } else if state.draining {
            Admit::Draining
        } else {
            Admit::Ahead
        };
        let grant = self.budget.reserve(CHUNK_BYTES, admit);
        if grant == 0 {
            return None;
        }
        state.in_flight += 1;
        Some((grant, admit))
    }

    /// Settles a read: unused reservation goes back; bytes read ahead count
    /// against this stream until the shell takes them up.
    fn read(&self, granted: usize, used: usize, admit: Admit) {
        self.budget.settle(granted, used, admit);
        if admit != Admit::Flowing
            && let Ok(mut state) = self.state.lock()
        {
            state.paused_bytes += used;
        }
    }

    /// Whether the pump waits on the read-ahead alone (no chunk of its own
    /// queued): then only a hangup can let it read on, or end the stream.
    fn at_paused_cap(&self) -> bool {
        self.state
            .lock()
            .is_ok_and(|state| state.paused && state.in_flight < MAX_IN_FLIGHT)
    }

    fn drain(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.draining = true;
        }
    }

    /// Gives back a slot taken for a read that produced nothing.
    fn release(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.in_flight = state.in_flight.saturating_sub(1);
        }
    }
}

/// Forwards `reader` as output events until EOF or a read error (then the
/// stream ends, on its own, like a node socket), or until the shell closes
/// the stream. Dropping `reader` on return closes the pipe.
pub async fn pump_output<E: EventSink, R: tokio::io::AsyncRead + Unpin + HangUp>(
    sink: &E,
    mut reader: R,
    stream: OutputStream,
    flow: Arc<Flow>,
) {
    let mut buffer = vec![0u8; CHUNK_BYTES];
    loop {
        let (room, admit) = loop {
            if let Some(admitted) = flow.admit() {
                break admitted;
            }
            let at_cap = flow.at_paused_cap();
            tokio::select! {
                () = flow.changed.notified() => {}
                () = flow.closed.cancelled() => {
                    // A diverted child's consumer still hears `end` (E3.0b).
                    if flow.ends_on_close() {
                        sink.end(stream);
                    }
                    return;
                }
                // At the cap: probe the pipe without consuming. Hung up with
                // nothing left is EOF; hung up with bytes left drains them
                // within the budget.
                () = tokio::time::sleep(HANGUP_POLL), if at_cap => {
                    if reader.at_eof() {
                        sink.end(stream);
                        return;
                    }
                    if reader.hung_up() || flow.budget.writers_gone() {
                        flow.drain();
                    }
                }
            }
        };
        let read = tokio::select! {
            read = reader.read(&mut buffer[..room]) => read,
            () = flow.closed.cancelled() => {
                flow.read(room, 0, admit);
                if flow.ends_on_close() {
                    sink.end(stream);
                }
                return;
            }
        };
        match read {
            Ok(0) | Err(_) => {
                flow.read(room, 0, admit);
                flow.release();
                sink.end(stream);
                return;
            }
            Ok(n) => {
                flow.read(room, n, admit);
                sink.output(
                    stream,
                    buffer[..n].to_vec(),
                    Delivered::new(Arc::clone(&flow)),
                );
            }
        }
    }
}

mod hangup;
pub use hangup::HangUp;

/// What the shell queues for stdin, in its order.
pub enum StdinMessage {
    Write(Vec<u8>),
    /// EOF, after every write queued before it.
    End,
}

/// Writes queued stdin in order; each write is acknowledged once it is in
/// the pipe. `End`, the shell dropping its sender, or `abort` (the shell
/// destroyed the stream) closes the pipe, which a CLI reads as EOF.
pub async fn pump_stdin<E: EventSink, W: tokio::io::AsyncWrite + Unpin>(
    sink: &E,
    mut stdin: W,
    mut queue: tokio::sync::mpsc::UnboundedReceiver<StdinMessage>,
    abort: CancellationToken,
) {
    loop {
        let message = tokio::select! {
            message = queue.recv() => message,
            () = abort.cancelled() => return,
        };
        let Some(StdinMessage::Write(bytes)) = message else {
            return;
        };
        // The write is acknowledged once the kernel took every byte (on
        // Windows, once the overlapped write completed), never before.
        let written = tokio::select! {
            written = async {
                stdin.write_all(&bytes).await?;
                stdin.flush().await
            } => written,
            () = abort.cancelled() => return,
        };
        match written {
            Ok(()) => sink.stdin_written(),
            Err(error) => {
                sink.stdin_error(NodeIoError::new("write", &error));
                return;
            }
        }
    }
}

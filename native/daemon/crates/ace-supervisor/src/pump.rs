// SPDX-License-Identifier: Apache-2.0
//! Moving bytes between a child's pipes and the shell, with node's flow:
//! an output pump keeps at most `MAX_IN_FLIGHT` chunks queued toward the
//! shell; once the shell's stream is full it reads on only up to
//! `PAUSED_READ_BYTES` more (which the stream buffers), so a pipe that ends
//! while nobody reads still reaches EOF and `close`, and a child writing
//! more is held back. It stops when the shell destroys the stream. Stdin
//! writes reach the pipe in order, EOF last, each acknowledged once written.

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
/// shell streams are full, and whether every writer is known gone.
#[derive(Default)]
pub struct OutputBudget {
    limit: Option<u64>,
    read: std::sync::atomic::AtomicU64,
    /// Bytes read while their stream was full, both pumps together.
    ahead: std::sync::atomic::AtomicUsize,
    /// Every process that could write is gone (Windows: the job emptied).
    writers_gone: std::sync::atomic::AtomicBool,
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

    fn ahead_room(&self) -> usize {
        PAUSED_READ_BYTES
            .saturating_sub(self.ahead.load(std::sync::atomic::Ordering::Relaxed))
            .min(self.remaining())
    }

    fn remaining(&self) -> usize {
        match self.limit {
            None => usize::MAX,
            Some(limit) => {
                let read = self.read.load(std::sync::atomic::Ordering::Relaxed);
                usize::try_from(limit.saturating_sub(read)).unwrap_or(usize::MAX)
            }
        }
    }

    fn count(&self, bytes: usize) {
        self.read.fetch_add(
            u64::try_from(bytes).unwrap_or(u64::MAX),
            std::sync::atomic::Ordering::Relaxed,
        );
    }
}

/// One output's flow state, shared by its pump and the shell's stream.
pub struct Flow {
    state: Mutex<FlowState>,
    changed: Notify,
    closed: CancellationToken,
    budget: Arc<OutputBudget>,
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
            self.budget
                .ahead
                .fetch_sub(returned, std::sync::atomic::Ordering::Relaxed);
        }
    }

    /// The shell's stream is gone: the pump stops and closes its pipe end.
    pub fn close(&self) {
        self.closed.cancel();
        self.give_back();
    }

    pub(crate) fn delivered(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.in_flight = state.in_flight.saturating_sub(1);
        }
        self.changed.notify_one();
    }

    /// Takes a slot for one chunk: how many bytes it may read, or `None`
    /// while chunks are queued to the limit or the paused allowance (within
    /// the output budget) is spent.
    fn admit(&self) -> Option<usize> {
        let mut state = self.state.lock().ok()?;
        if state.in_flight >= MAX_IN_FLIGHT {
            return None;
        }
        let room = if !state.paused {
            CHUNK_BYTES
        } else if state.draining {
            // The writer is gone: the rest is bounded, but still budgeted.
            CHUNK_BYTES.min(self.budget.remaining())
        } else {
            self.budget.ahead_room()
        };
        if room == 0 {
            return None;
        }
        state.in_flight += 1;
        Some(room.min(CHUNK_BYTES))
    }

    /// Counts a read against the budget, and against the allowance while
    /// the shell's stream is full.
    fn read(&self, bytes: usize) {
        self.budget.count(bytes);
        if let Ok(mut state) = self.state.lock()
            && state.paused
        {
            state.paused_bytes += bytes;
            self.budget
                .ahead
                .fetch_add(bytes, std::sync::atomic::Ordering::Relaxed);
        }
    }

    /// Whether the pump waits on the paused allowance alone (no chunk of its
    /// own queued): then only a hangup can let it read on.
    fn at_paused_cap(&self) -> bool {
        self.state
            .lock()
            .is_ok_and(|state| state.paused && !state.draining && state.in_flight < MAX_IN_FLIGHT)
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
        let room = loop {
            if let Some(room) = flow.admit() {
                break room;
            }
            let at_cap = flow.at_paused_cap();
            tokio::select! {
                () = flow.changed.notified() => {}
                () = flow.closed.cancelled() => return,
                // At the allowance: look for a hangup without consuming.
                () = tokio::time::sleep(HANGUP_POLL), if at_cap => {
                    if reader.hung_up() || flow.budget.writers_gone() {
                        flow.drain();
                    }
                }
            }
        };
        let read = tokio::select! {
            read = reader.read(&mut buffer[..room]) => read,
            () = flow.closed.cancelled() => return,
        };
        match read {
            Ok(0) | Err(_) => {
                flow.release();
                sink.end(stream);
                return;
            }
            Ok(n) => {
                flow.read(n);
                sink.output(
                    stream,
                    buffer[..n].to_vec(),
                    Delivered::new(Arc::clone(&flow)),
                );
            }
        }
    }
}

/// A pipe end that can tell, without reading, that its writer is gone.
pub trait HangUp {
    fn hung_up(&self) -> bool;
}

/// POSIX: `poll` reports POLLHUP once every writer has closed; nothing is
/// read, so buffered bytes stay for the shell.
#[cfg(unix)]
fn fd_hung_up(fd: std::os::fd::BorrowedFd<'_>) -> bool {
    use rustix::event::{PollFd, PollFlags, Timespec, poll};
    let mut fds = [PollFd::new(&fd, PollFlags::IN)];
    let now = Timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    matches!(poll(&mut fds, Some(&now)), Ok(n) if n > 0)
        && fds[0].revents().contains(PollFlags::HUP)
}

#[cfg(unix)]
impl HangUp for tokio::process::ChildStdout {
    fn hung_up(&self) -> bool {
        use std::os::fd::AsFd as _;
        fd_hung_up(self.as_fd())
    }
}

#[cfg(unix)]
impl HangUp for tokio::process::ChildStderr {
    fn hung_up(&self) -> bool {
        use std::os::fd::AsFd as _;
        fd_hung_up(self.as_fd())
    }
}

/// Windows: `PeekNamedPipe` reads nothing; a broken pipe with no bytes
/// left is the hangup. Bytes still buffered after the writer left read as
/// not hung up, so that stream waits for its reader.
#[cfg(windows)]
impl HangUp for tokio::net::windows::named_pipe::NamedPipeServer {
    #[allow(unsafe_code)]
    fn hung_up(&self) -> bool {
        use std::os::windows::io::AsRawHandle as _;
        use windows_sys::Win32::Foundation::{ERROR_BROKEN_PIPE, GetLastError};
        use windows_sys::Win32::System::Pipes::PeekNamedPipe;
        let mut available = 0u32;
        // SAFETY: the handle is this live server end; no buffer is passed
        // and `available` is an owned local, so nothing is read or moved.
        let peeked = unsafe {
            PeekNamedPipe(
                self.as_raw_handle(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut available,
                std::ptr::null_mut(),
            )
        };
        // SAFETY: reads this thread's error slot right after the call.
        peeked == 0 && unsafe { GetLastError() } == ERROR_BROKEN_PIPE
    }
}

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
                sink.stdin_error(error.to_string());
                return;
            }
        }
    }
}

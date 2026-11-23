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
/// How much more a pump reads once the shell's stream is full.
pub const PAUSED_READ_BYTES: usize = 1_048_576;

/// One output's flow state, shared by its pump and the shell's stream.
pub struct Flow {
    state: Mutex<FlowState>,
    changed: Notify,
    closed: CancellationToken,
}

#[derive(Default)]
struct FlowState {
    in_flight: usize,
    paused: bool,
    /// Bytes read since the shell's stream filled.
    paused_bytes: usize,
}

impl Flow {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(FlowState::default()),
            changed: Notify::new(),
            closed: CancellationToken::new(),
        })
    }

    /// The shell's stream is full: read at most `PAUSED_READ_BYTES` more
    /// until `resume`.
    pub fn pause(&self) {
        if let Ok(mut state) = self.state.lock()
            && !state.paused
        {
            state.paused = true;
            state.paused_bytes = 0;
        }
    }

    /// The shell's stream wants more.
    pub fn resume(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.paused = false;
        }
        self.changed.notify_one();
    }

    /// The shell's stream is gone: the pump stops and closes its pipe end.
    pub fn close(&self) {
        self.closed.cancel();
    }

    pub(crate) fn delivered(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.in_flight = state.in_flight.saturating_sub(1);
        }
        self.changed.notify_one();
    }

    /// Takes a slot for one chunk: how many bytes it may read, or `None`
    /// while chunks are queued to the limit or the paused budget is spent.
    fn admit(&self) -> Option<usize> {
        let mut state = self.state.lock().ok()?;
        if state.in_flight >= MAX_IN_FLIGHT {
            return None;
        }
        let room = if state.paused {
            PAUSED_READ_BYTES.saturating_sub(state.paused_bytes)
        } else {
            CHUNK_BYTES
        };
        if room == 0 {
            return None;
        }
        state.in_flight += 1;
        Some(room.min(CHUNK_BYTES))
    }

    /// Counts a read made while the shell's stream is full.
    fn read(&self, bytes: usize) {
        if let Ok(mut state) = self.state.lock()
            && state.paused
        {
            state.paused_bytes += bytes;
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
pub async fn pump_output<E: EventSink, R: tokio::io::AsyncRead + Unpin>(
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
            tokio::select! {
                () = flow.changed.notified() => {}
                () = flow.closed.cancelled() => return,
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

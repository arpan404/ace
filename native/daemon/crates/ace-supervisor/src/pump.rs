// SPDX-License-Identifier: Apache-2.0
//! Moving bytes between a child's pipes and the shell, with node's flow:
//! an output pump reads only while the shell's stream wants more (at most
//! `MAX_IN_FLIGHT` chunks queued toward it, none while it is full), stops
//! when the shell destroys the stream, and stdin writes reach the pipe in
//! order, EOF last, each acknowledged only once written.

use crate::spawn::{Delivered, EventSink, OutputStream};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

/// Chunks one output may have queued toward the shell before it waits.
pub const MAX_IN_FLIGHT: usize = 4;
/// The most bytes one read hands the shell.
pub const CHUNK_BYTES: usize = 65_536;

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
}

impl Flow {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(FlowState::default()),
            changed: Notify::new(),
            closed: CancellationToken::new(),
        })
    }

    /// The shell's stream is full: read nothing more until `resume`.
    pub fn pause(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.paused = true;
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

    /// Takes a slot for one chunk; false while full or paused.
    fn admit(&self) -> bool {
        match self.state.lock() {
            Ok(mut state) if !state.paused && state.in_flight < MAX_IN_FLIGHT => {
                state.in_flight += 1;
                true
            }
            _ => false,
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
        while !flow.admit() {
            tokio::select! {
                () = flow.changed.notified() => {}
                () = flow.closed.cancelled() => return,
            }
        }
        let read = tokio::select! {
            read = reader.read(&mut buffer) => read,
            () = flow.closed.cancelled() => return,
        };
        match read {
            Ok(0) | Err(_) => {
                flow.release();
                sink.end(stream);
                return;
            }
            Ok(n) => sink.output(
                stream,
                buffer[..n].to_vec(),
                Delivered::new(Arc::clone(&flow)),
            ),
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

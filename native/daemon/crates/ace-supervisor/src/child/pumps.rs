// SPDX-License-Identifier: Apache-2.0
//! Starting a child's pumps: output pumps with their flows, and stdin (an
//! async pump on POSIX, a completion-waiting writer thread on Windows).

use super::StdinAbort;
#[cfg(unix)]
use crate::pump::pump_stdin;
use crate::pump::{Flow, StdinMessage, pump_output};
use crate::spawn::{EventSink, OutputStream};
use std::sync::Arc;
#[cfg(unix)]
use tokio_util::sync::CancellationToken;

/// Ace's end of one pipe: ready once it can carry bytes. A Windows server
/// end waits for its client (already connected when the child spawned).
pub(crate) trait PipeEnd: Send + Unpin + 'static {
    fn connected(&self) -> impl std::future::Future<Output = bool> + Send;
}

#[cfg(unix)]
impl PipeEnd for tokio::process::ChildStdin {
    async fn connected(&self) -> bool {
        true
    }
}

#[cfg(unix)]
impl PipeEnd for tokio::process::ChildStdout {
    async fn connected(&self) -> bool {
        true
    }
}

#[cfg(unix)]
impl PipeEnd for tokio::process::ChildStderr {
    async fn connected(&self) -> bool {
        true
    }
}

/// Starts the POSIX stdin pump.
#[cfg(unix)]
pub(super) fn start_stdin<E: EventSink + Clone>(
    runtime: &tokio::runtime::Handle,
    sink: &E,
    pipe: tokio::process::ChildStdin,
    received: tokio::sync::mpsc::UnboundedReceiver<StdinMessage>,
) -> StdinAbort {
    let abort = CancellationToken::new();
    let (task_sink, task_abort) = (sink.clone(), abort.clone());
    runtime.spawn(async move {
        if pipe.connected().await {
            pump_stdin(&task_sink, pipe, received, task_abort).await;
        }
    });
    StdinAbort::Token(abort)
}

/// Starts the Windows stdin writer on a thread of its own: its writes wait
/// for completion, which no async task should block on.
#[cfg(windows)]
pub(super) fn start_stdin<E: EventSink + Clone>(
    _runtime: &tokio::runtime::Handle,
    sink: &E,
    pipe: crate::winstdin::StdinPipe,
    received: tokio::sync::mpsc::UnboundedReceiver<StdinMessage>,
) -> StdinAbort {
    let pipe = Arc::new(pipe);
    let (writer, task_sink) = (Arc::clone(&pipe), sink.clone());
    let started = std::thread::Builder::new()
        .name("ace-supervisor-stdin".to_owned())
        .spawn(move || writer.run(&task_sink, received));
    if started.is_err() {
        // No writer: stdin closes, and the child reads EOF.
        pipe.abort();
    }
    StdinAbort::Pipe(pipe)
}

/// Starts one output pump; its flow is the shell stream's.
pub(super) fn start_output<E: EventSink + Clone, R: PipeEnd + tokio::io::AsyncRead>(
    runtime: &tokio::runtime::Handle,
    sink: &E,
    stream: OutputStream,
    pipe: R,
) -> (tokio::task::JoinHandle<()>, Arc<Flow>) {
    let flow = Flow::new();
    let (task_sink, task_flow) = (sink.clone(), Arc::clone(&flow));
    let pump = runtime.spawn(async move {
        if !pipe.connected().await {
            task_sink.end(stream);
            return;
        }
        pump_output(&task_sink, pipe, stream, task_flow).await;
    });
    (pump, flow)
}

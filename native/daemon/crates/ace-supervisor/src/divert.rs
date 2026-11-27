// SPDX-License-Identifier: Apache-2.0
//! A native child whose pipes belong to a Rust session (E3.0b). The session,
//! not the shell's JavaScript streams, takes every byte, answers each chunk's
//! delivery (which pauses or resumes the pump), writes stdin and closes the
//! pumps. Ownership, the stop plan, the inventory and the shell's events stay
//! exactly as they are: `Diverted` forwards what only the shell can act on.

use crate::errors::{NodeIoError, SupervisorError};
use crate::pump::{Flow, StdinMessage};
use crate::spawn::{Delivered, EventSink, OutputStream, RawExit};
use std::sync::{Arc, OnceLock};

/// A Rust consumer of a diverted child, fixed at spawn. Events arrive in the order the
/// supervisor produces them, from tokio threads.
pub trait OutputConsumer: Send + Sync + 'static {
    fn output(&self, stream: OutputStream, bytes: Vec<u8>, delivered: Delivered);
    fn end(&self, stream: OutputStream);
    fn stdin_written(&self);
    fn stdin_error(&self, error: NodeIoError);
    /// The leader's end (node's `exit`). The child's pumps were read out first,
    /// boundedly, so the bytes it wrote are all delivered; only a pipe a
    /// descendant still holds can drain past this.
    fn exit(&self, exit: RawExit);
    /// The pipes are done (node's `close`): no byte follows. The terminal barrier.
    fn close(&self, exit: RawExit);
}

/// The child's controls, filled by the spawn before it returns.
pub struct ChildPorts {
    pub stdin: StdinPort,
    pub output: OutputControl,
}

/// What a session hands to the spawn.
pub struct DivertTarget {
    pub consumer: Arc<dyn OutputConsumer>,
    pub ports: Arc<OnceLock<ChildPorts>>,
}

/// Writes into the child's stdin queue (`StdinMessage`), in order with every other write.
#[derive(Clone)]
pub struct StdinPort {
    queue: tokio::sync::mpsc::UnboundedSender<StdinMessage>,
}

impl StdinPort {
    /// The port over the child's own queue; only the spawn makes one.
    pub(crate) fn new(queue: tokio::sync::mpsc::UnboundedSender<StdinMessage>) -> Self {
        Self { queue }
    }

    /// Queues `bytes` after every write queued before. Closed once the pump ended.
    pub fn write(&self, bytes: Vec<u8>) -> Result<(), SupervisorError> {
        self.queue
            .send(StdinMessage::Write(bytes))
            .map_err(|_| SupervisorError::Closed)
    }

    /// EOF after every queued write.
    pub fn end(&self) {
        let _ = self.queue.send(StdinMessage::End);
    }
}

/// Pause and resume of both pumps, as the JS stream did it.
#[derive(Clone)]
pub struct OutputControl {
    stdout: Option<Arc<Flow>>,
    stderr: Option<Arc<Flow>>,
}

impl OutputControl {
    /// The control over one child's piped outputs; only the spawn makes one.
    pub(crate) fn new(stdout: Option<Arc<Flow>>, stderr: Option<Arc<Flow>>) -> Self {
        Self { stdout, stderr }
    }

    fn flow(&self, stream: OutputStream) -> Option<&Arc<Flow>> {
        match stream {
            OutputStream::Stdout => self.stdout.as_ref(),
            OutputStream::Stderr => self.stderr.as_ref(),
        }
    }

    /// The consumer wants more of `stream` (`Flow::resume`).
    pub fn resume(&self, stream: OutputStream) {
        if let Some(flow) = self.flow(stream) {
            flow.resume();
        }
    }

    /// The consumer closed `stream` (`Flow::close`), after marking the flow
    /// `end_on_close`: the pump stops, closes its end, and still emits `end`.
    pub fn close(&self, stream: OutputStream) {
        if let Some(flow) = self.flow(stream) {
            flow.mark_end_on_close();
            flow.close();
        }
    }
}

/// The sink a diverted child is spawned with.
pub struct Diverted<E: EventSink> {
    shell: E,
    consumer: Arc<dyn OutputConsumer>,
}

impl<E: EventSink> Diverted<E> {
    /// The shell's sink behind the session's consumer.
    pub fn new(shell: E, consumer: Arc<dyn OutputConsumer>) -> Self {
        Self { shell, consumer }
    }
}

impl<E: EventSink + Clone> Clone for Diverted<E> {
    fn clone(&self) -> Self {
        Self {
            shell: self.shell.clone(),
            consumer: Arc::clone(&self.consumer),
        }
    }
}

/// Bytes, stdin acknowledgements and the pipe's end go to the consumer; the
/// consumer hears each end first, then the shell's stream ends empty. Leader
/// exit, `close`, and the group diagnostics reach both, in that order.
impl<E: EventSink> EventSink for Diverted<E> {
    fn output(&self, stream: OutputStream, bytes: Vec<u8>, delivered: Delivered) {
        self.consumer.output(stream, bytes, delivered);
    }

    fn end(&self, stream: OutputStream) {
        self.consumer.end(stream);
        self.shell.end(stream);
    }

    fn exit(&self, exit: RawExit) {
        self.consumer.exit(exit.clone());
        self.shell.exit(exit);
    }

    fn close(&self, exit: RawExit) {
        self.consumer.close(exit.clone());
        self.shell.close(exit);
    }

    fn stdin_written(&self) {
        self.consumer.stdin_written();
    }

    fn stdin_error(&self, error: NodeIoError) {
        self.consumer.stdin_error(error);
    }

    fn hold_limit(&self) {
        self.shell.hold_limit();
    }

    fn held(&self, message: String) {
        self.shell.held(message);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pump::{MAX_IN_FLIGHT, OutputBudget, pump_output};
    use crate::test_scratch::{
        EndlessReader, Log, RecordingConsumer, RecordingShell, StalledReader, exit, failure,
        runtime,
    };
    use std::sync::atomic::{AtomicBool, Ordering};

    /// The sink and the consumer behind it, so a test can watch the chunks it holds.
    fn diverted(log: Log) -> (Diverted<RecordingShell>, Arc<RecordingConsumer>) {
        let consumer = Arc::new(RecordingConsumer {
            log: log.clone(),
            held: std::sync::Mutex::default(),
        });
        let erased: Arc<dyn OutputConsumer> = Arc::<RecordingConsumer>::clone(&consumer);
        (Diverted::new(RecordingShell { log }, erased), consumer)
    }

    /// One row of the routing table: the event, and every destination in order.
    #[test]
    fn diverted_events_reach_the_consumer_and_the_shell_as_the_table_says() {
        type Event = fn(&Diverted<RecordingShell>);
        let rows: &[(Event, &[&str])] = &[
            (
                |sink| {
                    let flow = Flow::new(OutputBudget::new(None));
                    sink.output(OutputStream::Stdout, b"hi".to_vec(), Delivered::new(flow));
                },
                &["consumer:output:stdout:hi"],
            ),
            (
                |sink| sink.end(OutputStream::Stderr),
                &["consumer:end:stderr", "shell:end:stderr"],
            ),
            (|sink| sink.exit(exit()), &["consumer:exit", "shell:exit"]),
            (
                |sink| sink.close(exit()),
                &["consumer:close", "shell:close"],
            ),
            (|sink| sink.stdin_written(), &["consumer:stdin-written"]),
            (
                |sink| sink.stdin_error(failure()),
                &["consumer:stdin-error"],
            ),
            (|sink| sink.hold_limit(), &["shell:hold-limit"]),
            (|sink| sink.held("stuck".to_owned()), &["shell:held"]),
        ];
        for (event, expected) in rows {
            let log = Log::default();
            let (sink, _consumer) = diverted(log.clone());
            event(&sink);
            assert_eq!(*log.lock().unwrap(), *expected);
        }
    }

    /// The pump's wait for room: closing the flow stops it there, and the
    /// consumer still hears exactly one `end`, before the child's `close`.
    #[test]
    fn a_closed_flow_waiting_for_room_emits_end_once_before_close() {
        runtime().block_on(async {
            let log = Log::default();
            let (sink, consumer) = diverted(log.clone());
            let flow = Flow::new(OutputBudget::new(None));
            let control = OutputControl::new(Some(Arc::clone(&flow)), None);
            let pump = tokio::spawn({
                let sink = sink.clone();
                async move { pump_output(&sink, EndlessReader, OutputStream::Stdout, flow).await }
            });
            while consumer.held.lock().unwrap().len() < MAX_IN_FLIGHT {
                tokio::task::yield_now().await;
            }
            control.close(OutputStream::Stdout);
            pump.await.unwrap();
            sink.close(exit());
            assert_eq!(
                *log.lock().unwrap(),
                vec![
                    "consumer:output:stdout:x",
                    "consumer:output:stdout:x",
                    "consumer:output:stdout:x",
                    "consumer:output:stdout:x",
                    "consumer:end:stdout",
                    "shell:end:stdout",
                    "consumer:close",
                    "shell:close",
                ]
            );
        });
    }

    /// The pump's wait on the pipe: closing the flow stops it mid-read, and
    /// the consumer still hears exactly one `end`, before the child's `close`.
    #[test]
    fn a_closed_flow_waiting_on_a_read_emits_end_once_before_close() {
        runtime().block_on(async {
            let log = Log::default();
            let (sink, _consumer) = diverted(log.clone());
            let polled = Arc::new(AtomicBool::new(false));
            let flow = Flow::new(OutputBudget::new(None));
            let control = OutputControl::new(Some(Arc::clone(&flow)), None);
            let pump = tokio::spawn({
                let sink = sink.clone();
                let polled = Arc::clone(&polled);
                async move {
                    pump_output(&sink, StalledReader { polled }, OutputStream::Stdout, flow).await
                }
            });
            while !polled.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
            control.close(OutputStream::Stdout);
            pump.await.unwrap();
            sink.close(exit());
            assert_eq!(
                *log.lock().unwrap(),
                vec![
                    "consumer:end:stdout",
                    "shell:end:stdout",
                    "consumer:close",
                    "shell:close",
                ]
            );
        });
    }
}

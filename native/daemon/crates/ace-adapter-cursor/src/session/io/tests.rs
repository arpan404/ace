// SPDX-License-Identifier: Apache-2.0
//! The shell's own contract: an input from the facade always answers.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::channel;
use std::time::Duration;

use ace_adapter_api::bridge::queue::SessionEvent;
use ace_json::Value;

use super::super::commands::CursorOpen;
use super::super::core::CursorSessionConfig;
use super::super::envelope::limits;
use super::CursorSessionShell;

fn shell() -> Arc<CursorSessionShell> {
    Arc::new(CursorSessionShell::new(CursorSessionConfig {
        generation: String::from("generation"),
        instance_id: String::from("instance"),
        root_key: String::from("root"),
        limits: limits(&Value::Object(ace_json::Map::new())).expect("the default limits parse"),
        capabilities: String::from("{}"),
    }))
}

fn open(shell: &CursorSessionShell, operation: u64) {
    shell.open(
        operation,
        CursorOpen {
            cwd: "/tmp",
            thread_id: "thread",
            checkpoint_generation: None,
            model: None,
            model_params: None,
            native_session_id: None,
            recover: None,
            permission_mode: None,
            auto_review: false,
            mcp: None,
            instructions: None,
        },
        None,
    );
}

#[test]
fn an_open_with_no_child_answers_instead_of_blocking_the_session() {
    let shell = shell();
    let (sent, answered) = channel();
    let opener = Arc::clone(&shell);
    let worker = std::thread::spawn(move || {
        open(&opener, 1);
        // Sends after the open returns: a second lock inside the open would never get here.
        let _ = sent.send(());
    });
    answered
        .recv_timeout(Duration::from_secs(5))
        .expect("the open blocked on its own state lock");
    worker.join().expect("the open's thread panicked");

    // No child ever took the line, so the refusal settles the facade's open once.
    let batch = shell.queue().take_batch(16, 16_384);
    assert!(
        batch.iter().any(|event| matches!(
            event,
            SessionEvent::Settle {
                id: 1,
                result: Err(_)
            }
        )),
        "the refused open settled nothing"
    );
}

/// The output pump's sink, forwarding straight to the session shell as a diverted child's
/// consumer would.
struct Forward(std::sync::Arc<CursorSessionShell>);

impl ace_supervisor::spawn::EventSink for Forward {
    fn output(
        &self,
        stream: ace_supervisor::spawn::OutputStream,
        bytes: Vec<u8>,
        delivered: ace_supervisor::spawn::Delivered,
    ) {
        ace_supervisor::divert::OutputConsumer::output(&*self.0, stream, bytes, delivered);
    }
    fn end(&self, _stream: ace_supervisor::spawn::OutputStream) {}
    fn exit(&self, _exit: ace_supervisor::spawn::RawExit) {}
    fn close(&self, _exit: ace_supervisor::spawn::RawExit) {}
    fn stdin_written(&self) {}
    fn stdin_error(&self, _error: ace_supervisor::errors::NodeIoError) {}
    fn hold_limit(&self) {}
    fn held(&self, _message: String) {}
}

/// A scripted pipe: one chunk per read, then EOF.
struct Chunks {
    chunks: std::collections::VecDeque<Vec<u8>>,
    reads: Arc<AtomicUsize>,
}

impl tokio::io::AsyncRead for Chunks {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let Some(front) = self.chunks.front_mut() else {
            return std::task::Poll::Ready(Ok(()));
        };
        let taken = front.len().min(buf.remaining());
        buf.put_slice(&front[..taken]);
        front.drain(..taken);
        if front.is_empty() {
            self.chunks.pop_front();
        }
        if taken > 0 {
            self.reads.fetch_add(1, Ordering::SeqCst);
        }
        std::task::Poll::Ready(Ok(()))
    }
}

impl ace_supervisor::pump::HangUp for Chunks {
    fn hung_up(&self) -> bool {
        false
    }
    fn at_eof(&self) -> bool {
        false
    }
}

/// One frame request padded to a large line, so the read-ahead pool fills before the script ends.
fn frame_chunk(id: usize) -> Vec<u8> {
    let padding = "x".repeat(30_000);
    format!(
        "{{\"jsonrpc\":\"2.0\",\"id\":\"h{id}\",\"method\":\"frame\",\"params\":{{\"schemaVersion\":1,\"operationId\":\"op\",\"generation\":\"generation\",\"segment\":0,\"kind\":\"delta\",\"body\":{{\"type\":\"text-delta\",\"text\":\"{padding}\"}}}}}}\n"
    )
    .into_bytes()
}

#[test]
fn a_stray_line_pauses_the_hosts_reads_until_its_note_is_answered() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("a runtime");
    let shell = shell();
    let reads = Arc::new(AtomicUsize::new(0));
    let total = 60;
    let mut chunks = Chunks {
        chunks: std::collections::VecDeque::new(),
        reads: Arc::clone(&reads),
    };
    // The first chunk holds the stray line and one frame; the rest are frames behind the hold.
    let mut first = b"console write\n".to_vec();
    first.extend(frame_chunk(1));
    chunks.chunks.push_back(first);
    for id in 2..=total {
        chunks.chunks.push_back(frame_chunk(id));
    }
    let flow = ace_supervisor::pump::Flow::new(ace_supervisor::pump::OutputBudget::new(None));
    // The shell's gate has no `ChildPorts` in this harness, so no `OutputControl` is attached and
    // the gate's resume cannot reach the pump; the test resumes it once the hold is answered.
    let pump_flow = Arc::clone(&flow);
    let pump = runtime.spawn({
        let sink = Forward(Arc::clone(&shell));
        async move {
            ace_supervisor::pump::pump_output(
                &sink,
                chunks,
                ace_supervisor::spawn::OutputStream::Stdout,
                flow,
            )
            .await;
        }
    });
    // The stray port reaches the queue; the frame behind it waits in the core's hold.
    runtime.block_on(shell.queue().wait());
    let batch = shell.queue().take_batch(16, 16_384);
    assert!(
        batch
            .iter()
            .any(|event| matches!(event, SessionEvent::Port { name: "stray", .. }))
    );
    assert!(
        !batch
            .iter()
            .any(|event| matches!(event, SessionEvent::Frame { .. })),
        "a frame crossed before the stray note it follows"
    );
    // The gate pauses the pump: the hold can only grow by the bounded read-ahead, not the whole
    // script. Without the hold in the gate this would read every chunk.
    runtime.block_on(async { tokio::time::sleep(Duration::from_millis(50)).await });
    let held_reads = reads.load(Ordering::SeqCst);
    assert!(
        held_reads < total,
        "the pump read all {total} chunks while the host held its events ({held_reads})"
    );
    // The note releases the hold and the rest of the script goes on.
    shell.note("host-output", None);
    pump_flow.resume();
    runtime.block_on(pump).expect("the pump finishes");
    assert!(
        reads.load(Ordering::SeqCst) >= total,
        "the script was not read"
    );
    let batch = shell.queue().take_batch(256, usize::MAX);
    let frames = batch
        .iter()
        .filter(|event| matches!(event, SessionEvent::Frame { .. }))
        .count();
    assert_eq!(frames, total, "the released frames did not all cross");
}

// SPDX-License-Identifier: Apache-2.0
//! The ordered event stream one spawn's consumer reads: bounded output chunks
//! with their streams' flow control, and lifecycle events (G2a).

use std::collections::VecDeque;
#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use ace_supervisor::pump::Flow;
use ace_supervisor::spawn::{Delivered, OutputStream};
use tokio::sync::Notify;

/// A chunk of piped output, with the delivery its stream is waiting on: the
/// queue answers `taken(false)` once it is full, pausing the pump, and resumes
/// it when the consumer takes a chunk. At most `EVENT_QUEUE_CHUNKS` chunks are
/// ever held, so a Git process that writes faster than the core reads cannot
/// queue its whole output in memory.
pub struct OutputChunk {
    pub bytes: Vec<u8>,
    pub delivered: Option<Delivered>,
    /// The stream's flow, so the queue can resume that stream by itself.
    flow: Option<Arc<dyn StreamFlow>>,
}

/// One output stream's flow, behind a trait so a test can watch a resume.
pub trait StreamFlow: Send + Sync {
    fn resume(&self);
}

impl StreamFlow for Flow {
    fn resume(&self) {
        Flow::resume(self);
    }
}

impl std::fmt::Debug for OutputChunk {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OutputChunk")
            .field("bytes", &self.bytes.len())
            .field("delivered", &self.delivered.is_some())
            .field("flow", &self.flow.is_some())
            .finish()
    }
}

impl OutputChunk {
    /// A chunk no flow control watches (a bridged JS child's streams).
    pub fn new(bytes: Vec<u8>) -> Self {
        Self {
            bytes,
            delivered: None,
            flow: None,
        }
    }

    /// A chunk the supervisor's pump delivered, with the flow its stream waits on.
    pub fn supervised(bytes: Vec<u8>, delivered: Delivered) -> Self {
        let flow = Some(Arc::clone(&delivered.flow()) as Arc<dyn StreamFlow>);
        Self {
            bytes,
            delivered: Some(delivered),
            flow,
        }
    }

    #[cfg(test)]
    fn with_flow(bytes: Vec<u8>, flow: Arc<dyn StreamFlow>) -> Self {
        Self {
            bytes,
            delivered: None,
            flow: Some(flow),
        }
    }
}

/// How many output chunks the event queue holds before pausing the pump.
pub const EVENT_QUEUE_CHUNKS: usize = 16;

/// The ordered event queue one spawn's consumer reads (`ProcessEvent` stream).
pub struct EventQueue {
    state: Mutex<EventQueueState>,
    notify: Notify,
}

#[derive(Default)]
struct EventQueueState {
    events: VecDeque<ProcessEvent>,
    /// One slot per stream: a full queue pauses each stream once, and each
    /// resumes when the queue has room again. A single slot would let stderr
    /// overwrite stdout's pause and stall the other pipe until its deadline.
    paused_stdout: Option<Arc<dyn StreamFlow>>,
    paused_stderr: Option<Arc<dyn StreamFlow>>,
    closed: bool,
}

impl EventQueueState {
    fn paused_slot(&mut self, stream: OutputStream) -> &mut Option<Arc<dyn StreamFlow>> {
        match stream {
            OutputStream::Stdout => &mut self.paused_stdout,
            OutputStream::Stderr => &mut self.paused_stderr,
        }
    }
}

impl EventQueue {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(EventQueueState::default()),
            notify: Notify::new(),
        })
    }

    /// Queues one output chunk, answering the pump once it is in the queue (or
    /// pausing it when the queue is full).
    pub fn push_output(&self, stream: OutputStream, chunk: OutputChunk) {
        let OutputChunk {
            bytes,
            delivered,
            flow,
        } = chunk;
        // The pump only learns of the pause after the chunk is in the queue.
        let full = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            let full = state.events.len() >= EVENT_QUEUE_CHUNKS;
            if full && flow.is_some() {
                *state.paused_slot(stream) = flow.clone();
            }
            let event = match stream {
                OutputStream::Stdout => ProcessEvent::Stdout(OutputChunk {
                    bytes,
                    delivered: None,
                    flow,
                }),
                OutputStream::Stderr => ProcessEvent::Stderr(OutputChunk {
                    bytes,
                    delivered: None,
                    flow,
                }),
            };
            state.events.push_back(event);
            full
        };
        if let Some(delivered) = delivered {
            delivered.taken(!full);
        }
        self.notify.notify_one();
    }

    /// Queues one lifecycle event.
    pub fn push(&self, event: ProcessEvent) {
        if let Ok(mut state) = self.state.lock() {
            state.events.push_back(event);
        }
        self.notify.notify_one();
    }

    /// No event follows: a consumer with an empty queue stops waiting.
    pub fn close(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.closed = true;
        }
        self.notify.notify_one();
    }

    /// The next event in order, or `None` once the stream closed.
    pub async fn recv(&self) -> Option<ProcessEvent> {
        loop {
            let mut resume: Vec<Arc<dyn StreamFlow>> = Vec::new();
            {
                let Ok(mut state) = self.state.lock() else {
                    return None;
                };
                if let Some(event) = state.events.pop_front() {
                    if state.events.len() < EVENT_QUEUE_CHUNKS {
                        resume.extend(state.paused_stdout.take());
                        resume.extend(state.paused_stderr.take());
                    }
                    drop(state);
                    for flow in resume {
                        flow.resume();
                    }
                    return Some(event);
                }
                if state.closed {
                    return None;
                }
            }
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self
                .state
                .lock()
                .is_ok_and(|state| !state.events.is_empty() || state.closed)
            {
                continue;
            }
            notified.await;
        }
    }
}

/// Ordered stream and lifecycle events produced by a [`ProcessChild`].
#[derive(Debug)]
pub enum ProcessEvent {
    Stdout(OutputChunk),
    Stderr(OutputChunk),
    StdoutError {
        code: Option<String>,
        message: String,
    },
    StderrError {
        code: Option<String>,
        message: String,
    },
    StdinAck,
    StdinFinish,
    StdinError {
        code: Option<String>,
        message: String,
    },
    SpawnError {
        code: Option<String>,
        message: String,
    },
    Exit {
        code: Option<i32>,
        signal: Option<String>,
        pid: Option<u32>,
    },
    Close {
        code: Option<i32>,
        signal: Option<String>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[derive(Default)]
    struct RecordingFlow {
        resumes: AtomicUsize,
    }

    impl StreamFlow for RecordingFlow {
        fn resume(&self) {
            self.resumes.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn a_full_queue_pauses_both_streams_and_one_pop_resumes_both() {
        let queue = EventQueue::new();
        let stdout_flow = Arc::new(RecordingFlow::default());
        let stderr_flow = Arc::new(RecordingFlow::default());
        for index in 0..EVENT_QUEUE_CHUNKS {
            queue.push_output(
                OutputStream::Stdout,
                OutputChunk::new(format!("stdout {index}").into_bytes()),
            );
        }
        // The queue is full: each stream's own pause must be kept.
        queue.push_output(
            OutputStream::Stdout,
            OutputChunk::with_flow(
                b"more stdout".to_vec(),
                Arc::clone(&stdout_flow) as Arc<dyn StreamFlow>,
            ),
        );
        queue.push_output(
            OutputStream::Stderr,
            OutputChunk::with_flow(
                b"more stderr".to_vec(),
                Arc::clone(&stderr_flow) as Arc<dyn StreamFlow>,
            ),
        );
        for _ in 0..EVENT_QUEUE_CHUNKS + 2 {
            assert!(queue.recv().await.is_some());
        }
        assert_eq!(stdout_flow.resumes.load(Ordering::SeqCst), 1);
        assert_eq!(stderr_flow.resumes.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn events_come_out_in_the_order_they_were_queued() {
        let queue = EventQueue::new();
        queue.push_output(OutputStream::Stdout, OutputChunk::new(b"one".to_vec()));
        queue.push(ProcessEvent::StdinAck);
        queue.push_output(OutputStream::Stderr, OutputChunk::new(b"two".to_vec()));
        let mut chunks = Vec::new();
        let mut acks = 0;
        for _ in 0..3 {
            match queue.recv().await {
                Some(ProcessEvent::Stdout(chunk)) => {
                    chunks.push(String::from_utf8_lossy(&chunk.bytes).into_owned())
                }
                Some(ProcessEvent::Stderr(chunk)) => {
                    chunks.push(String::from_utf8_lossy(&chunk.bytes).into_owned())
                }
                Some(ProcessEvent::StdinAck) => acks += 1,
                other => panic!("unexpected event: {other:?}"),
            }
        }
        assert_eq!(chunks, vec!["one".to_owned(), "two".to_owned()]);
        assert_eq!(acks, 1);
    }

    #[tokio::test]
    async fn a_closed_queue_ends_the_consumer_once_it_is_empty() {
        let queue = EventQueue::new();
        queue.push_output(OutputStream::Stdout, OutputChunk::new(b"last".to_vec()));
        queue.close();
        assert!(matches!(queue.recv().await, Some(ProcessEvent::Stdout(_))));
        assert!(queue.recv().await.is_none());
    }

    #[tokio::test]
    async fn a_consumer_waiting_on_an_empty_queue_wakes_for_the_next_chunk() {
        let queue = EventQueue::new();
        let consumer = {
            let queue = Arc::clone(&queue);
            tokio::spawn(async move { queue.recv().await })
        };
        tokio::time::sleep(Duration::from_millis(10)).await;
        queue.push_output(OutputStream::Stdout, OutputChunk::new(b"wake".to_vec()));
        let event = tokio::time::timeout(Duration::from_millis(500), consumer)
            .await
            .expect("woken")
            .expect("consumer");
        match event {
            Some(ProcessEvent::Stdout(chunk)) => assert_eq!(chunk.bytes, b"wake"),
            other => panic!("unexpected event: {other:?}"),
        }
    }
}

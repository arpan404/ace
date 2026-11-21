// SPDX-License-Identifier: Apache-2.0
//! The image threads (ADR 0208): a fixed set in the image process, sharing one queue bounded in
//! jobs and in payload bytes. A job that is stopped (cancelled or past its deadline) leaves the
//! queue at once, or stops at its next step if it is running. A job reserves its peak memory
//! from the shared [`Budget`] before it decodes anything, and a decoder that panics fails only
//! its own job.
use super::budget::Budget;
use super::files::FileRoot;
use super::jobs::{ImageOutcome, ImageWork};
use media_image::{Failed, ImageFailure, Input};
use media_wire::image::ImageInput;
use std::collections::{HashMap, VecDeque};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};

/// Jobs waiting for a thread before one is refused `busy`.
pub const QUEUE_JOBS: usize = 32;
/// Payload bytes waiting for a thread before a job is refused `busy`.
pub const QUEUE_BYTES: usize = 64 * 1024 * 1024;

/// The image process's monotonic clock in µs, the one job deadlines are on.
pub type ImageClock = Arc<dyn Fn() -> u64 + Send + Sync>;
pub type DeliverImage = Arc<dyn Fn(ImageOutcome) + Send + Sync>;

/// One thread per core but one, at least 1, at most 4.
pub fn thread_count(cores: usize) -> usize {
    cores.saturating_sub(1).clamp(1, 4)
}

struct Running {
    stopped: Arc<AtomicBool>,
    deadline_us: u64,
}

#[derive(Default)]
struct Queue {
    waiting: VecDeque<ImageWork>,
    bytes: usize,
    running: HashMap<u64, Running>,
    closed: bool,
}

struct Shared {
    queue: Mutex<Queue>,
    ready: Condvar,
}

/// What every job reads from: the clock, the file root and the memory budget.
pub struct Context {
    pub clock: ImageClock,
    pub files: FileRoot,
    pub budget: Budget,
}

pub struct ImageThreads {
    shared: Arc<Shared>,
    deliver: DeliverImage,
}

fn busy(token: u64, message: &str) -> ImageOutcome {
    ImageOutcome {
        token,
        result: Err(Failed::new(ImageFailure::Busy, message)),
    }
}

impl ImageThreads {
    pub fn new(
        count: usize,
        context: Arc<Context>,
        deliver: DeliverImage,
    ) -> std::io::Result<Self> {
        let shared = Arc::new(Shared {
            queue: Mutex::new(Queue::default()),
            ready: Condvar::new(),
        });
        for index in 0..count {
            let (shared, context, deliver) = (shared.clone(), context.clone(), deliver.clone());
            std::thread::Builder::new()
                .name(format!("ace-media-image-{index}"))
                .spawn(move || work(&shared, &context, &deliver))?;
        }
        Ok(Self { shared, deliver })
    }

    /// Queues `work`, or refuses it at once with `busy` when the queue is full.
    pub fn submit(&self, work: ImageWork) {
        let token = work.token;
        let refused = match self.shared.queue.lock() {
            Ok(mut queue) => {
                let bytes = work.payload.len();
                if queue.waiting.len() >= QUEUE_JOBS || queue.bytes + bytes > QUEUE_BYTES {
                    true
                } else {
                    queue.bytes += bytes;
                    queue.waiting.push_back(work);
                    self.shared.ready.notify_one();
                    false
                }
            }
            Err(_) => true,
        };
        if refused {
            (self.deliver)(busy(token, "ace-media's image queue is full."));
        }
    }

    /// Nobody waits for `token` now: off the queue if it hasn't started, else stopped at its
    /// next step. Its queue slot is free for the next job at once.
    pub fn stop(&self, token: u64) {
        let Ok(mut queue) = self.shared.queue.lock() else {
            return;
        };
        if let Some(at) = queue.waiting.iter().position(|w| w.token == token) {
            if let Some(work) = queue.waiting.remove(at) {
                queue.bytes -= work.payload.len();
            }
        } else if let Some(running) = queue.running.get(&token) {
            running.stopped.store(true, Ordering::Relaxed);
        }
    }

    /// Whether a running job is still running `grace_us` past its deadline: a step that never
    /// returns, which only a restart of the image process ends.
    pub fn stuck(&self, now_us: u64, grace_us: u64) -> bool {
        self.shared.queue.lock().is_ok_and(|queue| {
            queue
                .running
                .values()
                .any(|r| now_us > r.deadline_us.saturating_add(grace_us))
        })
    }

    /// Jobs waiting and running.
    pub fn load(&self) -> (usize, usize) {
        self.shared
            .queue
            .lock()
            .map_or((0, 0), |q| (q.waiting.len(), q.running.len()))
    }
}

impl Drop for ImageThreads {
    fn drop(&mut self) {
        if let Ok(mut queue) = self.shared.queue.lock() {
            queue.closed = true;
        }
        self.shared.ready.notify_all();
    }
}

fn work(shared: &Shared, context: &Context, deliver: &DeliverImage) {
    loop {
        let (work, stopped) = {
            let Ok(mut queue) = shared.queue.lock() else {
                return;
            };
            loop {
                if queue.closed {
                    return;
                }
                if let Some(work) = queue.waiting.pop_front() {
                    queue.bytes -= work.payload.len();
                    let stopped = Arc::new(AtomicBool::new(false));
                    queue.running.insert(
                        work.token,
                        Running {
                            stopped: stopped.clone(),
                            deadline_us: work.deadline_us,
                        },
                    );
                    break (work, stopped);
                }
                queue = match shared.ready.wait(queue) {
                    Ok(queue) => queue,
                    Err(_) => return,
                };
            }
        };
        let (clock, deadline) = (context.clock.clone(), work.deadline_us);
        let expired = move || stopped.load(Ordering::Relaxed) || clock() >= deadline;
        let result = execute(&work, context, &expired);
        if let Ok(mut queue) = shared.queue.lock() {
            queue.running.remove(&work.token);
        }
        deliver(ImageOutcome {
            token: work.token,
            result,
        });
    }
}

/// One job, start to end: its files read, its peak memory reserved, then `media-image`. A
/// panic anywhere in the decoders is this job's failure.
pub fn execute(
    work: &ImageWork,
    context: &Context,
    expired: &dyn Fn() -> bool,
) -> Result<media_image::Done, Failed> {
    match catch_unwind(AssertUnwindSafe(|| {
        let files = context.files.read_all(&work.inputs, expired)?;
        let inputs = inputs(&work.inputs, &work.payload, &files)?;
        let _held = context
            .budget
            .reserve(media_image::peak_bytes(&inputs, &work.op)?, expired)?;
        media_image::run(&inputs, &work.op, expired)
    })) {
        Ok(result) => result,
        Err(_) => Err(Failed::new(
            ImageFailure::DecodeFailed,
            "The image could not be decoded: its decoder stopped on it.",
        )),
    }
}

/// Each input as `media-image` takes it: payload slices in order, and the files read.
fn inputs<'a>(
    inputs: &[ImageInput],
    payload: &'a [u8],
    files: &'a [Vec<u8>],
) -> Result<Vec<Input<'a>>, Failed> {
    let mut at = 0usize;
    let mut files = files.iter();
    let mut take = |bytes: u32| -> Result<&'a [u8], Failed> {
        let end = at + bytes as usize;
        let slice = payload
            .get(at..end)
            .ok_or_else(|| Failed::invalid("The payload is shorter than the job's inputs."))?;
        at = end;
        Ok(slice)
    };
    inputs
        .iter()
        .map(|input| match input {
            ImageInput::Bytes { bytes } => Ok(Input::Encoded(take(*bytes)?)),
            ImageInput::Rgba {
                bytes,
                width,
                height,
            } => Ok(Input::Rgba {
                data: take(*bytes)?,
                width: *width,
                height: *height,
            }),
            ImageInput::File { .. } => files
                .next()
                .map(|bytes| Input::Encoded(bytes))
                .ok_or_else(|| Failed::invalid("A file input was not read.")),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::super::budget::BUDGET_BYTES;
    use super::*;
    use media_wire::image::{ImageOp, ImageOutput};
    use std::sync::mpsc;
    use std::time::Duration;
    use zeroize::Zeroizing;

    fn work(token: u64, deadline_us: u64) -> ImageWork {
        ImageWork {
            token,
            inputs: vec![ImageInput::Rgba {
                bytes: 4,
                width: 1,
                height: 1,
            }],
            op: ImageOp::Fit {
                max_pixels: 1 << 20,
                width: 8,
                height: 8,
                auto_orient: false,
                vector_scale: None,
                output: ImageOutput::Png,
            },
            payload: Zeroizing::new(vec![1, 2, 3, 255]),
            deadline_us,
        }
    }

    /// One image thread whose clock blocks at every reading until the test opens the gate, so
    /// the running job (and so the queue) is held exactly as long as the test says.
    fn gated() -> (ImageThreads, mpsc::Receiver<ImageOutcome>, mpsc::Sender<()>) {
        let (gate_tx, gate_rx) = mpsc::channel::<()>();
        let gate = Mutex::new(gate_rx);
        let clock: ImageClock = Arc::new(move || {
            if let Ok(gate) = gate.lock() {
                let _ = gate.recv_timeout(Duration::from_secs(10));
            }
            0
        });
        let context = Arc::new(Context {
            clock,
            files: FileRoot::new(None),
            budget: Budget::new(BUDGET_BYTES),
        });
        let (tx, rx) = mpsc::channel();
        let threads = ImageThreads::new(
            1,
            context,
            Arc::new(move |o| {
                let _ = tx.send(o);
            }),
        );
        match threads {
            Ok(threads) => (threads, rx, gate_tx),
            Err(e) => panic!("no image thread: {e}"),
        }
    }

    fn wait_running(threads: &ImageThreads) {
        for _ in 0..1000 {
            if threads.load().1 == 1 {
                return;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        panic!("the first job never started");
    }

    fn open(gate: &mpsc::Sender<()>, readings: usize) {
        for _ in 0..readings {
            let _ = gate.send(());
        }
    }

    #[test]
    fn below_capacity_jobs_are_taken_at_capacity_refused_and_after_draining_taken_again() {
        let (threads, rx, gate) = gated();
        threads.submit(work(0, u64::MAX));
        wait_running(&threads);
        // The queue takes exactly its capacity: no answer comes for any of them yet.
        for token in 1..=QUEUE_JOBS as u64 {
            threads.submit(work(token, u64::MAX));
        }
        assert!(rx.try_recv().is_err(), "a job below capacity was refused");
        assert_eq!(threads.load(), (QUEUE_JOBS, 1));
        // One more is refused at once.
        threads.submit(work(99, u64::MAX));
        let refused = rx.recv_timeout(Duration::from_secs(5)).ok();
        assert_eq!(
            refused.map(|o| (o.token, o.result.err().map(|f| f.reason))),
            Some((99, Some(ImageFailure::Busy)))
        );
        // Drained, every held job succeeds, and the queue takes a new one that succeeds too.
        open(&gate, (QUEUE_JOBS + 1) * 8);
        for n in 0..=QUEUE_JOBS {
            let outcome = rx.recv_timeout(Duration::from_secs(5)).ok();
            assert!(
                outcome.as_ref().is_some_and(|o| o.result.is_ok()),
                "held job {n} didn't finish well"
            );
        }
        threads.submit(work(100, u64::MAX));
        open(&gate, 8);
        let again = rx.recv_timeout(Duration::from_secs(5)).ok();
        assert_eq!(
            again.map(|o| (o.token, o.result.is_ok())),
            Some((100, true))
        );
    }

    #[test]
    fn a_stopped_queued_job_frees_its_slot_at_once_and_the_next_job_runs() {
        let (threads, rx, gate) = gated();
        threads.submit(work(0, u64::MAX));
        wait_running(&threads);
        for token in 1..=QUEUE_JOBS as u64 {
            threads.submit(work(token, u64::MAX));
        }
        threads.stop(5);
        assert_eq!(threads.load(), (QUEUE_JOBS - 1, 1));
        // Its slot takes a new job instead of a refusal.
        threads.submit(work(77, u64::MAX));
        assert!(rx.try_recv().is_err(), "the freed slot refused a job");
        // The running job is stopped too: it ends at its next step without finishing.
        threads.stop(0);
        open(&gate, (QUEUE_JOBS + 1) * 8);
        let mut outcomes = Vec::new();
        while outcomes.len() < QUEUE_JOBS + 1 {
            match rx.recv_timeout(Duration::from_secs(5)) {
                Ok(o) => outcomes.push((o.token, o.result.err().map(|f| f.reason))),
                Err(_) => break,
            }
        }
        assert_eq!(outcomes.first(), Some(&(0, Some(ImageFailure::Deadline))));
        assert!(outcomes.contains(&(77, None)));
        assert!(!outcomes.iter().any(|(t, _)| *t == 5), "a stopped job ran");
    }

    #[test]
    fn a_job_still_running_past_its_deadline_and_grace_is_stuck() {
        let (threads, _rx, _gate) = gated();
        threads.submit(work(0, 1_000));
        wait_running(&threads);
        assert!(!threads.stuck(1_500, 1_000));
        assert!(threads.stuck(2_001, 1_000));
    }
}

// SPDX-License-Identifier: Apache-2.0
//! The image threads (ADR 0201): a fixed set, separate from the still makers and never the
//! tokio threads, running `media-image` jobs. A job reads its file inputs here (the only I/O),
//! is stopped between steps once its deadline passes, and a decoder that panics fails only
//! its own job.
use crate::engine::images::{ImageOutcome, ImageWork};
use media_image::{Failed, ImageFailure, Input};
use media_wire::image::ImageInput;
use std::io::Read;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};

/// Jobs queued per thread before one is refused `busy`.
pub const QUEUE: usize = 16;
/// The most a file input may hold, whatever the job allows.
pub const MAX_FILE_BYTES: u32 = 32 * 1024 * 1024;

/// ace-media's monotonic clock in µs, the one job deadlines are on.
pub type ImageClock = Arc<dyn Fn() -> u64 + Send + Sync>;
pub type DeliverImage = Arc<dyn Fn(ImageOutcome) + Send + Sync>;

/// One thread per core but one, at least 1, at most 4.
pub fn thread_count(cores: usize) -> usize {
    cores.saturating_sub(1).clamp(1, 4)
}

struct Worker {
    tx: SyncSender<ImageWork>,
    queued: Arc<AtomicUsize>,
}

pub struct ImageThreads {
    workers: Vec<Worker>,
    deliver: DeliverImage,
}

impl ImageThreads {
    pub fn new(count: usize, clock: ImageClock, deliver: DeliverImage) -> std::io::Result<Self> {
        let mut workers = Vec::with_capacity(count);
        for index in 0..count {
            let (tx, rx) = mpsc::sync_channel::<ImageWork>(QUEUE);
            let queued = Arc::new(AtomicUsize::new(0));
            let (clock, deliver, left) = (clock.clone(), deliver.clone(), queued.clone());
            std::thread::Builder::new()
                .name(format!("ace-media-image-{index}"))
                .spawn(move || {
                    while let Ok(work) = rx.recv() {
                        left.fetch_sub(1, Ordering::Relaxed);
                        let deadline = work.deadline_us;
                        let clock = clock.clone();
                        let result = execute(&work, &move || clock() >= deadline);
                        deliver(ImageOutcome {
                            token: work.token,
                            result,
                        });
                    }
                })?;
            workers.push(Worker { tx, queued });
        }
        Ok(Self { workers, deliver })
    }

    /// Hands `work` to the least busy thread. With every queue full it is refused at once.
    pub fn submit(&self, work: ImageWork) {
        let Some(worker) = self
            .workers
            .iter()
            .min_by_key(|w| w.queued.load(Ordering::Relaxed))
        else {
            return self.refuse(work.token);
        };
        worker.queued.fetch_add(1, Ordering::Relaxed);
        match worker.tx.try_send(work) {
            Ok(()) => {}
            Err(TrySendError::Full(work) | TrySendError::Disconnected(work)) => {
                worker.queued.fetch_sub(1, Ordering::Relaxed);
                self.refuse(work.token);
            }
        }
    }

    fn refuse(&self, token: u64) {
        (self.deliver)(ImageOutcome {
            token,
            result: Err(Failed::new(
                ImageFailure::Busy,
                "ace-media's image threads are all busy.",
            )),
        });
    }
}

/// One job, start to end: its inputs gathered, then `media-image`. A panic anywhere in the
/// decoders is this job's failure.
pub fn execute(work: &ImageWork, expired: &dyn Fn() -> bool) -> Result<media_image::Done, Failed> {
    match catch_unwind(AssertUnwindSafe(|| {
        let files = read_files(&work.inputs)?;
        let inputs = inputs(&work.inputs, &work.payload, &files)?;
        media_image::run(&inputs, &work.op, expired)
    })) {
        Ok(result) => result,
        Err(_) => Err(Failed::new(
            ImageFailure::DecodeFailed,
            "The image could not be decoded: its decoder stopped on it.",
        )),
    }
}

/// The bytes of each file input, in order.
fn read_files(inputs: &[ImageInput]) -> Result<Vec<Vec<u8>>, Failed> {
    inputs
        .iter()
        .filter_map(|input| match input {
            ImageInput::File { path, max_bytes } => {
                Some(read_file(path, (*max_bytes).min(MAX_FILE_BYTES)))
            }
            _ => None,
        })
        .collect()
}

fn read_file(path: &str, max_bytes: u32) -> Result<Vec<u8>, Failed> {
    let path = std::path::Path::new(path);
    if !path.is_absolute() {
        return Err(Failed::invalid("A file input needs an absolute path."));
    }
    let unreadable = |e: std::io::Error| {
        Failed::new(
            ImageFailure::Unreadable,
            format!("The image file could not be read: {}.", e.kind()),
        )
    };
    let file = std::fs::File::open(path).map_err(unreadable)?;
    let mut bytes = Vec::new();
    file.take(u64::from(max_bytes) + 1)
        .read_to_end(&mut bytes)
        .map_err(unreadable)?;
    if bytes.len() > max_bytes as usize {
        return Err(Failed::too_large(format!(
            "The image file is larger than the {max_bytes} bytes allowed."
        )));
    }
    Ok(bytes)
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
    use super::*;
    use media_wire::image::{ImageOp, ImageOutput};
    use zeroize::Zeroizing;

    fn fit() -> ImageOp {
        ImageOp::Fit {
            max_pixels: 1 << 20,
            width: 8,
            height: 8,
            auto_orient: false,
            vector_scale: None,
            output: ImageOutput::Png,
        }
    }

    fn work(inputs: Vec<ImageInput>, payload: Vec<u8>) -> ImageWork {
        ImageWork {
            token: 1,
            inputs,
            op: fit(),
            payload: Zeroizing::new(payload),
            deadline_us: u64::MAX,
        }
    }

    #[test]
    fn payload_slices_and_files_become_the_jobs_inputs() {
        let dir = std::env::temp_dir().join(format!("ace-media-images-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let svg = dir.join("one.svg");
        let _ = std::fs::write(
            &svg,
            br#"<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2"/>"#,
        );
        let job = work(
            vec![ImageInput::File {
                path: svg.to_string_lossy().into_owned(),
                max_bytes: 4096,
            }],
            vec![],
        );
        let done = execute(&job, &|| false).map_err(|f| f.message);
        assert_eq!(done.map(|d| (d.width, d.height)), Ok((4, 2)));
        let small = work(
            vec![ImageInput::File {
                path: svg.to_string_lossy().into_owned(),
                max_bytes: 8,
            }],
            vec![],
        );
        assert_eq!(
            execute(&small, &|| false).err().map(|f| f.reason),
            Some(ImageFailure::TooLarge)
        );
        let missing = work(
            vec![ImageInput::File {
                path: dir.join("none.png").to_string_lossy().into_owned(),
                max_bytes: 8,
            }],
            vec![],
        );
        assert_eq!(
            execute(&missing, &|| false).err().map(|f| f.reason),
            Some(ImageFailure::Unreadable)
        );
        let rgba = work(
            vec![ImageInput::Rgba {
                bytes: 4,
                width: 1,
                height: 1,
            }],
            vec![1, 2, 3, 255],
        );
        assert_eq!(execute(&rgba, &|| false).map(|d| d.width).ok(), Some(1));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_queue_full_refuses_at_once_with_busy() {
        let (tx, rx) = mpsc::channel();
        // A clock that blocks each thread's first job until the test lets it go.
        let (gate_tx, gate_rx) = mpsc::channel::<()>();
        let gate = Arc::new(std::sync::Mutex::new(gate_rx));
        let clock: ImageClock = Arc::new(move || {
            if let Ok(gate) = gate.lock() {
                let _ = gate.recv_timeout(std::time::Duration::from_secs(5));
            }
            0
        });
        let threads = ImageThreads::new(
            1,
            clock,
            Arc::new(move |o| {
                let _ = tx.send(o);
            }),
        );
        let Ok(threads) = threads else { return };
        for token in 0..(QUEUE as u64 + 2) {
            let mut job = work(
                vec![ImageInput::Rgba {
                    bytes: 4,
                    width: 1,
                    height: 1,
                }],
                vec![0, 0, 0, 255],
            );
            job.token = token;
            threads.submit(job);
        }
        let first = rx.recv_timeout(std::time::Duration::from_secs(5)).ok();
        assert_eq!(
            first.and_then(|o| o.result.err()).map(|f| f.reason),
            Some(ImageFailure::Busy)
        );
        for _ in 0..(QUEUE + 2) {
            let _ = gate_tx.send(());
        }
    }
}

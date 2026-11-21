// SPDX-License-Identifier: Apache-2.0
//! `ace-media --images --root <dir>` (ADR 0201 §3): the image process. It reads `image.job` and
//! `image.cancel` frames on stdin and answers `image.done` or `image.failed` on stdout, with no
//! sockets, secrets or video in it, so no picture can take live video or a recording down with
//! it. It exits 0 when stdin closes, 2 on an invalid frame and 1 when a job is stuck in a step
//! well past its deadline or the daemon stops reading, so the daemon restarts it.
use super::budget::{BUDGET_BYTES, Budget};
use super::files::FileRoot;
use super::jobs::{ImageOutcome, Jobs, Out};
use super::output::{OUTPUT_BYTES, Output};
use super::pool::{Context, ImageThreads, thread_count};
use media_wire::control::{ControlFrame, FromMedia, Lane, ToMedia, lane};
use media_wire::image::ImageFailure;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

/// The image process's data limit (Linux `RLIMIT_DATA`): the jobs' budget, with room for the
/// allocator, queued inputs and answers.
pub const DATA_LIMIT_BYTES: u64 = BUDGET_BYTES + 768 * 1024 * 1024;
/// How long past its deadline a step may run before the process gives itself up.
const STUCK_GRACE_US: u64 = 10_000_000;
const TICK: Duration = Duration::from_millis(100);

enum Event {
    Frame(Vec<u8>),
    End,
    Outcome(ImageOutcome),
}

/// One frame from stdin, or `None` at its end.
fn read_frame(input: &mut impl Read) -> std::io::Result<Option<Vec<u8>>> {
    let mut length = [0u8; 4];
    match input.read_exact(&mut length) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let n = u32::from_be_bytes(length) as usize;
    if !(4..=8 * 1024 * 1024).contains(&n) {
        return Err(std::io::Error::other("frame length"));
    }
    let mut frame = vec![0; 4 + n];
    frame[..4].copy_from_slice(&length);
    input.read_exact(&mut frame[4..])?;
    Ok(Some(frame))
}

fn encode(message: FromMedia, payload: Vec<u8>) -> Option<Vec<u8>> {
    let frame = ControlFrame {
        message,
        payload: Zeroizing::new(payload),
    };
    let mut bytes = frame.header(Lane::Normal).ok()?;
    bytes.extend_from_slice(&frame.payload);
    Some(bytes)
}

pub fn run(root: Option<&Path>) -> i32 {
    crate::os::harden();
    crate::os::limit_data(DATA_LIMIT_BYTES);
    let started = Instant::now();
    let Ok(output) = Output::spawn(std::io::stdout(), OUTPUT_BYTES) else {
        return 1;
    };
    let (events, inbox) = mpsc::channel::<Event>();
    let reader = events.clone();
    let spawned = std::thread::Builder::new()
        .name("ace-media-image-in".into())
        .spawn(move || {
            let mut stdin = std::io::stdin().lock();
            loop {
                match read_frame(&mut stdin) {
                    Ok(Some(frame)) => {
                        if reader.send(Event::Frame(frame)).is_err() {
                            return;
                        }
                    }
                    _ => {
                        let _ = reader.send(Event::End);
                        return;
                    }
                }
            }
        });
    if spawned.is_err() {
        return 1;
    }
    let context = Arc::new(Context {
        clock: Arc::new(move || started.elapsed().as_micros() as u64),
        files: FileRoot::new(root),
        budget: Budget::new(BUDGET_BYTES),
    });
    let delivered = events.clone();
    let Ok(threads) = ImageThreads::new(
        thread_count(std::thread::available_parallelism().map_or(1, |n| n.get())),
        context,
        Arc::new(move |outcome| {
            let _ = delivered.send(Event::Outcome(outcome));
        }),
    ) else {
        return 1;
    };
    let mut jobs = Jobs::default();
    let mut out = Vec::new();
    let now_ms = || started.elapsed().as_millis() as u64;
    let code = loop {
        match inbox.recv_timeout(TICK) {
            Ok(Event::Frame(frame)) => {
                match ControlFrame::<ToMedia>::decode(&frame, lane("image.job")) {
                    Ok(ControlFrame {
                        message:
                            ToMedia::ImageJob {
                                request,
                                deadline_ms,
                                inputs,
                                op,
                            },
                        payload,
                    }) => jobs.job(
                        request,
                        deadline_ms,
                        inputs,
                        op,
                        payload,
                        now_ms(),
                        &mut out,
                    ),
                    Ok(ControlFrame {
                        message: ToMedia::ImageCancel { request },
                        ..
                    }) => jobs.cancel(&request, &mut out),
                    // The image process takes image messages only.
                    _ => break 2,
                }
            }
            Ok(Event::Outcome(outcome)) => jobs.finished(outcome, &mut out),
            Ok(Event::End) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                jobs.finish(&mut out);
                apply(&mut out, &threads, &output);
                break 0;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        jobs.tick(now_ms(), &mut out);
        apply(&mut out, &threads, &output);
        if output.failed() {
            break 1;
        }
        if threads.stuck(started.elapsed().as_micros() as u64, STUCK_GRACE_US) {
            eprintln!("ace-media images: a job is stuck past its deadline");
            break 1;
        }
    };
    drop(threads);
    output.finish();
    code
}

fn apply(out: &mut Vec<Out>, threads: &ImageThreads, output: &Output) {
    for next in out.drain(..) {
        match next {
            Out::Run(work) => threads.submit(work),
            Out::Stop(token) => threads.stop(token),
            Out::Reply(message, payload) => {
                let request = match &message {
                    FromMedia::ImageDone { request, .. }
                    | FromMedia::ImageFailed { request, .. } => Some(request.clone()),
                    _ => None,
                };
                let large = !payload.is_empty();
                let Some(frame) = encode(message, payload) else {
                    continue;
                };
                if !large {
                    output.push_small(frame);
                } else if !output.push(frame)
                    && let Some(request) = request
                    && let Some(refusal) = encode(
                        FromMedia::ImageFailed {
                            request,
                            reason: ImageFailure::Busy,
                            message:
                                "The daemon is behind on reading images; this one was dropped."
                                    .into(),
                        },
                        Vec::new(),
                    )
                {
                    output.push_small(refusal);
                }
            }
        }
    }
}

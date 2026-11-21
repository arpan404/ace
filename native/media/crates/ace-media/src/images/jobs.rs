// SPDX-License-Identifier: Apache-2.0
//! One-shot image jobs (ADR 0201) as the image process tracks them: which requests wait, when
//! each one's deadline passes, and that each is answered exactly once. Pure: the server feeds
//! messages, results and ticks in, and carries out what comes back as [`Out`]. A result counts
//! only while its request still waits on the same token, so one from before a cancel, a
//! deadline or a reused id is dropped.
use media_wire::control::{FromMedia, Id};
use media_wire::image::{ImageFailure, ImageInput, ImageOp};
use std::collections::HashMap;
use zeroize::Zeroizing;

/// Jobs held at once; more are refused `busy`.
pub const MAX_JOBS: usize = 64;

/// A job for an image thread.
pub struct ImageWork {
    pub token: u64,
    pub inputs: Vec<ImageInput>,
    pub op: ImageOp,
    /// The `bytes` and `rgba` inputs, back to back.
    pub payload: Zeroizing<Vec<u8>>,
    /// The image process's monotonic microseconds past which the job stops.
    pub deadline_us: u64,
}

/// Names only: an image's bytes are never printed.
impl std::fmt::Debug for ImageWork {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ImageWork({}, {} inputs)", self.token, self.inputs.len())
    }
}

/// What an image thread made of a job.
pub struct ImageOutcome {
    pub token: u64,
    pub result: Result<media_image::Done, media_image::Failed>,
}

/// What the server does next.
pub enum Out {
    /// Queue the job on the image threads.
    Run(ImageWork),
    /// Take the job off the queue, or stop it at its next step: nobody waits for it now.
    Stop(u64),
    /// Send this answer, with its payload.
    Reply(FromMedia, Vec<u8>),
}

struct Waiting {
    request: Id,
    deadline_ms: u64,
}

#[derive(Default)]
pub struct Jobs {
    /// By token.
    waiting: HashMap<u64, Waiting>,
    next: u64,
}

fn failed(out: &mut Vec<Out>, request: Id, reason: ImageFailure, message: &str) {
    out.push(Out::Reply(
        FromMedia::ImageFailed {
            request,
            reason,
            message: message.into(),
        },
        Vec::new(),
    ));
}

impl Jobs {
    fn token_of(&self, request: &Id) -> Option<u64> {
        self.waiting
            .iter()
            .find(|(_, w)| w.request == *request)
            .map(|(token, _)| *token)
    }

    /// `image.job`: handed to the image threads, or refused at once.
    #[allow(clippy::too_many_arguments)]
    pub fn job(
        &mut self,
        request: Id,
        deadline_ms: u32,
        inputs: Vec<ImageInput>,
        op: ImageOp,
        payload: Zeroizing<Vec<u8>>,
        now_ms: u64,
        out: &mut Vec<Out>,
    ) {
        if self.token_of(&request).is_some() {
            return failed(
                out,
                request,
                ImageFailure::Invalid,
                "A job with this request id is already running.",
            );
        }
        if self.waiting.len() >= MAX_JOBS {
            return failed(
                out,
                request,
                ImageFailure::Busy,
                "The image process is holding as many jobs as it takes.",
            );
        }
        self.next += 1;
        let token = self.next;
        let deadline_ms = now_ms + u64::from(deadline_ms);
        self.waiting.insert(
            token,
            Waiting {
                request,
                deadline_ms,
            },
        );
        out.push(Out::Run(ImageWork {
            token,
            inputs,
            op,
            payload,
            deadline_us: deadline_ms.saturating_mul(1000),
        }));
    }

    /// `image.cancel`: answered `cancelled`, the work stopped, its result dropped when it comes.
    pub fn cancel(&mut self, request: &Id, out: &mut Vec<Out>) {
        if let Some(token) = self.token_of(request)
            && let Some(waiting) = self.waiting.remove(&token)
        {
            failed(
                out,
                waiting.request,
                ImageFailure::Cancelled,
                "The daemon cancelled the job.",
            );
            out.push(Out::Stop(token));
        }
    }

    /// An image thread's result, for its job if that still waits.
    pub fn finished(&mut self, outcome: ImageOutcome, out: &mut Vec<Out>) {
        let Some(waiting) = self.waiting.remove(&outcome.token) else {
            return;
        };
        match outcome.result {
            Ok(done) => out.push(Out::Reply(
                FromMedia::ImageDone {
                    request: waiting.request,
                    width: done.width,
                    height: done.height,
                    format: done.format,
                    source: done.source,
                },
                done.bytes,
            )),
            Err(f) => failed(out, waiting.request, f.reason, &f.message),
        }
    }

    /// Jobs past their deadline fail now and are stopped, whether or not they have started.
    pub fn tick(&mut self, now_ms: u64, out: &mut Vec<Out>) {
        let mut expired: Vec<u64> = self
            .waiting
            .iter()
            .filter(|(_, w)| now_ms >= w.deadline_ms)
            .map(|(token, _)| *token)
            .collect();
        expired.sort_unstable();
        for token in expired {
            if let Some(waiting) = self.waiting.remove(&token) {
                failed(
                    out,
                    waiting.request,
                    ImageFailure::Deadline,
                    "The image job ran past its deadline.",
                );
                out.push(Out::Stop(token));
            }
        }
    }

    /// Shutdown: every job still waiting fails.
    pub fn finish(&mut self, out: &mut Vec<Out>) {
        let mut tokens: Vec<u64> = self.waiting.keys().copied().collect();
        tokens.sort_unstable();
        for token in tokens {
            if let Some(waiting) = self.waiting.remove(&token) {
                failed(
                    out,
                    waiting.request,
                    ImageFailure::Shutdown,
                    "ace-media's image process is shutting down.",
                );
                out.push(Out::Stop(token));
            }
        }
    }

    /// Jobs waiting for their answer.
    pub fn waiting(&self) -> usize {
        self.waiting.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use media_wire::image::{DoneFormat, SourceFormat, SourceImage};

    fn id(value: &str) -> Id {
        Id::new(value.into()).unwrap_or_else(|_| unreachable!())
    }
    fn job(jobs: &mut Jobs, request: &str, deadline_ms: u32, now_ms: u64) -> Vec<Out> {
        let mut out = Vec::new();
        jobs.job(
            id(request),
            deadline_ms,
            vec![ImageInput::Bytes { bytes: 2 }],
            ImageOp::Probe { max_pixels: 4096 },
            Zeroizing::new(vec![1, 2]),
            now_ms,
            &mut out,
        );
        out
    }
    fn runs(out: &[Out]) -> Vec<u64> {
        out.iter()
            .filter_map(|o| match o {
                Out::Run(work) => Some(work.token),
                _ => None,
            })
            .collect()
    }
    fn stops(out: &[Out]) -> Vec<u64> {
        out.iter()
            .filter_map(|o| match o {
                Out::Stop(token) => Some(*token),
                _ => None,
            })
            .collect()
    }
    /// `(request, reason)` of each `image.failed`, and the request of each `image.done`.
    fn answers(out: &[Out]) -> Vec<(String, Option<ImageFailure>)> {
        out.iter()
            .filter_map(|o| match o {
                Out::Reply(
                    FromMedia::ImageFailed {
                        request, reason, ..
                    },
                    _,
                ) => Some((request.get().to_owned(), Some(*reason))),
                Out::Reply(FromMedia::ImageDone { request, .. }, _) => {
                    Some((request.get().to_owned(), None))
                }
                _ => None,
            })
            .collect()
    }
    fn done(token: u64) -> ImageOutcome {
        ImageOutcome {
            token,
            result: Ok(media_image::Done {
                width: 2,
                height: 1,
                format: DoneFormat::None,
                source: SourceImage {
                    format: SourceFormat::Png,
                    width: 2,
                    height: 1,
                    orientation: 1,
                },
                bytes: Vec::new(),
            }),
        }
    }
    fn finished(jobs: &mut Jobs, outcome: ImageOutcome) -> Vec<Out> {
        let mut out = Vec::new();
        jobs.finished(outcome, &mut out);
        out
    }

    #[test]
    fn a_job_goes_to_the_image_threads_and_its_result_answers_it_once() {
        let mut jobs = Jobs::default();
        let tokens = runs(&job(&mut jobs, "i1", 1000, 0));
        assert_eq!(tokens.len(), 1);
        assert_eq!(
            answers(&finished(&mut jobs, done(tokens[0]))),
            [("i1".into(), None)]
        );
        assert!(answers(&finished(&mut jobs, done(tokens[0]))).is_empty());
        assert!(answers(&finished(&mut jobs, done(999))).is_empty());
        assert_eq!(jobs.waiting(), 0);
    }

    #[test]
    fn a_cancelled_job_is_answered_cancelled_its_work_stopped_and_its_late_result_dropped() {
        let mut jobs = Jobs::default();
        let token = runs(&job(&mut jobs, "i1", 1000, 0))[0];
        let mut out = Vec::new();
        jobs.cancel(&id("i1"), &mut out);
        assert_eq!(
            answers(&out),
            [("i1".into(), Some(ImageFailure::Cancelled))]
        );
        assert_eq!(stops(&out), [token]);
        assert!(answers(&finished(&mut jobs, done(token))).is_empty());
        let again = runs(&job(&mut jobs, "i1", 1000, 0))[0];
        assert_ne!(again, token);
        assert!(answers(&finished(&mut jobs, done(token))).is_empty());
        assert_eq!(
            answers(&finished(&mut jobs, done(again))),
            [("i1".into(), None)]
        );
    }

    #[test]
    fn a_job_past_its_deadline_fails_on_the_tick_and_is_stopped() {
        let mut jobs = Jobs::default();
        let token = runs(&job(&mut jobs, "slow", 200, 1000))[0];
        let mut out = Vec::new();
        jobs.tick(1199, &mut out);
        assert!(out.is_empty());
        jobs.tick(1200, &mut out);
        assert_eq!(
            answers(&out),
            [("slow".into(), Some(ImageFailure::Deadline))]
        );
        assert_eq!(stops(&out), [token]);
        assert!(answers(&finished(&mut jobs, done(token))).is_empty());
    }

    #[test]
    fn past_the_job_bound_a_job_is_refused_busy_and_a_running_id_is_refused_invalid() {
        let mut jobs = Jobs::default();
        for n in 0..MAX_JOBS {
            assert_eq!(runs(&job(&mut jobs, &format!("i{n}"), 1000, 0)).len(), 1);
        }
        let out = job(&mut jobs, "one-more", 1000, 0);
        assert!(runs(&out).is_empty());
        assert_eq!(
            answers(&out),
            [("one-more".into(), Some(ImageFailure::Busy))]
        );
        assert_eq!(
            answers(&job(&mut jobs, "i0", 1000, 0)),
            [("i0".into(), Some(ImageFailure::Invalid))]
        );
    }

    #[test]
    fn shutdown_fails_every_waiting_job() {
        let mut jobs = Jobs::default();
        job(&mut jobs, "a", 1000, 0);
        job(&mut jobs, "b", 1000, 0);
        let mut out = Vec::new();
        jobs.finish(&mut out);
        assert_eq!(
            answers(&out),
            [
                ("a".into(), Some(ImageFailure::Shutdown)),
                ("b".into(), Some(ImageFailure::Shutdown))
            ]
        );
    }
}

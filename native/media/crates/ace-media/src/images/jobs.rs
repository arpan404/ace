// SPDX-License-Identifier: Apache-2.0
//! One-shot image jobs (ADR 0201), as the engine sees them: which requests wait, when each
//! one's deadline passes, and that each is answered exactly once. The work itself runs on the
//! shell's image threads ([`crate::images`]); a result counts only while its request still
//! waits on the same token, so one from before a cancel, a deadline or a reused id is dropped.
use super::{Effect, normal};
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
    /// ace-media's monotonic microseconds past which the thread stops the job.
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

struct Waiting {
    request: Id,
    deadline_ms: u64,
}

#[derive(Default)]
pub struct Images {
    /// By token.
    waiting: HashMap<u64, Waiting>,
    next: u64,
}

fn failed(out: &mut Vec<Effect>, request: Id, reason: ImageFailure, message: &str) {
    normal(
        out,
        FromMedia::ImageFailed {
            request,
            reason,
            message: message.into(),
        },
    );
}

impl Images {
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
        out: &mut Vec<Effect>,
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
                "ace-media is holding as many image jobs as it takes.",
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
        out.push(Effect::Image(ImageWork {
            token,
            inputs,
            op,
            payload,
            deadline_us: deadline_ms.saturating_mul(1000),
        }));
    }

    /// `image.cancel`: answered `cancelled`, and its result dropped when it comes.
    pub fn cancel(&mut self, request: &Id, out: &mut Vec<Effect>) {
        if let Some(token) = self.token_of(request)
            && let Some(waiting) = self.waiting.remove(&token)
        {
            failed(
                out,
                waiting.request,
                ImageFailure::Cancelled,
                "The daemon cancelled the job.",
            );
        }
    }

    /// An image thread's result, for its job if that still waits.
    pub fn finished(&mut self, outcome: ImageOutcome, out: &mut Vec<Effect>) {
        let Some(waiting) = self.waiting.remove(&outcome.token) else {
            return;
        };
        match outcome.result {
            Ok(done) => out.push(Effect::NormalWith(
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

    /// Jobs past their deadline fail now, whether or not their thread has started them.
    pub fn tick(&mut self, now_ms: u64, out: &mut Vec<Effect>) {
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
            }
        }
    }

    /// Shutdown: every job still waiting fails.
    pub fn finish(&mut self, out: &mut Vec<Effect>) {
        let mut tokens: Vec<u64> = self.waiting.keys().copied().collect();
        tokens.sort_unstable();
        for token in tokens {
            if let Some(waiting) = self.waiting.remove(&token) {
                failed(
                    out,
                    waiting.request,
                    ImageFailure::Shutdown,
                    "ace-media is shutting down.",
                );
            }
        }
    }

    /// Jobs waiting for their answer.
    pub fn waiting(&self) -> usize {
        self.waiting.len()
    }
}

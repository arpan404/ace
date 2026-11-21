// SPDX-License-Identifier: Apache-2.0
//! `ace-media --image`: one `image.job` control frame on stdin, its `image.done` or
//! `image.failed` frame on stdout, then exit 0 (2 when stdin isn't one valid job). The same
//! work as the image threads, for tests and tools that have no supervisor (ADR 0201 §8).
use crate::engine::images::ImageWork;
use media_wire::control::{ControlFrame, FromMedia, ToMedia, lane};
use std::io::{Read, Write};
use std::time::Instant;
use zeroize::Zeroizing;

/// The answer frame for one job frame, or `None` when the bytes aren't one.
pub fn answer(frame: &[u8], started: Instant) -> Option<Vec<u8>> {
    let job = ControlFrame::<ToMedia>::decode(frame, lane("image.job")).ok()?;
    let ToMedia::ImageJob {
        request,
        deadline_ms,
        inputs,
        op,
    } = job.message
    else {
        return None;
    };
    let deadline_us = started.elapsed().as_micros() as u64 + u64::from(deadline_ms) * 1000;
    let work = ImageWork {
        token: 0,
        inputs,
        op,
        payload: job.payload,
        deadline_us,
    };
    let expired = || started.elapsed().as_micros() as u64 >= deadline_us;
    let (message, payload) = match crate::images::execute(&work, &expired) {
        Ok(done) => (
            FromMedia::ImageDone {
                request,
                width: done.width,
                height: done.height,
                format: done.format,
                source: done.source,
            },
            done.bytes,
        ),
        Err(failed) => (
            FromMedia::ImageFailed {
                request,
                reason: failed.reason,
                message: failed.message,
            },
            Vec::new(),
        ),
    };
    let frame = ControlFrame {
        message,
        payload: Zeroizing::new(payload),
    };
    let mut bytes = frame.header(lane("image.done")).ok()?;
    bytes.extend_from_slice(&frame.payload);
    Some(bytes)
}

pub fn run() -> i32 {
    let started = Instant::now();
    let mut frame = Vec::new();
    // One normal-lane frame at most: 8 MiB and its length field.
    if std::io::stdin()
        .take(8 * 1024 * 1024 + 4)
        .read_to_end(&mut frame)
        .is_err()
    {
        return 2;
    }
    let Some(bytes) = answer(&frame, started) else {
        return 2;
    };
    let mut stdout = std::io::stdout().lock();
    if stdout
        .write_all(&bytes)
        .and_then(|()| stdout.flush())
        .is_err()
    {
        return 1;
    }
    0
}

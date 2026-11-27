// SPDX-License-Identifier: Apache-2.0
//! The git binding: values in, errors out, never logic. Each `#[napi]`
//! export catches panics and throws them as `git_failed` JS errors, which
//! the shells parse back into `GitError` so `instanceof` holds. Behaviour
//! lives in `ace-git`; G1 and later replace each probe with the port.

// napi-derive registers this module's exports only outside test builds, so in
// the lib test target every export reads as unused.
#![cfg_attr(test, allow(dead_code))]

pub mod bridge;
pub mod checkpoints;
pub mod core;
pub mod reads;
pub mod refs;
pub mod wire;
pub mod writes;

/// A `git_failed:{...}` error from an `ace_git` failure; the shell parses the payload.
pub(crate) fn failed(error: ace_git::error::Error) -> napi::Error {
    napi::Error::from_reason(format!("git_failed:{}", error.to_payload()))
}

/// A `git_failed` error for a panic the binding caught; never the daemon down.
pub(crate) fn unwind(context: &str) -> napi::Error {
    napi::Error::from_reason(format!(
        "git_failed:{{\"code\":\"git_failed\",\"message\":\"{context} panicked\",\"details\":{{\"stub\":false}}}}"
    ))
}

/// Runs `run` catching panics, mapping an `ace_git` failure and a panic to `git_failed`.
pub(crate) fn caught<T>(
    context: &'static str,
    run: impl FnOnce() -> Result<T, ace_git::error::Error>,
) -> napi::Result<T> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(run)) {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(failed(error)),
        Err(_) => Err(unwind(context)),
    }
}

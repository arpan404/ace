// SPDX-License-Identifier: Apache-2.0

//! A computer-use failure whose message is written for the model (`computer/errors.ts`).

use ace_json::Value;

use crate::catalog::{Refusal, catalog};

/// One failure: the `code` a tool result carries, the message the model reads, and what the
/// helper had done when the request was cancelled or overran (`errors.ts:1`-`:14`).
#[derive(Debug, Clone, PartialEq)]
pub struct ComputerError {
    pub code: String,
    pub message: String,
    /// The helper's reply when it replied after a cancel (an act lists the steps it finished).
    pub result: Option<Value>,
}

impl ComputerError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            result: None,
        }
    }

    /// A catalog refusal, as it is written.
    pub fn refusal(refusal: &Refusal) -> Self {
        Self::new(refusal.code.clone(), refusal.message.clone())
    }

    /// A catalog refusal whose message names something, e.g. why a helper did not start.
    pub fn refusal_with(refusal: &Refusal, name: &str, value: &str) -> Self {
        Self::new(
            refusal.code.clone(),
            crate::catalog::fill(refusal, name, value),
        )
    }

    /// The helper's reply, kept on a cancelled or overrun request.
    pub fn with_result(mut self, result: Option<Value>) -> Self {
        self.result = result;
        self
    }

    pub fn closed() -> Self {
        Self::refusal(&catalog().computer.closed)
    }

    pub fn stopped() -> Self {
        Self::refusal(&catalog().computer.stopped)
    }

    pub fn cancelled() -> Self {
        Self::refusal(&catalog().computer.cancelled)
    }

    pub fn timeout() -> Self {
        Self::refusal(&catalog().computer.timeout)
    }

    pub fn helper_exited() -> Self {
        Self::refusal(&catalog().computer.helper_exited)
    }

    pub fn helper_stopping() -> Self {
        Self::refusal(&catalog().computer.helper_stopping)
    }

    pub fn helper_unavailable() -> Self {
        Self::refusal(&catalog().computer.helper_unavailable)
    }

    pub fn helper_unavailable_with(message: &str) -> Self {
        Self::refusal_with(
            &catalog().computer.helper_unavailable_with,
            "message",
            message,
        )
    }

    /// A reply past `max_reply_bytes`, with the cap in whole megabytes (`helper-connection.ts:389`).
    pub fn reply_too_large(max_reply_bytes: usize) -> Self {
        let megabytes = ((max_reply_bytes as f64) / (1024.0 * 1024.0)).round() as i64;
        Self::refusal_with(
            &catalog().computer.reply_too_large,
            "mb",
            &megabytes.to_string(),
        )
    }
}

impl std::fmt::Display for ComputerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ComputerError {}

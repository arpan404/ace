// SPDX-License-Identifier: Apache-2.0

//! A computer-use failure whose message is written for the model (`computer/errors.ts`).

use ace_json::{JsString, Value};

use crate::catalog::{Refusal, catalog};

/// One failure: the `code` a tool result carries, the message the model reads, and what the
/// helper had done when the request was cancelled or overran (`errors.ts:1`-`:14`).
#[derive(Debug, Clone, PartialEq)]
pub struct ComputerError {
    // Boxed: the error crosses every closure in the crate, and two `JsString`s plus a result
    // make it too large to return by value cheaply.
    detail: Box<Detail>,
}

#[derive(Debug, Clone, PartialEq)]
struct Detail {
    code: JsString,
    message: JsString,
    /// The helper's reply when it replied after a cancel (an act lists the steps it finished).
    result: Option<Value>,
}

impl ComputerError {
    pub fn new(code: impl Into<JsString>, message: impl Into<JsString>) -> Self {
        Self {
            detail: Box::new(Detail {
                code: code.into(),
                message: message.into(),
                result: None,
            }),
        }
    }

    /// The code a tool result carries.
    pub fn code(&self) -> &JsString {
        &self.detail.code
    }

    /// The text the model reads.
    pub fn message(&self) -> &JsString {
        &self.detail.message
    }

    /// What the helper had done when a request was cancelled or overran.
    pub fn result(&self) -> Option<&Value> {
        self.detail.result.as_ref()
    }

    /// A catalog refusal, as it is written.
    pub fn refusal(refusal: &Refusal) -> Self {
        Self::new(refusal.code.as_str(), refusal.message.as_str())
    }

    /// A catalog refusal whose message names something, e.g. why a helper did not start.
    pub fn refusal_with(refusal: &Refusal, name: &str, value: &str) -> Self {
        Self::new(
            refusal.code.as_str(),
            crate::catalog::fill(refusal, name, value),
        )
    }

    /// The helper's reply, kept on a cancelled or overrun request.
    pub fn with_result(mut self, result: Option<Value>) -> Self {
        self.detail.result = result;
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
        formatter.write_str(self.detail.message.as_str())
    }
}

impl std::error::Error for ComputerError {}

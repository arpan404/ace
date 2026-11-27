// SPDX-License-Identifier: Apache-2.0
//! Sign-in answered `unavailable`, with the reason the client shows, from
//! `apps/daemon/src/services/login-refusal.ts`. The cause belongs to the daemon's redacting log
//! first, so a refused sign-in is never silent; the request itself is never logged, because an
//! API-key request carries a secret.

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LoginUnavailableReason {
    /// The login service is not running on this connection.
    NotRunning,
    /// The daemon is shutting down.
    Stopping,
    /// It failed unexpectedly and logged the cause.
    Error,
    /// The CLI's own terminal cannot be opened.
    NoTerminal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LoginError {
    Forbidden,
    Unavailable,
    Busy,
    NotFound,
    InvalidInput,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LoginReply {
    Ok(Box<crate::LoginProgress>),
    Err(LoginError),
    Unavailable(LoginUnavailableReason),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoginResult {
    pub request_id: String,
    pub result: LoginReply,
}

impl LoginResult {
    pub fn ok(request_id: &str, progress: crate::LoginProgress) -> LoginResult {
        LoginResult {
            request_id: request_id.to_string(),
            result: LoginReply::Ok(Box::new(progress)),
        }
    }

    pub fn err(request_id: &str, error: LoginError) -> LoginResult {
        LoginResult {
            request_id: request_id.to_string(),
            result: LoginReply::Err(error),
        }
    }
}

/// The result a daemon answers when its login service cannot take the request at all.
pub fn unavailable_login(request_id: &str, reason: LoginUnavailableReason) -> LoginResult {
    LoginResult {
        request_id: request_id.to_string(),
        result: LoginReply::Unavailable(reason),
    }
}

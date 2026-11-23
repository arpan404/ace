// SPDX-License-Identifier: Apache-2.0
//! How a run ended, and the envelope a failed one prints (ADR 0178 §4).

use std::borrow::Cow;
use std::fmt;

use serde::Serialize;
use serde::ser::{SerializeMap, Serializer};

/// Every outcome a run can have; each has one exit code the desktop app reads too.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Ok,
    Failed,
    NeedsHuman,
    Timeout,
    Refused,
    Uncertain,
    AddressInUse,
    LockHeld,
    Usage,
    NewerData,
    IncompatibleData,
}

impl Outcome {
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Failed => "failed",
            Self::NeedsHuman => "needs-human",
            Self::Timeout => "timeout",
            Self::Refused => "refused",
            Self::Uncertain => "uncertain",
            Self::AddressInUse => "address-in-use",
            Self::LockHeld => "lock-held",
            Self::Usage => "usage",
            Self::NewerData => "newer-data",
            Self::IncompatibleData => "incompatible-data",
        }
    }

    /// The process exit code for this outcome (ADR 0178 §4).
    #[must_use]
    pub const fn exit_code(self) -> u8 {
        match self {
            Self::Ok => 0,
            Self::Failed => 1,
            Self::NeedsHuman => 2,
            Self::Timeout => 3,
            Self::Refused => 4,
            Self::Uncertain => 5,
            Self::AddressInUse => 6,
            Self::LockHeld => 7,
            Self::Usage => 64,
            Self::NewerData => 65,
            Self::IncompatibleData => 66,
        }
    }

    /// The error code an outcome uses when its failure names none.
    #[must_use]
    pub const fn default_code(self) -> ErrorCode {
        match self {
            Self::NeedsHuman => ErrorCode::NeedsHuman,
            Self::Timeout => ErrorCode::Timeout,
            Self::Refused => ErrorCode::Refused,
            Self::Uncertain => ErrorCode::Uncertain,
            Self::AddressInUse => ErrorCode::AddressInUse,
            Self::LockHeld => ErrorCode::LockHeld,
            Self::Usage => ErrorCode::BadArgument,
            Self::NewerData => ErrorCode::NewerData,
            Self::IncompatibleData => ErrorCode::IncompatibleData,
            Self::Ok | Self::Failed => ErrorCode::Failed,
        }
    }
}

impl fmt::Display for Outcome {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.name())
    }
}

/// Stable error codes an agent can branch on. New codes may be added; none is renamed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorCode {
    UnknownCommand,
    UnknownFlag,
    MissingArgument,
    BadArgument,
    TooManyArguments,
    RetiredCommand,
    Ambiguous,
    Refused,
    NotFound,
    DaemonDown,
    TurnedOff,
    Busy,
    Forbidden,
    Conflict,
    Suspended,
    Quota,
    NeedsHuman,
    SignedOut,
    Reauth,
    PersonOnly,
    Confirm,
    Failed,
    Blocked,
    CheckFailed,
    Internal,
    Timeout,
    Uncertain,
    AddressInUse,
    LockHeld,
    NewerData,
    IncompatibleData,
}

impl ErrorCode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::UnknownCommand => "unknown_command",
            Self::UnknownFlag => "unknown_flag",
            Self::MissingArgument => "missing_argument",
            Self::BadArgument => "bad_argument",
            Self::TooManyArguments => "too_many_arguments",
            Self::RetiredCommand => "retired_command",
            Self::Ambiguous => "ambiguous",
            Self::Refused => "refused",
            Self::NotFound => "not_found",
            Self::DaemonDown => "daemon_down",
            Self::TurnedOff => "turned_off",
            Self::Busy => "busy",
            Self::Forbidden => "forbidden",
            Self::Conflict => "conflict",
            Self::Suspended => "suspended",
            Self::Quota => "quota",
            Self::NeedsHuman => "needs_human",
            Self::SignedOut => "signed_out",
            Self::Reauth => "reauth",
            Self::PersonOnly => "person_only",
            Self::Confirm => "confirm",
            Self::Failed => "failed",
            Self::Blocked => "blocked",
            Self::CheckFailed => "check_failed",
            Self::Internal => "internal",
            Self::Timeout => "timeout",
            Self::Uncertain => "uncertain",
            Self::AddressInUse => "address_in_use",
            Self::LockHeld => "lock_held",
            Self::NewerData => "newer_data",
            Self::IncompatibleData => "incompatible_data",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// One problem a local check found, as the sentence a person reads.
#[derive(Clone, Debug, Serialize)]
pub struct Problem<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    pub message: Cow<'a, str>,
}

/// The key to retry an uncertain mutation with.
#[derive(Clone, Debug, Serialize)]
pub struct Retry<'a> {
    #[serde(rename = "idempotencyKey")]
    pub idempotency_key: Cow<'a, str>,
}

/// A failed command, as `--json` prints it and as the exit code follows from.
#[derive(Clone, Debug)]
pub struct Failure<'a> {
    pub outcome: Outcome,
    pub code: ErrorCode,
    pub error: Cow<'a, str>,
    pub hint: Option<Cow<'a, str>>,
    pub command: Option<&'static str>,
    pub argument: Option<Cow<'a, str>>,
    pub problems: Vec<Problem<'a>>,
    pub request: Option<Cow<'a, str>>,
    pub retry: Option<Retry<'a>>,
    /// What the daemon admitted, when a mutation's output failed after it was accepted.
    pub admission: Option<serde_json::Value>,
}

impl<'a> Failure<'a> {
    #[must_use]
    pub fn new(outcome: Outcome, error: impl Into<Cow<'a, str>>) -> Self {
        Self {
            outcome,
            code: outcome.default_code(),
            error: error.into(),
            hint: None,
            command: None,
            argument: None,
            problems: Vec::new(),
            request: None,
            retry: None,
            admission: None,
        }
    }

    /// A command line that was wrong: exit 64, with the argument and the next step.
    #[must_use]
    pub fn usage(error: impl Into<Cow<'a, str>>) -> Self {
        Self::new(Outcome::Usage, error)
    }

    #[must_use]
    pub fn with_code(mut self, code: ErrorCode) -> Self {
        self.code = code;
        self
    }

    #[must_use]
    pub fn with_hint(mut self, hint: impl Into<Cow<'a, str>>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    #[must_use]
    pub fn with_argument(mut self, argument: impl Into<Cow<'a, str>>) -> Self {
        self.argument = Some(argument.into());
        self
    }

    #[must_use]
    pub fn with_command(mut self, command: &'static str) -> Self {
        self.command = Some(command);
        self
    }

    /// The hint an uncertain mutation prints when it named none: how to retry safely.
    #[must_use]
    pub fn resolved_hint(&self) -> Option<Cow<'a, str>> {
        if self.hint.is_some() {
            return self.hint.clone();
        }
        if self.outcome == Outcome::Uncertain
            && let Some(retry) = &self.retry
        {
            return Some(Cow::Owned(format!(
                "Retry with --idempotency-key {} to make sure it ran once.",
                retry.idempotency_key
            )));
        }
        None
    }
}

impl Serialize for Failure<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("ok", &false)?;
        if let Some(command) = self.command {
            map.serialize_entry("command", command)?;
        }
        map.serialize_entry("status", self.outcome.name())?;
        map.serialize_entry("code", self.code.as_str())?;
        map.serialize_entry("error", self.error.as_ref())?;
        if let Some(hint) = self.resolved_hint() {
            map.serialize_entry("hint", hint.as_ref())?;
        }
        if let Some(argument) = &self.argument {
            map.serialize_entry("argument", argument.as_ref())?;
        }
        if !self.problems.is_empty() {
            map.serialize_entry("problems", &self.problems)?;
        }
        if let Some(request) = &self.request {
            map.serialize_entry("request", request.as_ref())?;
        }
        if let Some(retry) = &self.retry {
            map.serialize_entry("retry", retry)?;
        }
        if let Some(admission) = &self.admission {
            map.serialize_entry("admission", admission)?;
        }
        map.end()
    }
}

impl std::error::Error for Failure<'_> {}

impl fmt::Display for Failure<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.error)
    }
}

/// `✕ No thread starting t_9f2c.` then the next step, indented under it (ADR 0178 §4).
#[must_use]
pub fn human_error(failure: &Failure<'_>, paint: Option<&str>) -> String {
    let mut text = String::new();
    match paint {
        Some(paint) => {
            text.push_str(paint);
            text.push('✕');
            text.push_str("\u{1b}[39m ");
        }
        None => text.push_str("✕ "),
    }
    text.push_str(&failure.error);
    text.push('\n');
    if let Some(hint) = failure.resolved_hint() {
        text.push_str("  ");
        text.push_str(&hint);
        text.push('\n');
    }
    for problem in &failure.problems {
        text.push_str("  ");
        if let Some(path) = problem.path {
            text.push_str(path);
            if let Some(line) = problem.line {
                text.push(':');
                text.push_str(&line.to_string());
            }
            text.push_str(": ");
        }
        text.push_str(&problem.message);
        text.push('\n');
    }
    text
}

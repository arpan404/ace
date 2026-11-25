// SPDX-License-Identifier: Apache-2.0
//! The device platform behind `@ace/devices` (ADR 0225, docs/devices/behaviour.md).
//!
//! D3.1 replaces the platform's identity checks, its package lifecycle and the emulator
//! discovery reads; each function here is the decision `packages/devices/src` takes, with no
//! I/O of its own, so the TypeScript shell runs the SDK command and this crate says which
//! command, with which arguments, or which `DeviceError` refuses it. Words come from
//! `native/daemon/catalog/devices.json` ([`words`]); every result serializes through `ace-json`.
pub mod android_ui;
pub mod boot;
pub mod budget;
pub mod clipboard;
pub mod commands;
pub mod device_input;
pub mod emulator;
pub mod fingers;
pub mod h264;
pub mod helper;
pub mod http;
pub mod identity;
pub mod jpeg;
pub mod keys;
pub mod lifecycle;
pub mod list;
pub mod log_line;
pub mod media_paths;
pub mod mjpeg;
pub mod one_off_screenshot;
pub mod posture;
pub mod recording_limits;
pub mod scrcpy;
pub mod screens;
pub mod sdk;
pub mod serve_sim;
pub mod simulator_avcc;
pub mod simulator_ax;
pub mod simulator_frames;
pub mod simulator_jpeg;
pub mod simulator_rotation;
pub mod simulator_source_rate;
pub mod simulator_ui;
pub mod simulators;
pub mod still_writer;
pub mod tools;
pub mod words;

use serde::{Deserialize, Serialize};

/// A device platform, as `AppDevice.platform` names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Ios,
    Android,
}

impl Platform {
    /// Reads a caller's `platform` string; anything else is the caller's bug, not a device fact.
    pub fn parse(text: &str) -> Result<Self, Error> {
        match text {
            "ios" => Ok(Self::Ios),
            "android" => Ok(Self::Android),
            other => Err(Error::Invalid(format!("unknown device platform: {other}"))),
        }
    }
}

/// The `DeviceFailure` codes of `@ace/protocol/devices`, in the schema's order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Code {
    SdkMissing,
    ToolMissing,
    NotSupported,
    ForegroundRequired,
    NotFound,
    NotBooted,
    PermissionDenied,
    Busy,
    Timeout,
    CommandFailed,
    InvalidData,
    LeaseRequired,
    StaleRef,
    Limit,
    PersonBusy,
}

impl Code {
    /// The wire spelling: `not_booted`, `invalid_data`, and so on.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SdkMissing => "sdk_missing",
            Self::ToolMissing => "tool_missing",
            Self::NotSupported => "not_supported",
            Self::ForegroundRequired => "foreground_required",
            Self::NotFound => "not_found",
            Self::NotBooted => "not_booted",
            Self::PermissionDenied => "permission_denied",
            Self::Busy => "busy",
            Self::Timeout => "timeout",
            Self::CommandFailed => "command_failed",
            Self::InvalidData => "invalid_data",
            Self::LeaseRequired => "lease_required",
            Self::StaleRef => "stale_ref",
            Self::Limit => "limit",
            Self::PersonBusy => "person_busy",
        }
    }

    /// A code read back from the catalog, so a typo there fails its test rather than a device call.
    pub fn parse(text: &str) -> Option<Self> {
        ALL.iter().copied().find(|code| code.as_str() == text)
    }
}

/// Reads a code from its wire spelling; the protocol's schema does the same before it reaches
/// a device call.
impl<'de> Deserialize<'de> for Code {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Self::parse(&text)
            .ok_or_else(|| serde::de::Error::custom(format!("unknown device failure code: {text}")))
    }
}

/// Every code, so [`Code::parse`] never needs serde's error path.
pub const ALL: [Code; 15] = [
    Code::SdkMissing,
    Code::ToolMissing,
    Code::NotSupported,
    Code::ForegroundRequired,
    Code::NotFound,
    Code::NotBooted,
    Code::PermissionDenied,
    Code::Busy,
    Code::Timeout,
    Code::CommandFailed,
    Code::InvalidData,
    Code::LeaseRequired,
    Code::StaleRef,
    Code::Limit,
    Code::PersonBusy,
];

/// A device failure whose message is data (a device's name, a provider's text), as opposed to
/// a catalog word: today's `DeviceError` with the same three fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Failure {
    pub code: Code,
    pub message: String,
    pub hint: String,
}

/// A refused device operation: today's `DeviceError`, byte for byte.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Refusal {
    pub code: Code,
    pub message: &'static str,
    pub hint: &'static str,
}

impl Refusal {
    /// A refusal the catalog names by `key`; a missing key is a build-time test failure.
    pub fn word(key: &str) -> Self {
        words::refusal(key)
    }
}

/// The one error type of the crate.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// A device operation the person can fix, said with today's code, message and hint.
    #[error("{}: {}", .0.code.as_str(), .0.message)]
    Refused(Refusal),
    /// A failure whose words are data rather than a catalog word.
    #[error("{}: {}", .0.code.as_str(), .0.message)]
    Failed(Failure),
    /// A caller passed something this crate cannot read: a daemon bug, never device data.
    #[error("{0}")]
    Invalid(String),
}

impl From<Refusal> for Error {
    fn from(refusal: Refusal) -> Self {
        Self::Refused(refusal)
    }
}

impl From<Failure> for Error {
    fn from(failure: Failure) -> Self {
        Self::Failed(failure)
    }
}

/// One SDK command the shell runs, decided here: which tool, its arguments, its bounds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Step {
    /// `simctl` (through `xcrun simctl`), or `adb` for the device's own transport.
    pub kind: StepKind,
    pub args: Vec<String>,
    #[serde(rename = "maxBytes", skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<u64>,
    #[serde(rename = "timeoutMs", skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

impl Step {
    pub fn new(kind: StepKind, args: Vec<String>) -> Self {
        Self {
            kind,
            args,
            max_bytes: None,
            timeout_ms: None,
        }
    }

    pub fn with_max_bytes(mut self, max_bytes: u64) -> Self {
        self.max_bytes = Some(max_bytes);
        self
    }

    pub fn with_timeout(mut self, timeout_ms: u64) -> Self {
        self.timeout_ms = Some(timeout_ms);
        self
    }
}

/// Which tool a [`Step`] runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StepKind {
    Simctl,
    Adb,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_parses_back_from_its_wire_spelling() {
        for code in ALL {
            assert_eq!(Code::parse(code.as_str()), Some(code));
        }
        assert_eq!(Code::parse("not-a-code"), None);
    }

    #[test]
    fn a_refusal_serializes_as_the_protocols_failure_fields() {
        let text =
            ace_json::ser::to_string(&Refusal::word("localeUnsupported")).expect("serializes");
        assert_eq!(
            text,
            r#"{"code":"not_supported","message":"Runtime locale configuration is not supported by the installed public CLI contract","hint":"Change language in the device Settings app, then restart the app."}"#
        );
    }
}

// SPDX-License-Identifier: Apache-2.0
//! Typed device error codes and failures, serialized via `ace-json` in
//! `DeviceFailure` schema key order (`packages/protocol/src/devices.ts`).

use ace_json::{JsString, ObjectWriter, Value, write_js_string};
use thiserror::Error;

/// Maximum UTF-16 code units kept for a failure's message or hint (`failure.ts:10-11`).
pub const MAX_FAILURE_TEXT_UTF16: usize = 2048;

/// Every `DeviceFailure["code"]` value from `@ace/protocol/devices`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DeviceErrorCode {
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

impl DeviceErrorCode {
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

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "sdk_missing" => Self::SdkMissing,
            "tool_missing" => Self::ToolMissing,
            "not_supported" => Self::NotSupported,
            "foreground_required" => Self::ForegroundRequired,
            "not_found" => Self::NotFound,
            "not_booted" => Self::NotBooted,
            "permission_denied" => Self::PermissionDenied,
            "busy" => Self::Busy,
            "timeout" => Self::Timeout,
            "command_failed" => Self::CommandFailed,
            "invalid_data" => Self::InvalidData,
            "lease_required" => Self::LeaseRequired,
            "stale_ref" => Self::StaleRef,
            "limit" => Self::Limit,
            "person_busy" => Self::PersonBusy,
            _ => return None,
        })
    }
}

/// The macOS privacy permission named on a `DeviceFailure`, when applicable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DevicePermission {
    ScreenRecording,
    Accessibility,
}

impl DevicePermission {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ScreenRecording => "screenRecording",
            Self::Accessibility => "accessibility",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "screenRecording" => Some(Self::ScreenRecording),
            "accessibility" => Some(Self::Accessibility),
            _ => None,
        }
    }
}

/// Platform tag on a `DeviceFailure` or `AppDevice`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DevicePlatformKind {
    Ios,
    Android,
}

impl DevicePlatformKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ios => "ios",
            Self::Android => "android",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "ios" => Some(Self::Ios),
            "android" => Some(Self::Android),
            _ => None,
        }
    }
}

/// Typed errors across `ace-devices`.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum DeviceError {
    #[error("{message}")]
    Coded {
        code: DeviceErrorCode,
        message: JsString,
        hint: JsString,
        permission: Option<DevicePermission>,
    },
    #[error("Device inventory subscriber limit ({limit})")]
    SubscriberLimit { limit: usize },
    #[error("invalid JSON input: {0}")]
    InvalidInput(String),
    #[error("adb protocol error: {0}")]
    AdbProtocol(String),
    #[error("io error: {0}")]
    Io(String),
    #[error("watch error: {0}")]
    Watch(String),
}

impl DeviceError {
    pub fn coded(
        code: DeviceErrorCode,
        message: impl Into<JsString>,
        hint: impl Into<JsString>,
    ) -> Self {
        Self::Coded {
            code,
            message: message.into(),
            hint: hint.into(),
            permission: None,
        }
    }

    /// The code this failure carries: a coded refusal's own, or `CommandFailed`
    /// for the transport-level ones, as `to_failure` reports them.
    pub fn code(&self) -> DeviceErrorCode {
        match self {
            Self::Coded { code, .. } => *code,
            _ => DeviceErrorCode::CommandFailed,
        }
    }

    pub fn to_failure(&self, platform: Option<DevicePlatformKind>) -> DeviceFailure {
        match self {
            Self::Coded {
                code,
                message,
                hint,
                permission,
            } => DeviceFailure {
                code: *code,
                message: truncate_utf16(message, MAX_FAILURE_TEXT_UTF16),
                hint: truncate_utf16(hint, MAX_FAILURE_TEXT_UTF16),
                permission: *permission,
                platform,
            },
            other => DeviceFailure {
                code: DeviceErrorCode::CommandFailed,
                message: truncate_utf16(&JsString::from(other.to_string()), MAX_FAILURE_TEXT_UTF16),
                hint: JsString::from("Check installed tools and device state, then retry."),
                permission: None,
                platform,
            },
        }
    }
}

/// Wire `DeviceFailure` (`packages/protocol/src/devices.ts:88-116`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceFailure {
    pub code: DeviceErrorCode,
    pub message: JsString,
    pub hint: JsString,
    pub permission: Option<DevicePermission>,
    pub platform: Option<DevicePlatformKind>,
}

impl DeviceFailure {
    /// Serializes in exact `DeviceFailure` schema key order:
    /// `code`, `message`, `hint`, `permission`?, `platform`?.
    pub fn write_json(&self, out: &mut String) {
        let mut obj = ObjectWriter::new(out);
        obj.str("code", self.code.as_str());
        obj.value("message", &Value::String(self.message.clone()));
        obj.value("hint", &Value::String(self.hint.clone()));
        if let Some(permission) = self.permission {
            obj.str("permission", permission.as_str());
        }
        if let Some(platform) = self.platform {
            obj.str("platform", platform.as_str());
        }
        obj.finish();
    }

    pub fn to_json_string(&self) -> String {
        let mut out = String::new();
        self.write_json(&mut out);
        out
    }

    /// Parses a `DeviceFailure` from an `ace_json::Value`.
    pub fn from_value(value: &Value) -> Result<Self, DeviceError> {
        let obj = value
            .as_object()
            .ok_or_else(|| DeviceError::InvalidInput("DeviceFailure must be an object".into()))?;
        let code_str = obj
            .get("code")
            .and_then(Value::as_str)
            .ok_or_else(|| DeviceError::InvalidInput("DeviceFailure.code missing".into()))?;
        let code = DeviceErrorCode::parse(code_str).ok_or_else(|| {
            DeviceError::InvalidInput(format!("unknown DeviceFailure.code: {code_str}"))
        })?;
        let message = obj
            .get("message")
            .and_then(Value::as_js_str)
            .cloned()
            .ok_or_else(|| DeviceError::InvalidInput("DeviceFailure.message missing".into()))?;
        let hint = obj
            .get("hint")
            .and_then(Value::as_js_str)
            .cloned()
            .ok_or_else(|| DeviceError::InvalidInput("DeviceFailure.hint missing".into()))?;
        let permission =
            match obj.get("permission") {
                None | Some(Value::Null) => None,
                Some(v) => {
                    let s = v.as_str().ok_or_else(|| {
                        DeviceError::InvalidInput("DeviceFailure.permission must be string".into())
                    })?;
                    Some(DevicePermission::parse(s).ok_or_else(|| {
                        DeviceError::InvalidInput(format!("unknown permission: {s}"))
                    })?)
                }
            };
        let platform =
            match obj.get("platform") {
                None | Some(Value::Null) => None,
                Some(v) => {
                    let s = v.as_str().ok_or_else(|| {
                        DeviceError::InvalidInput("DeviceFailure.platform must be string".into())
                    })?;
                    Some(DevicePlatformKind::parse(s).ok_or_else(|| {
                        DeviceError::InvalidInput(format!("unknown platform: {s}"))
                    })?)
                }
            };
        Ok(Self {
            code,
            message: truncate_utf16(&message, MAX_FAILURE_TEXT_UTF16),
            hint: truncate_utf16(&hint, MAX_FAILURE_TEXT_UTF16),
            permission,
            platform,
        })
    }
}

/// Slices a `JsString` to at most `max_units` UTF-16 code units, matching JS `.slice(0, max_units)`.
pub fn truncate_utf16(text: &JsString, max_units: usize) -> JsString {
    if text.len_utf16() <= max_units {
        return text.clone();
    }
    let units: Vec<u16> = text.units().take(max_units).collect();
    JsString::from_units(&units)
}

/// Writes a `JsString` as a JSON string literal.
pub fn write_js_field(out: &mut String, key: &str, value: &JsString, first: &mut bool) {
    if !std::mem::replace(first, false) {
        out.push(',');
    }
    ace_json::write_str(out, key);
    out.push(':');
    write_js_string(out, value);
}

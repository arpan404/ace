// SPDX-License-Identifier: Apache-2.0
//! The `sim_*` tools' results (`packages/devices/src/sim-tools.ts`): what a call
//! answers, the summary a start or stop gives, the refusal a device with no live
//! video still answers, the screenshot's note, and the public failure body.
//!
//! The failure's words come from M1's public error catalog (`ace-mcp`), which both
//! backends serve; only ace's own detail rides along.

use std::sync::OnceLock;

use ace_json::{Array, JsString, Map, Number, Value};
use regex::Regex;

use super::args::{ArgumentError, SimTool};
use crate::error::{DeviceErrorCode, DeviceFailure, DevicePermission};

/// The hint an Android device with no live video gives its agent.
pub const STILL_WORKS: [&str; 3] = ["sim_act input", "sim_screenshot", "sim_ui"];

/// One `sim_*` tool's outcome, before an MCP or CLI surface renders it.
#[derive(Debug, Clone, PartialEq)]
pub enum SimResult {
    Json(Value),
    /// A still: the frame's sequence, the picture the shell encoded, and its note.
    Image {
        sim_id: String,
        sequence: f64,
        note: String,
    },
}

/// The public codes a device failure may carry: every `DeviceFailure["code"]` is a
/// member of `PublicToolCode` (`packages/mcp-server/src/public-error.ts`), so a
/// device refusal keeps its own code at the tool boundary.
const PUBLIC_CODES: [&str; 15] = [
    "sdk_missing",
    "tool_missing",
    "not_supported",
    "foreground_required",
    "not_found",
    "not_booted",
    "permission_denied",
    "busy",
    "timeout",
    "command_failed",
    "invalid_data",
    "lease_required",
    "stale_ref",
    "limit",
    "person_busy",
];

/// `AppDeviceId`: `ios:` and 36 hex or hyphen characters, or `android:` and 1-200
/// of JavaScript's ASCII `\w` plus `.` and `-`.
fn device_id_pattern() -> Option<&'static Regex> {
    static PATTERN: OnceLock<Option<Regex>> = OnceLock::new();
    PATTERN
        .get_or_init(|| {
            Regex::new(r"^(?:ios:[0-9a-fA-F-]{36}|android:(?-u:[a-zA-Z0-9_.-]{1,200}))$").ok()
        })
        .as_ref()
}

fn js_string(value: &Value) -> Option<JsString> {
    value.as_js_str().cloned()
}

fn optional_string(device: &Map, key: &str) -> bool {
    let Some(value) = device.get(key) else {
        return true;
    };
    let Some(text) = value.as_str() else {
        return false;
    };
    text.chars().count() <= 256
}

fn valid_device(device: &Map) -> bool {
    let (Some(id), Some(name), Some(state), Some(platform)) = (
        device.get("id").and_then(Value::as_str),
        device.get("name").and_then(Value::as_str),
        device.get("state").and_then(Value::as_str),
        device.get("platform").and_then(Value::as_str),
    ) else {
        return false;
    };
    if name.is_empty() || name.chars().count() > 256 {
        return false;
    }
    if !device_id_pattern().is_some_and(|pattern| pattern.is_match(id)) {
        return false;
    }
    if platform != "ios" && platform != "android" {
        return false;
    }
    if !matches!(state, "booted" | "shutdown" | "offline" | "unauthorized") {
        return false;
    }
    optional_string(device, "runtime")
        && optional_string(device, "serial")
        && optional_string(device, "model")
}

fn valid_posture(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|posture| matches!(posture, "closed" | "partiallyOpen" | "open"))
}

/// `summary`: what an agent needs after taking or releasing a simulator, not the
/// full device state. A value that does not parse is returned as it is.
pub fn summary(raw: &Value) -> Value {
    let Some(object) = raw.as_object() else {
        return raw.clone();
    };
    let Some(device) = object.get("device").and_then(Value::as_object) else {
        return raw.clone();
    };
    if !valid_device(device) {
        return raw.clone();
    }
    let Some(id) = device.get("id").and_then(js_string) else {
        return raw.clone();
    };
    let Some(name) = device.get("name").and_then(js_string) else {
        return raw.clone();
    };
    let Some(state) = device.get("state").and_then(js_string) else {
        return raw.clone();
    };
    let (Some(lifecycle), Some(controller)) = (
        object.get("lifecycle").and_then(js_string),
        object.get("controller").and_then(js_string),
    ) else {
        return raw.clone();
    };
    if let Some(posture) = object.get("posture")
        && !valid_posture(posture)
    {
        return raw.clone();
    }
    let mut out = Map::new();
    out.insert("simId", Value::String(id));
    out.insert("name", Value::String(name));
    out.insert("state", Value::String(state));
    out.insert("lifecycle", Value::String(lifecycle));
    out.insert("controller", Value::String(controller));
    if let Some(posture) = object.get("posture") {
        out.insert("posture", posture.clone());
    }
    Value::Object(out)
}

/// `androidWithoutVideo`: the live-view refusal an Android device keeps control
/// through, so its agent drives it through adb, input and screencast stills.
pub fn android_without_video(code: DeviceErrorCode, sim_id: &str) -> bool {
    code == DeviceErrorCode::NotSupported && sim_id.starts_with("android:")
}

/// The answer an Android device with no live video gives instead of a start.
pub fn without_video(sim_id: &str, message: &JsString, hint: &JsString) -> Value {
    let mut out = Map::new();
    out.insert("simId", Value::String(JsString::from(sim_id)));
    out.insert("liveView", Value::String(JsString::from("unavailable")));
    out.insert("reason", Value::String(message.clone()));
    out.insert("hint", Value::String(hint.clone()));
    out.insert(
        "stillWorks",
        Value::Array(Array::from(
            STILL_WORKS
                .iter()
                .map(|entry| Value::String(JsString::from(*entry)))
                .collect::<Vec<_>>(),
        )),
    );
    Value::Object(out)
}

/// The how-to rides on an agent's first start of a device only (`sim-tools.ts:99`).
pub fn with_guidance(started: Value, first_start: bool, guidance: &str) -> Value {
    let Value::Object(mut object) = started else {
        return started;
    };
    if first_start {
        object.insert("guide", Value::String(JsString::from(guidance)));
    }
    Value::Object(object)
}

/// `sim_screenshot`'s note: the frame, its size, and how to turn image pixels into
/// `sim_act` points.
pub fn screenshot_note(sim_id: &str, sequence: f64, width: f64, height: f64, scale: f64) -> String {
    let number = |value: f64| ace_json::to_string(&Value::Number(Number::from(value)));
    format!(
        "{sim_id} frame {}, {}x{}. Divide image pixels by scale {} for sim_act points; prefer sim_ui refs.",
        number(sequence),
        number(width),
        number(height),
        number(scale)
    )
}

/// The public failure an agent sees for a device failure, the same on MCP and the
/// CLI: a code from the public set, and ace's own message when ace wrote it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicFailure {
    pub code: &'static str,
    pub permission: Option<crate::error::DevicePermission>,
    pub message: Option<JsString>,
}

/// `simPublicError`: the failure's code when the public catalog has it, else
/// `command_failed`; ace's message is kept only for its own refusals.
pub fn public_failure(failure: &DeviceFailure, own: bool) -> PublicFailure {
    let code = failure.code.as_str();
    PublicFailure {
        code: PUBLIC_CODES
            .iter()
            .find(|candidate| **candidate == code)
            .copied()
            .unwrap_or("command_failed"),
        // `PublicToolError` keeps a permission only on a permission refusal.
        permission: (failure.code == DeviceErrorCode::PermissionDenied)
            .then_some(failure.permission)
            .flatten(),
        message: own.then(|| failure.message.clone()),
    }
}

/// The hint `PublicToolError` gives a permission refusal, over the catalog's.
fn permission_hint(permission: DevicePermission) -> &'static str {
    match permission {
        DevicePermission::ScreenRecording => {
            "Open System Settings > Privacy & Security > Screen Recording and enable Ace Screen Helper."
        }
        DevicePermission::Accessibility => {
            "Open System Settings > Privacy & Security > Accessibility and enable Ace Screen Helper."
        }
    }
}

/// `PublicToolError`'s cleanup of ace's own detail: control characters become spaces,
/// a 64-character hex run is redacted, and the text is cut at 256 UTF-16 units.
fn detail_text(message: &JsString) -> JsString {
    static HEX: OnceLock<Option<Regex>> = OnceLock::new();
    let sanitized: Vec<u16> = message
        .units()
        .map(|unit| {
            if unit < 0x20 || unit == 0x7f {
                0x20
            } else {
                unit
            }
        })
        .collect();
    let text = JsString::from_units(&sanitized);
    let redacted = HEX
        .get_or_init(|| Regex::new(r"(?i)[a-f0-9]{64}").ok())
        .as_ref()
        .map_or_else(
            || text.as_str().to_owned(),
            |pattern| {
                pattern
                    .replace_all(text.as_str(), "[redacted]")
                    .into_owned()
            },
        );
    JsString::from_units(&redacted.encode_utf16().take(256).collect::<Vec<_>>())
}

/// `simFailure`: the JSON body an agent's tool call reports, exactly as
/// `toolFailure` writes it — the public code, the catalog's message and hint, and
/// ace's own detail last when it wrote the failure.
pub fn failure_body(failure: &DeviceFailure, own: bool) -> Value {
    let public = public_failure(failure, own);
    let words = ace_mcp::catalog::catalog()
        .ok()
        .and_then(|catalog| catalog.errors.get(public.code).cloned());
    let (message, hint) = match words {
        Some(words) => (JsString::from(words.message), JsString::from(words.hint)),
        None => (failure.message.clone(), failure.hint.clone()),
    };
    let hint = public.permission.map_or(hint, |permission| {
        JsString::from(permission_hint(permission))
    });
    let mut out = Map::new();
    out.insert("code", Value::String(JsString::from(public.code)));
    out.insert("message", Value::String(message));
    out.insert("hint", Value::String(hint));
    if let Some(detail) = public.message {
        out.insert("detail", Value::String(detail_text(&detail)));
    }
    if let Some(permission) = public.permission {
        out.insert(
            "permission",
            Value::String(JsString::from(permission.as_str())),
        );
    }
    Value::Object(out)
}

/// `parseToolArguments` + `toolFailure` for a decoding failure: the public
/// `invalid_arguments` code, its catalog words, the field issues in order, and —
/// only when a field or variant does not exist — where to find the schema.
pub fn arguments_body(tool: SimTool, error: &ArgumentError) -> Value {
    let words = ace_mcp::catalog::catalog()
        .ok()
        .and_then(|catalog| catalog.errors.get("invalid_arguments").cloned());
    let (message, hint) = match words {
        Some(words) => (JsString::from(words.message), JsString::from(words.hint)),
        None => (
            JsString::from("Invalid tool arguments"),
            JsString::from(
                "Nothing ran. Fix each field named in issues, keep the other arguments, and call again.",
            ),
        ),
    };
    let mut out = Map::new();
    out.insert("code", Value::String(JsString::from("invalid_arguments")));
    out.insert("message", Value::String(message));
    out.insert("hint", Value::String(hint));
    let mut issues = Array::new();
    for issue in &error.issues {
        let mut entry = Map::new();
        entry.insert("path", Value::String(JsString::from(issue.path.as_str())));
        entry.insert(
            "expected",
            Value::String(JsString::from(issue.expected.as_str())),
        );
        issues.push(Value::Object(entry));
    }
    out.insert("issues", Value::Array(issues));
    if error.shape {
        out.insert(
            "detail",
            Value::String(JsString::from(format!(
                "tools_find {} returns its schema.",
                tool.as_str()
            ))),
        );
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests;

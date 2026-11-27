// SPDX-License-Identifier: Apache-2.0
//! The `sim_*` tools' results (`packages/devices/src/sim-tools.ts`): what a call
//! answers, the summary a start or stop gives, the refusal a device with no live
//! video still answers, the screenshot's note, and the public failure body.
//!
//! The failure's words come from M1's public error catalog (`ace-mcp`), which both
//! backends serve; only ace's own detail rides along.

use std::sync::OnceLock;

use ace_json::{Array, JsString, Map, Number, Value};
use ace_mcp::catalog::{Catalog, ErrorWords};
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

/// The how-to rides on an agent's first start of a device only (`sim-tools.ts:99`):
/// `firstStart(...) && typeof started === "object" ? { ...started, guide } : started`.
/// So a first start spreads an array into an object of its index keys and `null` into one
/// holding the guide, while a repeat start answers `started` itself, array and null included.
pub fn with_guidance(started: Value, first_start: bool, guidance: &str) -> Value {
    if !first_start {
        return started;
    }
    let mut object = match started {
        Value::Object(object) => object,
        Value::Array(items) => {
            let mut object = Map::with_capacity(items.len() + 1);
            for (index, item) in items.into_iter().enumerate() {
                object.insert(index.to_string(), item);
            }
            object
        }
        Value::Null => Map::new(),
        other => return other,
    };
    object.insert("guide", Value::String(JsString::from(guidance)));
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

/// The hint `PublicToolError` gives a permission refusal: the shared catalog's setting.
fn permission_hint(catalog: &Catalog, permission: DevicePermission) -> String {
    catalog
        .permission_hints
        .get(permission.as_str())
        .cloned()
        .unwrap_or_else(|| String::from(INCOMPLETE_HINT))
}

/// The body when the embedded catalog does not parse at all: a daemon build bug,
/// never a fact about the device, so it names the install instead of the device.
const INCOMPLETE_MESSAGE: &str = "This failure has no entry in ace's error catalog";
const INCOMPLETE_HINT: &str = "Reinstall ace; its error catalog is incomplete.";

fn incomplete_words() -> ErrorWords {
    ErrorWords {
        message: String::from(INCOMPLETE_MESSAGE),
        hint: String::from(INCOMPLETE_HINT),
    }
}

/// The words an agent sees for a public code: the given catalog's own entry, or its words
/// for a code it does not know. The device failure's own words are never a source.
fn catalog_words<'a>(catalog: &'a Catalog, code: &str) -> &'a ErrorWords {
    catalog.errors.get(code).unwrap_or(&catalog.fallbacks)
}

/// [`catalog_words`] over the embedded catalog, whose absence is the install's problem.
fn embedded_words(code: &str) -> ErrorWords {
    match ace_mcp::catalog::catalog() {
        Ok(catalog) => catalog_words(catalog, code).clone(),
        Err(_) => incomplete_words(),
    }
}

/// The words an agent sees for a public code, from the shared MCP catalog. The device
/// failure's own words are never a source: a code the catalog does not know — which the
/// completeness test rules out — renders the catalog's own words for that case.
pub fn public_words(code: &str) -> ErrorWords {
    embedded_words(code)
}

/// `/[a-f0-9]{64}/gi`, over UTF-16 units: a lone surrogate in the text is neither
/// matched nor rewritten, as `String.prototype.replace` leaves it. A run longer than
/// 64 keeps its tail, because JavaScript resumes after the match it replaced.
fn redact_hex(units: &[u16]) -> Vec<u16> {
    const RUN: usize = 64;
    /// `[a-f0-9]`, as a code unit: a surrogate or any other character never matches.
    fn is_hex(unit: u16) -> bool {
        matches!(unit, 0x30..=0x39 | 0x41..=0x46 | 0x61..=0x66)
    }
    let mut out = Vec::with_capacity(units.len());
    let mut at = 0;
    while at < units.len() {
        let run = units[at..].iter().take_while(|unit| is_hex(**unit)).count();
        if run >= RUN {
            out.extend("[redacted]".encode_utf16());
            at += RUN;
        } else {
            out.push(units[at]);
            at += 1;
        }
    }
    out
}

/// `PublicToolError`'s cleanup of ace's own detail: control characters become spaces,
/// a 64-character hex run is redacted, and the text is cut at 256 UTF-16 units — all
/// over code units, so a lone surrogate survives as the agent sent it.
fn detail_text(message: &JsString) -> JsString {
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
    let redacted = redact_hex(&sanitized);
    JsString::from_units(&redacted[..redacted.len().min(256)])
}

/// `simFailure`: the JSON body an agent's tool call reports, exactly as
/// `toolFailure` writes it — the public code, the catalog's message and hint, and
/// ace's own detail last when it wrote the failure.
pub fn failure_body(failure: &DeviceFailure, own: bool) -> Value {
    failure_body_with(ace_mcp::catalog::catalog().ok(), failure, own)
}

/// [`failure_body`] with its words taken from `catalog`: `None` is the embedded catalog
/// not parsing at all, a daemon build bug. Split out so a test supplies its own wording
/// and a body that reached for a literal fails it.
fn failure_body_with(catalog: Option<&Catalog>, failure: &DeviceFailure, own: bool) -> Value {
    let public = public_failure(failure, own);
    let (words, permission_hint) = match catalog {
        Some(catalog) => (
            catalog_words(catalog, public.code).clone(),
            public
                .permission
                .map(|permission| permission_hint(catalog, permission)),
        ),
        None => (
            incomplete_words(),
            public.permission.map(|_| String::from(INCOMPLETE_HINT)),
        ),
    };
    let ErrorWords {
        message,
        hint: words_hint,
    } = words;
    let mut out = Map::new();
    out.insert("code", Value::String(JsString::from(public.code)));
    out.insert("message", Value::String(JsString::from(message)));
    out.insert(
        "hint",
        Value::String(JsString::from(permission_hint.unwrap_or(words_hint))),
    );
    if let Some(detail) = public.message.filter(|detail| !detail.is_empty()) {
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
    arguments_body_with(ace_mcp::catalog::catalog().ok(), tool, error)
}

/// [`arguments_body`] with its words taken from `catalog`, as its failure twin is.
fn arguments_body_with(catalog: Option<&Catalog>, tool: SimTool, error: &ArgumentError) -> Value {
    let words = match catalog {
        Some(catalog) => catalog_words(catalog, "invalid_arguments").clone(),
        None => incomplete_words(),
    };
    let mut out = Map::new();
    out.insert("code", Value::String(JsString::from("invalid_arguments")));
    out.insert("message", Value::String(JsString::from(words.message)));
    out.insert("hint", Value::String(JsString::from(words.hint)));
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

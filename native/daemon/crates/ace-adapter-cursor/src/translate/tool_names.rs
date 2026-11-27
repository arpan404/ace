// SPDX-License-Identifier: Apache-2.0
//! Tool names, the SDK byte budget and ace-call recognition (`tool-events.ts`).

use super::text::JsString;
use super::text::{Value, units_eq};
use super::{BudgetError, BudgetResult};

/// Byte budget for one tool's retained arguments, and the structural budgets.
pub(crate) const ARGS_BYTES: usize = 262_144;

/// Serialize with the SDK's byte, node and depth budgets (`boundedJson`, E5.4a's one copy in
/// `ace-json`).
pub(crate) fn bounded_json(value: &Value, max_bytes: usize) -> BudgetResult<String> {
    ace_json::bounded::bounded_json(value, max_bytes).map_err(|_| BudgetError::Exceeded)
}

const SCREEN: &[&str] = &[
    "open_app",
    "windows",
    "ui_tree",
    "ui_act",
    "input",
    "screenshot",
    "measure",
    "apps",
    "state",
    "act",
];
const BROWSER: &[&str] = &[
    "open",
    "snapshot",
    "act",
    "wait_for",
    "find",
    "screenshot",
    "logs",
    "evaluate",
    "history",
    "settings",
    "measure",
];
const SIM: &[&str] = &["list", "start", "stop", "ui", "act", "screenshot", "logs"];

/// Tool names are matched as text: only ASCII spellings are ace's, so a lone
/// surrogate (read as U+FFFD) never matches, as it never does in TypeScript.
fn bare_tool_name(name: &str) -> &str {
    // One namespace strip, then the toolkit prefix it may still carry.
    let mut bare = name;
    if let Some(rest) = bare.strip_prefix("mcp__ace__") {
        bare = rest;
    }
    while let Some(rest) = bare.strip_prefix("ace_") {
        bare = rest;
    }
    bare
}

fn is_tool_name(bare: &str) -> bool {
    let Some(first) = bare.bytes().next() else {
        return false;
    };
    if !first.is_ascii_lowercase() || bare.len() > 101 {
        return false;
    }
    bare.bytes()
        .all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'_'))
}

fn has_prefix(name: &str, prefix: &str) -> bool {
    name.starts_with(prefix)
}

/// The bare name of an ace tool, when the spelling is one of ace's.
fn ace_tool_name(name: &JsString) -> Option<&str> {
    let name = name.as_str();
    let bare = bare_tool_name(name);
    if !is_tool_name(bare) {
        return None;
    }
    if has_prefix(name, "mcp__ace__") || has_prefix(name, "ace_") {
        return Some(bare);
    }
    for (prefix, names) in [("browser_", BROWSER), ("screen_", SCREEN), ("sim_", SIM)] {
        if let Some(rest) = bare.strip_prefix(prefix)
            && names.contains(&rest)
        {
            return Some(bare);
        }
    }
    None
}

/// Whether the call ran one of ace's own tools, whose real error text shows.
pub(crate) fn is_ace_call(detail: &Value, kind: &str, title: &JsString) -> bool {
    if units_eq(
        string_or_empty(detail.get("kind").unwrap_or(&Value::Null)),
        "mcp",
    ) {
        // A missing server counts as ace's, as the TypeScript reads it.
        let server = match detail.get("server") {
            Some(Value::String(server)) => server,
            _ => JsString::empty(),
        };
        if !(server.is_empty() || units_eq(server, "ace") || units_eq(server, "unknown")) {
            return false;
        }
        let tool = string_or_empty(detail.get("tool").unwrap_or(&Value::Null));
        return ace_tool_name(tool).is_some();
    }
    if !units_eq(
        string_or_empty(detail.get("kind").unwrap_or(&Value::Null)),
        "custom",
    ) && kind != "custom"
    {
        return false;
    }
    ace_tool_name(title).is_some()
}

fn string_or_empty(value: &Value) -> &JsString {
    match value {
        Value::String(units) => units,
        _ => JsString::empty(),
    }
}

/// Slice text to the first `max` UTF-16 code units, as the TypeScript does,
/// even mid-pair.
pub(crate) fn utf16_slice(text: &JsString, max: usize) -> JsString {
    text.slice_units(0, max)
}

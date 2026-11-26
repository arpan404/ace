// SPDX-License-Identifier: Apache-2.0
//! The `sim_*` tools' shape (`packages/devices/src/sim-schemas.ts`): the numbers and
//! bounds their arguments carry, and which fields each `sim_act` action takes.
//!
//! The schemas' own Zod messages and the tool prose stay TypeScript until D5 pins
//! the typed decoding; these are the decisions D5 and the CLI both read.

/// A screen point's bound (`point`, `sim-schemas.ts:14`).
pub const MAX_POINT: f64 = 16_384.0;
/// A gesture's duration: 1 to 10,000 ms.
pub const MIN_DURATION_MS: f64 = 1.0;
pub const MAX_DURATION_MS: f64 = 10_000.0;
/// Typed text's cap, in code points (patched zod counts code points).
pub const MAX_TEXT: usize = 4_096;
/// An app id's cap.
pub const MAX_APP_ID: usize = 256;
/// A URL's or a path's cap.
pub const MAX_URL: usize = 4_096;
/// `sim_logs`' limit: 1 to 256, 100 by default.
pub const MAX_LOGS_LIMIT: u32 = 256;
pub const DEFAULT_LOGS_LIMIT: u32 = 100;
/// `sim_start` boots the device unless told not to.
pub const DEFAULT_BOOT: bool = true;

/// The fields one `sim_act` action requires and may carry, after the base fields
/// (`simId`, and `machine` for a routed call).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rule {
    pub required: &'static [&'static str],
    pub allowed: &'static [&'static str],
}

const BASE: &[&str] = &["simId", "machine"];

/// `perAction`'s table for `sim_act` (`sim-schemas.ts:75`-`:93`).
pub fn action_rule(action: &str) -> Option<Rule> {
    let none = Rule {
        required: &[],
        allowed: BASE,
    };
    Some(match action {
        "ui" => Rule {
            required: &["ref"],
            allowed: &["simId", "machine", "ref", "uiAction", "value", "name"],
        },
        "tap" => Rule {
            required: &[],
            allowed: &["simId", "machine", "x", "y", "ref"],
        },
        "long_press" => Rule {
            required: &[],
            allowed: &["simId", "machine", "x", "y", "ref", "durationMs"],
        },
        "swipe" => Rule {
            required: &["x", "y", "toX", "toY"],
            allowed: &["simId", "machine", "x", "y", "toX", "toY", "durationMs"],
        },
        "type" => Rule {
            required: &["text"],
            allowed: &["simId", "machine", "text", "ref"],
        },
        "key" => Rule {
            required: &["key"],
            allowed: &["simId", "machine", "key"],
        },
        "open_app" => Rule {
            required: &["appId"],
            allowed: &["simId", "machine", "appId"],
        },
        "open_url" => Rule {
            required: &["url"],
            allowed: &["simId", "machine", "url"],
        },
        "install" => Rule {
            required: &["path"],
            allowed: &["simId", "machine", "path"],
        },
        "record_start" | "record_stop" | "clipboard_get" => none,
        "clipboard_set" => Rule {
            required: &["text"],
            allowed: &["simId", "machine", "text"],
        },
        "posture" => Rule {
            required: &["posture"],
            allowed: &["simId", "machine", "posture"],
        },
        _ => return None,
    })
}

/// `perAction`: the fields an action's arguments may and must carry. The Zod
/// message text stays TypeScript; these are the fields it refuses.
pub fn check_fields(action: &str, present: &[&str]) -> Result<(), Vec<String>> {
    let Some(rule) = action_rule(action) else {
        return Err(vec![format!("Unrecognized action: {action}")]);
    };
    let mut issues = Vec::new();
    for field in present {
        if !rule.allowed.contains(field) {
            issues.push(format!("Unrecognized key: \"{field}\""));
        }
    }
    for field in rule.required {
        if !present.contains(field) {
            issues.push(format!("Missing required field: {field}"));
        }
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(issues)
    }
}

/// `simActPoint`: a tap or a long press needs a ref or both coordinates, never
/// both (`sim-schemas.ts:94`-`:103`).
pub fn point_issue(action: &str, has_ref: bool, x: bool, y: bool) -> Option<String> {
    if action != "tap" && action != "long_press" {
        return None;
    }
    let located = x || y;
    let wrong = if has_ref { located } else { !(x && y) };
    wrong.then(|| format!("{action} needs either ref or both x and y"))
}

/// The seven tool names (`sim-schemas.ts:106`-`:120`).
pub const TOOL_NAMES: [&str; 7] = [
    "sim_list",
    "sim_start",
    "sim_stop",
    "sim_ui",
    "sim_act",
    "sim_screenshot",
    "sim_logs",
];

#[cfg(test)]
mod tests;

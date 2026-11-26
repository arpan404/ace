// SPDX-License-Identifier: Apache-2.0
//! The macOS privacy permissions behind an iOS Simulator view, and the screen
//! helper's and manager's failures as typed device errors
//! (`packages/devices/src/screen-failure.ts`).

use std::sync::OnceLock;

use regex::Regex;

use super::words;
use crate::error::{DeviceError, DeviceErrorCode, DevicePermission};

/// The catalog key of each permission's refusal.
pub fn permission_key(permission: DevicePermission) -> &'static str {
    match permission {
        DevicePermission::ScreenRecording => "permissionScreenRecording",
        DevicePermission::Accessibility => "permissionAccessibility",
    }
}

/// `permissionDenied`: which permission and how to grant it, carrying the
/// permission on the failure so a client can offer the right fix.
pub fn permission_denied(permission: DevicePermission) -> DeviceError {
    let word = crate::platform::words::refusal(permission_key(permission));
    DeviceError::Coded {
        code: DeviceErrorCode::PermissionDenied,
        message: word.message.into(),
        hint: word.hint.into(),
        permission: Some(permission),
    }
}

/// The error a screen helper or manager reported: its stable message and code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScreenError<'a> {
    /// The JavaScript error's `code`, when it had one.
    pub code: Option<&'a str>,
    pub message: &'a str,
}

/// The four messages `screen-failure.ts` matches, compiled once.
struct Patterns {
    focus: Regex,
    screen_recording: Regex,
    macos: Regex,
    frontmost: Regex,
}

fn patterns() -> Option<&'static Patterns> {
    static PATTERNS: OnceLock<Option<Patterns>> = OnceLock::new();
    PATTERNS
        .get_or_init(|| {
            Some(Patterns {
                focus: Regex::new(
                    "Target window is not focused|Captured window must be the application's focused window|Focused element is not an Accessibility window",
                )
                .ok()?,
                screen_recording: Regex::new("(?i)Screen Recording permission (denied|revoked)")
                    .ok()?,
                macos: Regex::new("(?i)macOS permission denied").ok()?,
                frontmost: Regex::new("only while it is the frontmost app").ok()?,
            })
        })
        .as_ref()
}

/// `screenFailure`: the typed refusal a screen helper's failure names, or `None`
/// when it is not one ace knows.
pub fn screen_failure(error: &ScreenError<'_>) -> Option<DeviceError> {
    let message = error.message;
    if error.code == Some("screen_disabled") {
        return Some(words::refusal("screenDisabled"));
    }
    if error
        .code
        .is_some_and(|code| code == "foreground_required" || code == "focus_changed")
        || patterns().is_some_and(|patterns| patterns.focus.is_match(message))
    {
        return Some(DeviceError::coded(
            DeviceErrorCode::ForegroundRequired,
            format!("Simulator needs foreground input for this interaction: {message}"),
            words::tool_hint("foregroundRequiredHint"),
        ));
    }
    if patterns().is_some_and(|patterns| patterns.screen_recording.is_match(message)) {
        return Some(permission_denied(DevicePermission::ScreenRecording));
    }
    // Capture already proved Screen Recording; input is refused for Accessibility.
    if patterns().is_some_and(|patterns| patterns.macos.is_match(message)) {
        return Some(permission_denied(DevicePermission::Accessibility));
    }
    if patterns().is_some_and(|patterns| patterns.frontmost.is_match(message)) {
        return Some(words::refusal("frontmostTyping"));
    }
    if message == "Session limit" {
        return Some(words::refusal("screenLimit"));
    }
    None
}

#[cfg(test)]
mod tests;

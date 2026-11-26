// SPDX-License-Identifier: Apache-2.0
//! Screen helper failures as typed device errors (`screen-failure.ts`).
//!
//! `screen-failure.ts` has no test file of its own (behaviour.md §5 lists none),
//! so these cases are the module's only guard.

use super::{ScreenError, permission_denied, screen_failure};
use crate::error::{DeviceError, DeviceErrorCode, DevicePermission};
use crate::service::words;

fn error(message: &str) -> ScreenError<'_> {
    ScreenError {
        code: None,
        message,
    }
}

#[test]
fn screen_disabled_is_computer_use_off() {
    let failed = screen_failure(&ScreenError {
        code: Some("screen_disabled"),
        message: "anything",
    })
    .expect("typed");
    assert_eq!(failed, words::refusal("screenDisabled"));
    assert_eq!(failed.code(), DeviceErrorCode::PermissionDenied);
}

#[test]
fn a_foreground_code_names_the_window_and_keeps_the_detail() {
    let failed = with_code("foreground_required", "Target window is not focused").expect("typed");
    assert_eq!(failed.code(), DeviceErrorCode::ForegroundRequired);
    let DeviceError::Coded { message, hint, .. } = &failed else {
        panic!("a coded refusal: {failed:?}");
    };
    assert!(
        message.as_str().ends_with(": Target window is not focused"),
        "the SDK's own text stays in the message"
    );
    assert_eq!(hint.as_str(), words::tool_hint("foregroundRequiredHint"));
}

fn with_code(code: &str, message: &str) -> Option<DeviceError> {
    screen_failure(&ScreenError {
        code: Some(code),
        message,
    })
}

#[test]
fn a_focus_message_is_foreground_too() {
    for message in [
        "Target window is not focused",
        "Captured window must be the application's focused window",
        "Focused element is not an Accessibility window",
    ] {
        let failed = screen_failure(&error(message)).expect("typed");
        assert_eq!(
            failed.code(),
            DeviceErrorCode::ForegroundRequired,
            "{message}"
        );
    }
}

#[test]
fn a_permission_refusal_takes_its_code_from_the_catalog_not_a_hardcoded_default() {
    let failed = permission_denied(DevicePermission::ScreenRecording);
    let catalog = crate::platform::words::refusal("permissionScreenRecording");
    assert_eq!(failed.code().as_str(), catalog.code.as_str());
    assert_ne!(catalog.code.as_str(), "busy");
}

#[test]
fn screen_limit_uses_the_catalog_busy_code_not_permission_denied() {
    let failed = screen_failure(&super::ScreenError {
        code: None,
        message: "Session limit",
    })
    .expect("typed");
    assert_eq!(failed, words::refusal("screenLimit"));
    assert_eq!(failed.code(), DeviceErrorCode::Busy);
    assert_ne!(failed.code(), DeviceErrorCode::PermissionDenied);
}

#[test]
fn screen_recording_permission_denied_carries_the_permission() {
    for message in [
        "Screen Recording permission denied",
        "screen recording permission revoked",
    ] {
        let failed = screen_failure(&error(message)).expect("typed");
        assert_eq!(failed, permission_denied(DevicePermission::ScreenRecording));
    }
}

#[test]
fn macos_permission_denied_is_accessibility() {
    let failed = screen_failure(&error("macOS permission denied for the helper")).expect("typed");
    assert_eq!(failed, permission_denied(DevicePermission::Accessibility));
    assert_eq!(
        failed.to_failure(None).permission,
        Some(DevicePermission::Accessibility)
    );
}

#[test]
fn the_frontmost_typing_refusal() {
    let failed =
        screen_failure(&error("keys work only while it is the frontmost app")).expect("typed");
    assert_eq!(failed, words::refusal("frontmostTyping"));
}

#[test]
fn session_limit_is_busy() {
    let failed = screen_failure(&error("Session limit")).expect("typed");
    assert_eq!(failed, words::refusal("screenLimit"));
    assert_eq!(failed.code(), DeviceErrorCode::Busy);
}

#[test]
fn an_unknown_message_is_not_a_screen_failure() {
    assert_eq!(screen_failure(&error("something else entirely")), None);
}

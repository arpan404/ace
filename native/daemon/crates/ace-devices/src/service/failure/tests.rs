// SPDX-License-Identifier: Apache-2.0
//! Any error as the `DeviceFailure` a client sees (`failure.ts`).
//!
//! `failure.ts` has no test file of its own (behaviour.md §5 lists none), so
//! these cases are the module's only guard.

use super::{Failed, device_failure};
use crate::error::{DeviceErrorCode, DevicePermission, GENERIC_HINT, MAX_FAILURE_TEXT_UTF16};
use crate::service::screen_failure::ScreenError;
use crate::service::words;

fn message(text: &str) -> ScreenError<'_> {
    ScreenError {
        code: None,
        message: text,
    }
}

#[test]
fn a_typed_refusal_keeps_its_code_and_words() {
    let error = words::refusal("leaseRequired");
    let failure = device_failure(Failed::Device(&error));
    let expected = error.to_failure(None);
    assert_eq!(failure.code, DeviceErrorCode::LeaseRequired);
    assert_eq!(failure.message, expected.message);
    assert_eq!(failure.hint, expected.hint);
}

#[test]
fn a_screen_failure_is_mapped_to_its_typed_failure() {
    let failure = device_failure(Failed::Error(message("Session limit")));
    assert_eq!(failure.code, DeviceErrorCode::Busy);
    assert_eq!(
        failure.message.as_str(),
        "Another live view is using the screen helper"
    );
    assert_eq!(failure.permission, None);

    let permission = device_failure(Failed::Error(message("Screen Recording permission denied")));
    assert_eq!(permission.code, DeviceErrorCode::PermissionDenied);
    assert_eq!(
        permission.permission,
        Some(DevicePermission::ScreenRecording)
    );
}

#[test]
fn another_error_is_command_failed_with_its_message() {
    let failure = device_failure(Failed::Error(message("spawn failed")));
    assert_eq!(failure.code, DeviceErrorCode::CommandFailed);
    assert_eq!(failure.message.as_str(), "spawn failed");
    assert_eq!(failure.hint.as_str(), GENERIC_HINT);
    assert_eq!(failure.permission, None);
}

#[test]
fn a_thrown_non_error_is_the_generic_failure() {
    let failure = device_failure(Failed::Unknown);
    assert_eq!(failure.code, DeviceErrorCode::CommandFailed);
    assert_eq!(failure.message.as_str(), "Device operation failed");
    assert_eq!(failure.hint.as_str(), GENERIC_HINT);
}

#[test]
fn a_long_message_is_cut_to_2048_utf16_units() {
    // 2,047 ASCII units, then an emoji: `.slice(0, 2048)` keeps its high
    // surrogate and drops the low one, which `JsString` keeps as it is.
    let long = format!("{}😀tail", "a".repeat(MAX_FAILURE_TEXT_UTF16 - 1));
    let failure = device_failure(Failed::Error(message(&long)));
    assert_eq!(failure.message.len_utf16(), MAX_FAILURE_TEXT_UTF16);
    // The first 2,047 units are the `a`s; the last is the emoji's lone high surrogate.
    let units: Vec<u16> = failure.message.units().collect();
    assert!(
        units[..MAX_FAILURE_TEXT_UTF16 - 1]
            .iter()
            .all(|unit| *unit == b'a' as u16)
    );
    assert_eq!(units[MAX_FAILURE_TEXT_UTF16 - 1], 0xD83D);
}

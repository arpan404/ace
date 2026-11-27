// SPDX-License-Identifier: Apache-2.0
//! A queued mutation's plan (`actions.ts`): the refusals first, then which backend
//! does the work.
//!
//! `actions.ts` has no test file of its own (behaviour.md §5 lists none), so
//! these cases are the module's only guard.

use super::{CaptureFacts, DeviceFacts, QueuedAction, Step, plan};
use crate::error::DeviceErrorCode;
use crate::platform::device_input::{DeviceInput, Key, Phase};
use crate::service::words;

fn capture(input: bool, clipboard: bool) -> CaptureFacts {
    CaptureFacts {
        input,
        clipboard,
        multi_touch: false,
        screen_session_id: None,
    }
}

fn android() -> DeviceFacts<'static> {
    DeviceFacts {
        ios: false,
        name: "Pixel 9",
    }
}

fn key(key: Key) -> QueuedAction {
    QueuedAction::Input(DeviceInput::Key { key })
}

#[test]
fn a_capture_handles_clipboard_and_input_when_it_has_them() {
    let facts = capture(true, true);
    assert_eq!(
        plan(&QueuedAction::ClipboardGet, &facts, android()),
        Ok(vec![Step::CaptureClipboard])
    );
    assert_eq!(
        plan(
            &QueuedAction::ClipboardSet {
                text: String::new()
            },
            &facts,
            android()
        ),
        Ok(vec![Step::CaptureClipboard])
    );
    assert_eq!(
        plan(&key(Key::Home), &facts, android()),
        Ok(vec![Step::CaptureInput])
    );
}

#[test]
fn the_platform_handles_them_when_the_capture_has_none() {
    let facts = capture(false, false);
    assert_eq!(
        plan(&QueuedAction::ClipboardGet, &facts, android()),
        Ok(vec![Step::PlatformClipboard])
    );
    assert_eq!(
        plan(&key(Key::Home), &facts, android()),
        Ok(vec![Step::PlatformInput {
            screen_session_id: None
        }])
    );
}

#[test]
fn a_second_finger_is_refused_when_the_view_supports_one() {
    let facts = capture(true, false);
    let second = QueuedAction::Input(DeviceInput::Pointer {
        phase: Phase::Move,
        x: 1.0,
        y: 2.0,
        pointer_id: Some(1),
    });
    let refused = plan(&second, &facts, android()).expect_err("one finger only");
    assert_eq!(refused, words::refusal("inputOneFinger"));
    assert_eq!(refused.code(), DeviceErrorCode::NotSupported);

    // `pointerId` is read by truthiness: finger 0 is not a second finger.
    let first = QueuedAction::Input(DeviceInput::Pointer {
        phase: Phase::Move,
        x: 1.0,
        y: 2.0,
        pointer_id: Some(0),
    });
    plan(&first, &facts, android()).expect("the first finger is fine");
    // And a view with multi-touch takes a second finger.
    let multi = CaptureFacts {
        multi_touch: true,
        ..facts
    };
    plan(&second, &multi, android()).expect("two fingers");
}

#[test]
fn an_ios_key_it_lacks_is_refused_before_the_device() {
    let ios = DeviceFacts {
        ios: true,
        name: "iPhone 17 Pro",
    };
    let refused = plan(&key(Key::Recents), &capture(false, false), ios).expect_err("no recents");
    assert_eq!(refused, words::refusal("iosRecentsKey"));
    assert_eq!(refused.code(), DeviceErrorCode::NotSupported);
    // The same key is fine on Android.
    plan(&key(Key::Recents), &capture(false, false), android()).expect("Android has recents");
}

#[test]
fn a_rotate_key_restarts_the_capture_after_the_platform_input() {
    assert_eq!(
        plan(&key(Key::Rotate), &capture(false, false), android()),
        Ok(vec![
            Step::PlatformInput {
                screen_session_id: None
            },
            Step::RestartCapture
        ])
    );
    // With a capture input path, the capture rotates itself.
    assert_eq!(
        plan(&key(Key::Rotate), &capture(true, false), android()),
        Ok(vec![Step::CaptureInput])
    );
}

#[test]
fn the_platform_input_names_the_captures_screen_session() {
    let facts = CaptureFacts {
        input: false,
        clipboard: false,
        multi_touch: false,
        screen_session_id: Some(String::from("screen-1")),
    };
    assert_eq!(
        plan(&key(Key::Home), &facts, android()),
        Ok(vec![Step::PlatformInput {
            screen_session_id: Some(String::from("screen-1"))
        }])
    );
}

#[test]
fn the_app_level_operations_name_their_platform_call() {
    let facts = capture(false, false);
    for (action, name) in [
        (QueuedAction::Boot, "boot"),
        (
            QueuedAction::Install {
                path: String::from("/tmp/a.apk"),
            },
            "install",
        ),
        (
            QueuedAction::OpenApp {
                app_id: String::from("com.example"),
            },
            "open_app",
        ),
        (
            QueuedAction::OpenUrl {
                url: String::from("https://example.com"),
            },
            "open_url",
        ),
        (QueuedAction::Configure, "configure"),
    ] {
        assert_eq!(
            plan(&action, &facts, android()),
            Ok(vec![Step::Platform(name)])
        );
    }
    assert_eq!(
        plan(&QueuedAction::Posture, &facts, android()),
        Ok(vec![Step::Posture])
    );
}

#[test]
fn an_unsupported_operation_is_invalid_data() {
    let refused = plan(
        &QueuedAction::Unsupported,
        &capture(false, false),
        android(),
    )
    .expect_err("not a queued action");
    assert_eq!(refused, words::refusal("unsupportedAction"));
    assert_eq!(refused.code(), DeviceErrorCode::InvalidData);
}

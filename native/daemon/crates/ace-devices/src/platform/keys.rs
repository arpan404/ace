// SPDX-License-Identifier: Apache-2.0
//! `key-support.ts` and `touch-support.ts`: the keys a device has no hardware for, refused before
//! any backend is asked, and what a live view's touch input reaches.

use crate::platform::device_input::Key;
use crate::platform::{Error, Failure, Refusal, words};

/// `\bwatch\b`, case-insensitively: JavaScript's `\w` is the ASCII word set.
fn names_watch(name: &str) -> bool {
    let bytes = name.as_bytes();
    let lower = name.to_ascii_lowercase();
    let target = b"watch";
    let mut from = 0;
    while let Some(found) = lower[from..].find(std::str::from_utf8(target).unwrap_or("watch")) {
        let start = from + found;
        let end = start + target.len();
        let before_ok = start == 0 || !is_word(bytes[start - 1]);
        let after_ok = end == bytes.len() || !is_word(bytes[end]);
        if before_ok && after_ok {
            return true;
        }
        from = start + 1;
    }
    false
}

fn is_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// The refusal for a key this device has no hardware for, or `None` when it has one.
pub fn key_refusal(ios: bool, name: &str, key: Key) -> Option<Error> {
    if ios && key == Key::Recents {
        return Some(Refusal::word("iosRecentsKey").into());
    }
    if ios && key == Key::Back {
        return Some(Refusal::word("iosBackKey").into());
    }
    if !ios && key == Key::Action {
        return Some(Refusal::word("androidActionKey").into());
    }
    if key == Key::Side && !(ios && names_watch(name)) {
        return Some(Refusal::word("watchSideKey").into());
    }
    None
}

fn built(message: String, hint: &'static str) -> Error {
    Error::Failed(Failure {
        code: crate::platform::Code::NotSupported,
        message,
        hint: hint.to_string(),
    })
}

/// The refusal for `key` on an Android device; for mappers whose switch must be total.
pub fn refuse_android_key(key: Key) -> Error {
    key_refusal(false, "", key).unwrap_or_else(|| {
        built(
            format!("Android has no {} key", key.name()),
            words::tool_hint("androidNoKeyHint"),
        )
    })
}

/// iOS keys serve-sim has no press for: the refusals above, or a plain not_supported.
pub fn refuse_simulator_key(key: Key) -> Error {
    key_refusal(true, "", key).unwrap_or_else(|| {
        built(
            format!("iOS Simulator has no {} key", key.name()),
            words::tool_hint("iosNoKeyHint"),
        )
    })
}

/// What a live view's touch input reaches: several fingers streamed live, one finger streamed
/// live, or whole gestures (the adb fallback, whose input is `adb shell input`).
pub fn device_touch(ios: bool, multi_touch: bool, input: bool) -> &'static str {
    if multi_touch {
        "multi"
    } else if input || ios {
        "pointer"
    } else {
        "gestures"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(error: &Error) -> crate::platform::Code {
        match error {
            Error::Refused(refusal) => refusal.code,
            Error::Failed(failure) => failure.code,
            Error::Invalid(_) => crate::platform::Code::InvalidData,
        }
    }

    #[test]
    fn the_ios_simulator_has_no_recents_or_back_key() {
        let recents = key_refusal(true, "iPhone 17", Key::Recents).expect("refused");
        assert_eq!(
            recents.to_string(),
            "not_supported: iOS Simulator has no Recents key"
        );
        let back = key_refusal(true, "iPhone 17", Key::Back).expect("refused");
        assert_eq!(back.to_string(), "not_supported: iOS has no Back key");
    }

    #[test]
    fn android_has_no_action_button_and_refuses_it_by_name() {
        assert_eq!(
            key_refusal(false, "Pixel 9", Key::Action)
                .expect("refused")
                .to_string(),
            "not_supported: Android has no Action button"
        );
        let error = refuse_android_key(Key::Side);
        assert_eq!(code(&error), crate::platform::Code::NotSupported);
        assert_eq!(
            error.to_string(),
            "not_supported: Only Apple Watch has a side key"
        );
    }

    #[test]
    fn only_an_apple_watch_has_a_side_key() {
        assert!(key_refusal(true, "Apple Watch Series 11", Key::Side).is_none());
        assert!(key_refusal(true, "iPhone 17", Key::Side).is_some());
        assert!(key_refusal(false, "Pixel 9", Key::Side).is_some());
        // The name's own word boundaries decide: "watches" is not a watch.
        assert!(key_refusal(true, "watches", Key::Side).is_some());
        assert!(key_refusal(true, "Apple Watch", Key::Side).is_none());
    }

    #[test]
    fn a_key_the_server_has_no_press_for_is_refused_with_the_catalog_hint() {
        let error = refuse_simulator_key(Key::Enter);
        assert_eq!(
            error.to_string(),
            "not_supported: iOS Simulator has no enter key"
        );
    }

    #[test]
    fn touch_is_multi_when_the_capture_streams_fingers_else_pointer_on_ios_and_gestures() {
        assert_eq!(device_touch(false, true, false), "multi");
        assert_eq!(device_touch(false, false, true), "pointer");
        assert_eq!(device_touch(true, false, false), "pointer");
        assert_eq!(device_touch(false, false, false), "gestures");
    }
}

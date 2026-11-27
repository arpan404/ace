// SPDX-License-Identifier: Apache-2.0
//! One input's time budget (`input-budget.ts`).
//!
//! `input-budget.ts` has no test file of its own (behaviour.md §5 lists none),
//! so these cases are the module's only guard.

use super::device_input_timeout;
use crate::platform::device_input::{DeviceInput, Key, Phase};
use ace_json::JsString;

#[test]
fn a_gesture_keeps_its_own_duration_and_typing_is_paced_per_character() {
    let tap = DeviceInput::Tap { x: 1.0, y: 2.0 };
    assert_eq!(device_input_timeout(&tap), 5_000.0);

    let swipe = DeviceInput::Swipe {
        x: 0.0,
        y: 0.0,
        to_x: 1.0,
        to_y: 1.0,
        duration_ms: 800.0,
    };
    assert_eq!(device_input_timeout(&swipe), 5_800.0);

    let press = DeviceInput::LongPress {
        x: 0.0,
        y: 0.0,
        duration_ms: 1_500.0,
    };
    assert_eq!(device_input_timeout(&press), 6_500.0);

    // `text.length` counts UTF-16 units: an emoji is two characters' budget.
    let typed = DeviceInput::Type {
        text: JsString::from("a😀"),
    };
    assert_eq!(device_input_timeout(&typed), 5_300.0);

    let key = DeviceInput::Key { key: Key::Home };
    assert_eq!(device_input_timeout(&key), 5_000.0);

    let pointer = DeviceInput::Pointer {
        phase: Phase::Down,
        x: 1.0,
        y: 2.0,
        pointer_id: None,
    };
    assert_eq!(device_input_timeout(&pointer), 5_000.0);
}

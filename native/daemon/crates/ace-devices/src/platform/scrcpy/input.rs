// SPDX-License-Identifier: Apache-2.0
//! `scrcpy-input.ts`: one device input as the control messages the scrcpy server accepts, and
//! the fingers a dropped control epoch must lift. The parser's 16 ms is one display frame.

use serde::{Deserialize, Serialize};

use crate::platform::device_input::DeviceInput;
use crate::platform::scrcpy::protocol::{
    CLIPBOARD_TEXT_LIMIT, ControlMessage, INJECT_TEXT_LIMIT, KeyAction, PointerId, ScreenSize,
    TouchAction, keycode,
};
use crate::platform::{Error, Refusal};

/// One control message, sent `delayMs` after the previous step. A clipboard step finishes only
/// when the server acknowledges its sequence number.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InputStep {
    #[serde(rename = "delayMs")]
    pub delay_ms: f64,
    pub message: ControlMessage,
}

/// Moves during a timed gesture: about one per display frame.
const FRAME_MS: f64 = 16.0;

/// Typed text containing anything but printable ASCII goes through the clipboard and paste.
fn plain_text(text: &str) -> bool {
    text.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
}

fn press(code: i32) -> Vec<InputStep> {
    vec![
        InputStep {
            delay_ms: 0.0,
            message: ControlMessage::Keycode {
                action: KeyAction::Down,
                keycode: code,
                repeat: 0,
                meta: 0,
            },
        },
        InputStep {
            delay_ms: 0.0,
            message: ControlMessage::Keycode {
                action: KeyAction::Up,
                keycode: code,
                repeat: 0,
                meta: 0,
            },
        },
    ]
}

/// Alt+K, Gboard's "Show on-screen keyboard": it brings the keyboard back for the focused field
/// after physical-keyboard input collapsed Gboard to its floating toolbar, or after Back hid it.
/// With nothing to type into, or the keyboard already up, it does nothing.
fn show_keyboard() -> Vec<InputStep> {
    let key = |action: KeyAction, keycode: i32, meta: i32| InputStep {
        delay_ms: 0.0,
        message: ControlMessage::Keycode {
            action,
            keycode,
            repeat: 0,
            meta,
        },
    };
    vec![
        key(KeyAction::Down, keycode::ALT_LEFT, super::protocol::ALT_ON),
        key(KeyAction::Down, keycode::K, super::protocol::ALT_ON),
        key(KeyAction::Up, keycode::K, super::protocol::ALT_ON),
        key(KeyAction::Up, keycode::ALT_LEFT, 0),
    ]
}

/// A point outside the picture the server checks touches against.
fn outside() -> Error {
    Refusal::word("inputOutsideScreen").into()
}

/// Plans the control messages for one device input. Input points are display pixels; the server
/// checks every touch against the current video size, so points are scaled into video pixels and
/// carry that size.
pub fn plan(
    input: &DeviceInput,
    display: ScreenSize,
    video: ScreenSize,
    next_sequence: u64,
) -> Result<Vec<InputStep>, Error> {
    let factor = video.width / display.width;
    let touch = |action: TouchAction, x: f64, y: f64, pointer: u32, delay_ms: f64| {
        // Points are the picture's own pixels over one factor. Its sides are rounded separately,
        // so its height in points can pass the display's: the bound is the picture, not the display.
        let video_x = x * factor;
        let video_y = y * factor;
        if video_x < 0.0 || video_y < 0.0 || video_x >= video.width || video_y >= video.height {
            return Err(outside());
        }
        Ok(InputStep {
            delay_ms,
            message: ControlMessage::Touch {
                action,
                pointer_id: PointerId(u64::from(pointer)),
                x: video_x,
                y: video_y,
                screen: video,
                pressure: if matches!(action, TouchAction::Up | TouchAction::Cancel) {
                    0.0
                } else {
                    1.0
                },
            },
        })
    };
    match input {
        DeviceInput::Pointer { phase, x, y, .. } => {
            let action = match phase {
                crate::platform::device_input::Phase::Down => TouchAction::Down,
                crate::platform::device_input::Phase::Move => TouchAction::Move,
                crate::platform::device_input::Phase::Up => TouchAction::Up,
                crate::platform::device_input::Phase::Cancel => TouchAction::Cancel,
            };
            Ok(vec![touch(action, *x, *y, input.pointer_id(), 0.0)?])
        }
        DeviceInput::Tap { x, y } => Ok(vec![
            touch(TouchAction::Down, *x, *y, 0, 0.0)?,
            touch(TouchAction::Up, *x, *y, 0, 0.0)?,
        ]),
        DeviceInput::LongPress { x, y, duration_ms } => Ok(vec![
            touch(TouchAction::Down, *x, *y, 0, 0.0)?,
            touch(TouchAction::Up, *x, *y, 0, *duration_ms)?,
        ]),
        DeviceInput::Swipe {
            x,
            y,
            to_x,
            to_y,
            duration_ms,
        } => {
            let steps = (duration_ms / FRAME_MS).ceil().max(1.0);
            let mut plan = vec![touch(TouchAction::Down, *x, *y, 0, 0.0)?];
            let mut step = 1.0_f64;
            while step <= steps {
                let t = step / steps;
                plan.push(touch(
                    TouchAction::Move,
                    x + (to_x - x) * t,
                    y + (to_y - y) * t,
                    0,
                    duration_ms / steps,
                )?);
                step += 1.0;
            }
            plan.push(touch(TouchAction::Up, *to_x, *to_y, 0, 0.0)?);
            Ok(plan)
        }
        DeviceInput::Type { text } => {
            if text.is_empty() {
                return Ok(Vec::new());
            }
            let plain = text.to_string_lossy();
            if !plain_text(&plain) {
                // The server's clipboard cap counts the UTF-8 bytes the message carries.
                if plain.len() > CLIPBOARD_TEXT_LIMIT {
                    return Err(Refusal::word("pasteTooLong").into());
                }
                return Ok(vec![InputStep {
                    delay_ms: 0.0,
                    message: ControlMessage::SetClipboard {
                        sequence: PointerId(next_sequence),
                        text: text.clone(),
                        paste: true,
                    },
                }]);
            }
            // `slice(start, start + 300)` counts UTF-16 units, and printable ASCII is one a unit.
            let mut plan = Vec::new();
            let mut start = 0;
            while start < text.len_utf16() {
                let end = (start + INJECT_TEXT_LIMIT).min(text.len_utf16());
                plan.push(InputStep {
                    delay_ms: 0.0,
                    message: ControlMessage::Text {
                        text: text.slice_units(start, end),
                    },
                });
                start = end;
            }
            Ok(plan)
        }
        DeviceInput::Key { key } => match key {
            crate::platform::device_input::Key::Rotate => Ok(vec![InputStep {
                delay_ms: 0.0,
                message: ControlMessage::Rotate,
            }]),
            crate::platform::device_input::Key::Back => Ok(vec![
                InputStep {
                    delay_ms: 0.0,
                    message: ControlMessage::BackOrScreenOn {
                        action: KeyAction::Down,
                    },
                },
                InputStep {
                    delay_ms: 0.0,
                    message: ControlMessage::BackOrScreenOn {
                        action: KeyAction::Up,
                    },
                },
            ]),
            crate::platform::device_input::Key::Home => Ok(press(keycode::HOME)),
            crate::platform::device_input::Key::Enter => Ok(press(keycode::ENTER)),
            crate::platform::device_input::Key::Power => Ok(press(keycode::POWER)),
            crate::platform::device_input::Key::Recents => Ok(press(keycode::APP_SWITCH)),
            crate::platform::device_input::Key::VolumeUp => Ok(press(keycode::VOLUME_UP)),
            crate::platform::device_input::Key::VolumeDown => Ok(press(keycode::VOLUME_DOWN)),
            crate::platform::device_input::Key::Keyboard => Ok(show_keyboard()),
            crate::platform::device_input::Key::Action => {
                Err(crate::platform::keys::refuse_android_key(
                    crate::platform::device_input::Key::Action,
                ))
            }
            crate::platform::device_input::Key::Side => Err(
                crate::platform::keys::refuse_android_key(crate::platform::device_input::Key::Side),
            ),
        },
    }
}

/// Fingers still down when control moves on are lifted, so the device never keeps a touch.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct HeldPointers {
    held: Vec<(u32, (f64, f64))>,
}

impl HeldPointers {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn apply(&mut self, input: &DeviceInput) {
        let DeviceInput::Pointer { phase, x, y, .. } = input else {
            return;
        };
        let id = input.pointer_id();
        match phase {
            crate::platform::device_input::Phase::Down
            | crate::platform::device_input::Phase::Move => {
                match self.held.iter_mut().find(|(held, _)| *held == id) {
                    Some(slot) => slot.1 = (*x, *y),
                    None => self.held.push((id, (*x, *y))),
                }
            }
            _ => self.held.retain(|(held, _)| *held != id),
        }
    }

    /// Inputs that lift every held finger, and forget them.
    pub fn release(&mut self) -> Vec<DeviceInput> {
        let inputs = self
            .held
            .iter()
            .map(
                |(pointer_id, (x, y))| crate::platform::device_input::DeviceInput::Pointer {
                    phase: crate::platform::device_input::Phase::Up,
                    x: *x,
                    y: *y,
                    pointer_id: Some(*pointer_id),
                },
            )
            .collect();
        self.held.clear();
        inputs
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::device_input::{DeviceInput, Key};

    const DISPLAY: ScreenSize = ScreenSize {
        width: 1080.0,
        height: 2400.0,
    };
    const VIDEO: ScreenSize = ScreenSize {
        width: 540.0,
        height: 1200.0,
    };

    fn plan_of(input: DeviceInput) -> Vec<InputStep> {
        plan(&input, DISPLAY, VIDEO, 1).expect("plans")
    }

    fn first_key(key: Key) -> ControlMessage {
        plan_of(DeviceInput::Key { key })
            .first()
            .expect("a step")
            .message
            .clone()
    }

    #[test]
    fn a_tap_is_a_finger_down_and_up_at_the_point_scaled_into_the_video_frame() {
        let steps = plan_of(DeviceInput::Tap {
            x: 100.0,
            y: 2000.0,
        });
        let expected = |action, pressure| ControlMessage::Touch {
            action,
            pointer_id: PointerId(0),
            x: 50.0,
            y: 1000.0,
            screen: VIDEO,
            pressure,
        };
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].message, expected(TouchAction::Down, 1.0));
        assert_eq!(steps[1].message, expected(TouchAction::Up, 0.0));
        assert!(steps.iter().all(|step| step.delay_ms == 0.0));
    }

    #[test]
    fn each_finger_keeps_its_own_pointer_id_so_two_fingers_can_pinch() {
        let first = plan_of(DeviceInput::Pointer {
            phase: crate::platform::device_input::Phase::Down,
            x: 500.0,
            y: 1000.0,
            pointer_id: None,
        });
        let second = plan_of(DeviceInput::Pointer {
            phase: crate::platform::device_input::Phase::Down,
            x: 500.0,
            y: 1400.0,
            pointer_id: Some(1),
        });
        assert!(matches!(
            first[0].message,
            ControlMessage::Touch {
                action: TouchAction::Down,
                pointer_id: PointerId(0),
                ..
            }
        ));
        assert!(matches!(
            second[0].message,
            ControlMessage::Touch {
                action: TouchAction::Down,
                pointer_id: PointerId(1),
                y: 700.0,
                ..
            }
        ));
    }

    #[test]
    fn a_long_press_holds_the_finger_for_its_duration_before_lifting() {
        let steps = plan_of(DeviceInput::LongPress {
            x: 10.0,
            y: 10.0,
            duration_ms: 800.0,
        });
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].delay_ms, 0.0);
        assert_eq!(steps[1].delay_ms, 800.0);
        assert!(matches!(
            steps[1].message,
            ControlMessage::Touch {
                action: TouchAction::Up,
                ..
            }
        ));
    }

    #[test]
    fn a_swipe_moves_about_once_per_display_frame_and_spends_its_whole_duration_moving() {
        let steps = plan_of(DeviceInput::Swipe {
            x: 0.0,
            y: 2000.0,
            to_x: 0.0,
            to_y: 400.0,
            duration_ms: 160.0,
        });
        let moves: Vec<&InputStep> = steps
            .iter()
            .filter(|step| {
                matches!(
                    step.message,
                    ControlMessage::Touch {
                        action: TouchAction::Move,
                        ..
                    }
                )
            })
            .collect();
        assert_eq!(moves.len(), 10);
        let total: f64 = moves.iter().map(|step| step.delay_ms).sum();
        assert!((total - 160.0).abs() < 1e-9);
        assert!(matches!(
            steps.last().expect("an up").message,
            ControlMessage::Touch {
                action: TouchAction::Up,
                x: 0.0,
                y: 200.0,
                ..
            }
        ));
    }

    #[test]
    fn plain_ascii_is_injected_as_text_in_chunks_the_server_accepts() {
        let steps = plan_of(DeviceInput::Type {
            text: "a".repeat(650).into(),
        });
        let lengths: Vec<usize> = steps
            .iter()
            .map(|step| match &step.message {
                ControlMessage::Text { text } => text.len(),
                other => panic!("expected text, got {other:?}"),
            })
            .collect();
        assert_eq!(lengths, vec![300, 300, 50]);
    }

    #[test]
    fn text_the_keyboard_map_cannot_type_is_pasted_through_the_clipboard() {
        let steps = plan(
            &DeviceInput::Type {
                text: "héllo 👋".into(),
            },
            DISPLAY,
            VIDEO,
            7,
        )
        .expect("plans");
        assert_eq!(steps.len(), 1);
        assert_eq!(
            steps[0].message,
            ControlMessage::SetClipboard {
                sequence: PointerId(7),
                text: "héllo 👋".into(),
                paste: true,
            }
        );
    }

    #[test]
    fn pasted_text_is_capped_in_utf8_bytes_as_buffer_byte_length_counts_them() {
        // 65,532 emoji are 262,128 bytes and fit; one more is 262,132 and does not.
        let emoji = "\u{1f44b}";
        let fits = DeviceInput::Type {
            text: emoji.repeat(65_532).into(),
        };
        assert!(plan(&fits, DISPLAY, VIDEO, 1).is_ok());
        let too_long = DeviceInput::Type {
            text: emoji.repeat(65_533).into(),
        };
        assert!(matches!(
            plan(&too_long, DISPLAY, VIDEO, 1),
            Err(Error::Refused(refusal)) if refusal.code == crate::platform::Code::Limit
        ));
    }

    #[test]
    fn keys_map_to_navigation_and_system_actions() {
        assert!(matches!(
            first_key(Key::Home),
            ControlMessage::Keycode { keycode: 3, .. }
        ));
        assert!(matches!(
            first_key(Key::Recents),
            ControlMessage::Keycode { keycode: 187, .. }
        ));
        assert!(matches!(
            first_key(Key::Power),
            ControlMessage::Keycode { keycode: 26, .. }
        ));
        assert!(matches!(
            first_key(Key::Enter),
            ControlMessage::Keycode { keycode: 66, .. }
        ));
        assert!(matches!(
            first_key(Key::Back),
            ControlMessage::BackOrScreenOn {
                action: KeyAction::Down
            }
        ));
        assert_eq!(first_key(Key::Rotate), ControlMessage::Rotate);
    }

    #[test]
    fn the_volume_keys_press_volume_up_and_down_then_release_them() {
        for (key, code) in [(Key::VolumeUp, 24), (Key::VolumeDown, 25)] {
            let steps = plan_of(DeviceInput::Key { key });
            assert_eq!(
                steps
                    .iter()
                    .map(|step| step.message.clone())
                    .collect::<Vec<_>>(),
                vec![
                    ControlMessage::Keycode {
                        action: KeyAction::Down,
                        keycode: code,
                        repeat: 0,
                        meta: 0
                    },
                    ControlMessage::Keycode {
                        action: KeyAction::Up,
                        keycode: code,
                        repeat: 0,
                        meta: 0
                    },
                ]
            );
        }
    }

    #[test]
    fn the_keyboard_key_holds_alt_over_k_gboards_show_on_screen_keyboard() {
        let steps = plan_of(DeviceInput::Key { key: Key::Keyboard });
        let expected = |action, code, meta| ControlMessage::Keycode {
            action,
            keycode: code,
            repeat: 0,
            meta,
        };
        assert_eq!(
            steps
                .iter()
                .map(|step| step.message.clone())
                .collect::<Vec<_>>(),
            vec![
                expected(KeyAction::Down, 57, 0x12),
                expected(KeyAction::Down, 39, 0x12),
                expected(KeyAction::Up, 39, 0x12),
                expected(KeyAction::Up, 57, 0),
            ]
        );
    }

    #[test]
    fn the_iphone_action_button_and_side_key_are_refused_with_their_own_words() {
        for (key, message) in [
            (Key::Action, "Android has no Action button"),
            (Key::Side, "Only Apple Watch has a side key"),
        ] {
            match plan(&DeviceInput::Key { key }, DISPLAY, VIDEO, 1) {
                Err(Error::Refused(refusal)) => {
                    assert_eq!(refusal.code, crate::platform::Code::NotSupported);
                    assert_eq!(refusal.message, message);
                }
                Err(Error::Failed(failure)) => {
                    assert_eq!(failure.code, crate::platform::Code::NotSupported);
                    assert_eq!(failure.message, message);
                }
                other => panic!("expected a refusal, got {other:?}"),
            }
        }
    }

    fn plan_of_result(input: DeviceInput) -> Option<crate::platform::Code> {
        match plan(&input, DISPLAY, VIDEO, 1) {
            Ok(_) => None,
            Err(Error::Failed(failure)) => Some(failure.code),
            Err(Error::Refused(refusal)) => Some(refusal.code),
            Err(Error::Invalid(_)) => Some(crate::platform::Code::InvalidData),
        }
    }

    #[test]
    fn refuses_a_point_outside_the_screen_instead_of_injecting_it_at_the_edge() {
        assert_eq!(
            plan_of_result(DeviceInput::Tap { x: 1080.0, y: 10.0 }),
            Some(crate::platform::Code::InvalidData)
        );
    }

    #[test]
    fn a_swipe_from_the_bottom_edge_lands_when_the_rounded_picture_is_taller_than_the_display() {
        let steps = plan(
            &DeviceInput::Pointer {
                phase: crate::platform::device_input::Phase::Down,
                x: 540.0,
                y: 2360.0,
                pointer_id: None,
            },
            ScreenSize {
                width: 1080.0,
                height: 2340.0,
            },
            ScreenSize {
                width: 584.0,
                height: 1280.0,
            },
            0,
        )
        .expect("plans");
        match &steps[0].message {
            ControlMessage::Touch { action, y, .. } => {
                assert_eq!(*action, TouchAction::Down);
                assert!(*y > 1270.0 && *y < 1280.0, "y was {y}");
            }
            other => panic!("expected a touch, got {other:?}"),
        }
    }

    #[test]
    fn fingers_still_held_when_control_moves_on_are_lifted_where_they_were_last_seen() {
        let mut held = HeldPointers::new();
        held.apply(&DeviceInput::Pointer {
            phase: crate::platform::device_input::Phase::Down,
            x: 1.0,
            y: 2.0,
            pointer_id: None,
        });
        held.apply(&DeviceInput::Pointer {
            phase: crate::platform::device_input::Phase::Down,
            x: 3.0,
            y: 4.0,
            pointer_id: Some(1),
        });
        held.apply(&DeviceInput::Pointer {
            phase: crate::platform::device_input::Phase::Move,
            x: 5.0,
            y: 6.0,
            pointer_id: Some(1),
        });
        held.apply(&DeviceInput::Pointer {
            phase: crate::platform::device_input::Phase::Up,
            x: 1.0,
            y: 2.0,
            pointer_id: None,
        });
        assert_eq!(
            held.release(),
            vec![DeviceInput::Pointer {
                phase: crate::platform::device_input::Phase::Up,
                x: 5.0,
                y: 6.0,
                pointer_id: Some(1),
            }]
        );
        assert!(held.release().is_empty());
    }
}

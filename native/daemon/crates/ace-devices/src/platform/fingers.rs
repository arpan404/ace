// SPDX-License-Identifier: Apache-2.0
//! `simulator-fingers.ts`, `simulator-digitizer.ts` and `simulator-input.ts`'s decisions: the
//! fingers serve-sim holds (one touch with an optional system edge, or one two-finger touch), the
//! step Xcode's `--sim-touch` digitizer takes for each, and the HID message each hardware key
//! sends. Pure: the shell owns the processes, epochs and clocks.

use serde::{Deserialize, Serialize};

use crate::platform::device_input::Key;
use crate::platform::keys::refuse_simulator_key;
use crate::platform::{Error, Failure, Refusal};

/// A point normalized to the simulator framebuffer, 0..1 on each axis.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// serve-sim's touch phases.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SimPhase {
    Begin,
    Move,
    End,
}

/// One finger of a pair, as the pair keeps the first finger down in the first slot.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Finger {
    pub finger: u8,
    pub point: Point,
}

/// The fingers held on a simulator. serve-sim takes one touch (with an optional system-edge
/// flag) or one two-finger touch, so fingers 0 and 1 are the only ones it can hold. A pair keeps
/// the finger that came down first in the first slot. A finger left down after a two-finger
/// touch is `resting`: it reaches serve-sim again only once it moves.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HeldFingers {
    None,
    One {
        finger: u8,
        point: Point,
        edge: f64,
        resting: bool,
    },
    Two {
        pair: [Finger; 2],
    },
}

/// One serve-sim control message: tag 3 is a single touch, tag 5 a two-finger touch, tag 4 a
/// hardware button, tag 7 a rotation and tag 12 the software-keyboard toggle.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Message {
    pub tag: u8,
    pub payload: Payload,
}

/// Every field a serve-sim control payload can carry, in the order `JSON.stringify` writes the
/// shapes the TypeScript builds. A message fills one shape and leaves the rest absent.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct Payload {
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub phase: Option<SimPhase>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edge: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x1: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y1: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x2: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y2: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub button: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orientation: Option<&'static str>,
}

/// What the shell asks the finger state machine to do for one input.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FingerOp {
    Down {
        finger: u8,
        x: f64,
        y: f64,
        #[serde(default)]
        edge: f64,
    },
    Move {
        finger: u8,
        x: f64,
        y: f64,
    },
    Up {
        finger: u8,
    },
    /// Lift every held finger.
    End,
}

/// One operation on the held fingers.
pub fn step(op: &FingerOp, held: &HeldFingers) -> Result<FingerStep, Error> {
    match op {
        FingerOp::Down { finger, x, y, edge } => {
            Ok(finger_down(held, *finger, Point { x: *x, y: *y }, *edge))
        }
        FingerOp::Move { finger, x, y } => finger_move(held, *finger, Point { x: *x, y: *y }),
        FingerOp::Up { finger } => Ok(finger_up(held, *finger)),
        FingerOp::End => Ok(FingerStep {
            held: HeldFingers::None,
            messages: end_fingers(held),
        }),
    }
}

/// One finger step: the fingers that stay held, and the messages that get there.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FingerStep {
    pub held: HeldFingers,
    pub messages: Vec<Message>,
}

/// The fingers held when nothing is down.
pub const NO_FINGERS: HeldFingers = HeldFingers::None;

/// `simulator-fingers.ts`'s digitizer phases.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DigitizerPhase {
    Down,
    Move,
    Up,
}

/// One touch step for the screen helper's `--sim-touch` mode.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DigitizerStep {
    pub phase: DigitizerPhase,
    pub x: f64,
    pub y: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x2: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y2: Option<f64>,
    pub edge: f64,
    pub target: u32,
}

/// Pointer ids beyond the second finger have no serve-sim touch to map to.
pub fn simulator_finger(pointer_id: Option<u32>) -> Result<u8, Error> {
    match pointer_id.unwrap_or(0) {
        0 => Ok(0),
        1 => Ok(1),
        _ => Err(Refusal::word("simulatorTooManyFingers").into()),
    }
}

fn single(phase: SimPhase, point: Point, edge: f64) -> Message {
    Message {
        tag: 3,
        payload: Payload {
            phase: Some(phase),
            x: Some(point.x),
            y: Some(point.y),
            edge: (edge != 0.0).then_some(edge),
            ..Payload::default()
        },
    }
}

fn pair_message(phase: SimPhase, pair: &[Finger; 2]) -> Message {
    Message {
        tag: 5,
        payload: Payload {
            phase: Some(phase),
            x1: Some(pair[0].point.x),
            y1: Some(pair[0].point.y),
            x2: Some(pair[1].point.x),
            y2: Some(pair[1].point.y),
            ..Payload::default()
        },
    }
}

fn moved(pair: &[Finger; 2], finger: u8, point: Point) -> [Finger; 2] {
    if pair[0].finger == finger {
        [Finger { finger, point }, pair[1]]
    } else {
        [pair[0], Finger { finger, point }]
    }
}

/// A finger touches down. A second finger turns the held touch into a two-finger touch with no
/// lift in between: lifting the first finger there would reach iOS as a tap.
pub fn finger_down(held: &HeldFingers, finger: u8, point: Point, edge: f64) -> FingerStep {
    match held {
        HeldFingers::One {
            finger: down,
            point: first,
            ..
        } if *down != finger => {
            let pair = [
                Finger {
                    finger: *down,
                    point: *first,
                },
                Finger { finger, point },
            ];
            FingerStep {
                held: HeldFingers::Two { pair },
                messages: vec![pair_message(SimPhase::Begin, &pair)],
            }
        }
        HeldFingers::Two { pair } => {
            let next = moved(pair, finger, point);
            FingerStep {
                held: HeldFingers::Two { pair: next },
                messages: vec![
                    pair_message(SimPhase::End, pair),
                    pair_message(SimPhase::Begin, &next),
                ],
            }
        }
        other => FingerStep {
            held: HeldFingers::One {
                finger,
                point,
                edge,
                resting: false,
            },
            messages: {
                let mut messages = end_fingers(other);
                messages.push(single(SimPhase::Begin, point, edge));
                messages
            },
        },
    }
}

/// A held finger moves; moving a finger that is not down is a caller error.
pub fn finger_move(held: &HeldFingers, finger: u8, point: Point) -> Result<FingerStep, Error> {
    match held {
        HeldFingers::Two { pair } => {
            let next = moved(pair, finger, point);
            Ok(FingerStep {
                held: HeldFingers::Two { pair: next },
                messages: vec![pair_message(SimPhase::Move, &next)],
            })
        }
        HeldFingers::One {
            finger: down,
            point: previous,
            edge,
            resting,
        } if *down == finger => {
            let mut messages = Vec::new();
            if *resting {
                messages.push(single(SimPhase::Begin, *previous, *edge));
            }
            messages.push(single(SimPhase::Move, point, *edge));
            Ok(FingerStep {
                held: HeldFingers::One {
                    finger,
                    point,
                    edge: *edge,
                    resting: false,
                },
                messages,
            })
        }
        _ => Err(Error::Invalid("Simulator pointer is not held".into())),
    }
}

/// A finger lifts. Lifting one of two fingers ends the two-finger touch; the other finger rests
/// until it moves, so lifting it straight after (fingers rarely lift together) is not a tap.
pub fn finger_up(held: &HeldFingers, finger: u8) -> FingerStep {
    match held {
        HeldFingers::Two { pair } => {
            let other = if pair[0].finger == finger {
                pair[1]
            } else {
                pair[0]
            };
            FingerStep {
                held: HeldFingers::One {
                    finger: other.finger,
                    point: other.point,
                    edge: 0.0,
                    resting: true,
                },
                messages: vec![pair_message(SimPhase::End, pair)],
            }
        }
        HeldFingers::One { finger: down, .. } if *down == finger => FingerStep {
            held: HeldFingers::None,
            messages: end_fingers(held),
        },
        other => FingerStep {
            held: other.clone(),
            messages: Vec::new(),
        },
    }
}

/// The messages that lift every held finger.
pub fn end_fingers(held: &HeldFingers) -> Vec<Message> {
    match held {
        HeldFingers::One {
            point,
            edge,
            resting,
            ..
        } => {
            if *resting {
                Vec::new()
            } else {
                vec![single(SimPhase::End, *point, *edge)]
            }
        }
        HeldFingers::Two { pair } => vec![pair_message(SimPhase::End, pair)],
        HeldFingers::None => Vec::new(),
    }
}

/// A finger message as it arrives from the shell: the same JSON a [`Message`] serializes to,
/// read without the borrowed button and orientation names.
#[derive(Debug, Clone, Deserialize)]
pub struct WireMessage {
    pub tag: u8,
    pub payload: WirePayload,
}

/// The finger fields of a [`WireMessage`]; a button payload carries none.
#[derive(Debug, Clone, Deserialize)]
pub struct WirePayload {
    #[serde(rename = "type")]
    pub phase: Option<String>,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    #[serde(default)]
    pub edge: Option<f64>,
    #[serde(default)]
    pub x1: Option<f64>,
    #[serde(default)]
    pub y1: Option<f64>,
    #[serde(default)]
    pub x2: Option<f64>,
    #[serde(default)]
    pub y2: Option<f64>,
}

/// A finger message as the digitizer step it becomes; a message that carries no finger is a
/// caller error, never a touch.
pub fn digitizer_step(message: &WireMessage, target: u32) -> Result<DigitizerStep, Error> {
    let phase = match message.payload.phase.as_deref() {
        Some("begin") => DigitizerPhase::Down,
        Some("move") => DigitizerPhase::Move,
        Some("end") => DigitizerPhase::Up,
        _ => {
            return Err(Error::Invalid(
                "the digitizer takes a finger message".into(),
            ));
        }
    };
    if message.tag == 3 {
        return Ok(DigitizerStep {
            phase,
            x: message.payload.x.unwrap_or(0.0),
            y: message.payload.y.unwrap_or(0.0),
            x2: None,
            y2: None,
            edge: message.payload.edge.unwrap_or(0.0),
            target,
        });
    }
    Ok(DigitizerStep {
        phase,
        x: message.payload.x1.unwrap_or(0.0),
        y: message.payload.y1.unwrap_or(0.0),
        x2: message.payload.x2,
        y2: message.payload.y2,
        edge: 0.0,
        target,
    })
}

/// The screen edge a normalized point lies on, as serve-sim's touch `edge` field names it:
/// 1 left, 2 top, 3 bottom, 4 right, 0 none. The band is 2% of the screen.
pub fn screen_edge(x: f64, y: f64) -> u8 {
    const BAND: f64 = 0.02;
    if y >= 1.0 - BAND {
        3
    } else if y < BAND {
        2
    } else if x < BAND {
        1
    } else if x >= 1.0 - BAND {
        4
    } else {
        0
    }
}

/// serve-sim's HID tag for a press of Simulator's I/O ▸ Keyboard ▸ Toggle Software Keyboard.
pub const SOFTWARE_KEYBOARD_TOGGLE: u8 = 12;
/// serve-sim's typing exits before iOS has handled every key it sent; a toggle sent 250 ms later
/// kept the keyboard where one sent at once lost it.
pub const TYPING_SETTLE_MS: u64 = 250;
/// How long one typed string may take before the typing process is stopped.
pub const TYPING_TIMEOUT_MS: u64 = 10_000;

/// The HID (usage page, usage) Xcode's device chrome gives each hardware button: consumer page
/// 0x0C for Sleep/Wake, Volume Up, Volume Down and Apple Watch's side button, telephony page
/// 0x0B for the Action button.
fn hardware_button(key: Key) -> Option<(u16, u16)> {
    match key {
        Key::Power => Some((12, 48)),
        Key::VolumeUp => Some((12, 233)),
        Key::VolumeDown => Some((12, 234)),
        Key::Action => Some((11, 45)),
        Key::Side => Some((12, 149)),
        _ => None,
    }
}

/// What a key does on a Simulator: send a serve-sim message, type a line (Return), or nothing
/// because the Simulator has no such key.
#[derive(Debug, Clone, PartialEq)]
pub enum KeyAction {
    Press(Message),
    /// `typing.stdin.end("\n")`, as today's Return does.
    Type(String),
}

/// The serve-sim message a hardware key sends, the line it types, or the refusal for a key a
/// Simulator has no press for. `orientation` is the capture's current one, which `rotate` flips.
pub fn key_action(key: Key, orientation: &str) -> Result<KeyAction, Error> {
    if key == Key::Enter {
        return Ok(KeyAction::Type("\n".to_string()));
    }
    if key == Key::Rotate {
        return Ok(KeyAction::Press(Message {
            tag: 7,
            payload: Payload {
                orientation: Some(if orientation == "portrait" {
                    "landscape_left"
                } else {
                    "portrait"
                }),
                ..Payload::default()
            },
        }));
    }
    if key == Key::Home {
        return Ok(KeyAction::Press(Message {
            tag: 4,
            payload: Payload {
                button: Some("home"),
                ..Payload::default()
            },
        }));
    }
    if let Some((page, usage)) = hardware_button(key) {
        return Ok(KeyAction::Press(Message {
            tag: 4,
            payload: Payload {
                button: (key == Key::Power).then_some("power"),
                page: Some(page),
                usage: Some(usage),
                ..Payload::default()
            },
        }));
    }
    if key == Key::Keyboard {
        return Ok(KeyAction::Press(Message {
            tag: SOFTWARE_KEYBOARD_TOGGLE,
            payload: Payload::default(),
        }));
    }
    Err(refuse_simulator_key(key))
}

/// The arguments of the process that types into a Simulator: `type --stdin -d <device>`.
pub fn typing_args(device: &str) -> Vec<String> {
    vec![
        "type".to_string(),
        "--stdin".to_string(),
        "-d".to_string(),
        device.to_string(),
    ]
}

/// A device point as serve-sim's normalized one, refused outside the current frame.
pub fn normalized_point(x: f64, y: f64, width: f64, height: f64) -> Result<Point, Error> {
    if width == 0.0 || height == 0.0 || x < 0.0 || y < 0.0 || x >= width || y >= height {
        return Err(Error::Failed(Failure {
            code: crate::platform::Code::InvalidData,
            message: "Simulator input is outside the current frame".to_string(),
            hint: "Wait for the next frame, then retry.".to_string(),
        }));
    }
    Ok(Point {
        x: x / width,
        y: y / height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    fn single_message(phase: SimPhase, x: f64, y: f64, edge: Option<f64>) -> Message {
        Message {
            tag: 3,
            payload: Payload {
                phase: Some(phase),
                x: Some(x),
                y: Some(y),
                edge,
                ..Payload::default()
            },
        }
    }

    fn pair_phase(phase: SimPhase, a: (f64, f64), b: (f64, f64)) -> Message {
        Message {
            tag: 5,
            payload: Payload {
                phase: Some(phase),
                x1: Some(a.0),
                y1: Some(a.1),
                x2: Some(b.0),
                y2: Some(b.1),
                ..Payload::default()
            },
        }
    }

    #[test]
    fn a_finger_that_starts_on_a_screen_edge_keeps_its_edge_gesture_until_it_lifts() {
        let down = finger_down(&NO_FINGERS, 0, point(0.5, 0.99), 3.0);
        let moved = finger_move(&down.held, 0, point(0.5, 0.6)).expect("held");
        let mut messages = down.messages.clone();
        messages.extend(moved.messages.clone());
        messages.extend(finger_up(&moved.held, 0).messages.clone());
        assert_eq!(
            messages,
            vec![
                single_message(SimPhase::Begin, 0.5, 0.99, Some(3.0)),
                single_message(SimPhase::Move, 0.5, 0.6, Some(3.0)),
                single_message(SimPhase::End, 0.5, 0.6, Some(3.0)),
            ]
        );
    }

    #[test]
    fn a_second_finger_joins_the_held_touch_without_lifting_it_behind_the_finger_already_down() {
        let first = finger_down(&NO_FINGERS, 1, point(0.5, 0.9), 0.0);
        assert_eq!(
            finger_down(&first.held, 0, point(0.2, 0.3), 0.0).messages,
            vec![pair_phase(SimPhase::Begin, (0.5, 0.9), (0.2, 0.3))]
        );
    }

    #[test]
    fn lifting_two_fingers_one_after_the_other_ends_the_touch_without_a_stray_tap() {
        let first = finger_down(&NO_FINGERS, 0, point(0.5, 0.2), 0.0);
        let pair = finger_down(&first.held, 1, point(0.5, 0.8), 0.0);
        let lifted = finger_up(&pair.held, 0);
        let mut messages = lifted.messages.clone();
        let second = finger_up(&lifted.held, 1);
        messages.extend(second.messages.clone());
        assert_eq!(
            messages,
            vec![pair_phase(SimPhase::End, (0.5, 0.2), (0.5, 0.8))]
        );
        assert_eq!(second.held, NO_FINGERS);
    }

    #[test]
    fn lifting_a_finger_that_is_not_down_sends_nothing_and_moving_one_is_refused() {
        let one = finger_down(&NO_FINGERS, 0, point(0.1, 0.1), 0.0).held;
        assert_eq!(finger_up(&one, 1).messages, Vec::new());
        assert_eq!(finger_up(&one, 1).held, one);
        assert_eq!(finger_up(&NO_FINGERS, 0).held, NO_FINGERS);
        assert!(finger_move(&one, 1, point(0.2, 0.2)).is_err());
        assert!(finger_move(&NO_FINGERS, 0, point(0.2, 0.2)).is_err());
    }

    #[test]
    fn a_third_finger_has_no_serve_sim_touch_to_map_to() {
        let error = simulator_finger(Some(2)).expect_err("refused");
        assert_eq!(
            error.to_string(),
            "not_supported: iOS Simulator input supports at most two fingers"
        );
        assert_eq!(simulator_finger(None).ok(), Some(0));
        assert_eq!(simulator_finger(Some(1)).ok(), Some(1));
    }

    #[test]
    fn hardware_buttons_send_the_hid_codes_xcodes_device_chrome_gives_them() {
        let payload = |key: Key| match key_action(key, "portrait").expect("a key") {
            KeyAction::Press(message) => (message.tag, message.payload),
            KeyAction::Type(_) => panic!("a button types nothing"),
        };
        assert_eq!(
            payload(Key::VolumeUp),
            (
                4,
                Payload {
                    page: Some(12),
                    usage: Some(233),
                    ..Payload::default()
                }
            )
        );
        assert_eq!(
            payload(Key::VolumeDown),
            (
                4,
                Payload {
                    page: Some(12),
                    usage: Some(234),
                    ..Payload::default()
                }
            )
        );
        assert_eq!(
            payload(Key::Action),
            (
                4,
                Payload {
                    page: Some(11),
                    usage: Some(45),
                    ..Payload::default()
                }
            )
        );
        assert_eq!(
            payload(Key::Power),
            (
                4,
                Payload {
                    button: Some("power"),
                    page: Some(12),
                    usage: Some(48),
                    ..Payload::default()
                }
            )
        );
        assert_eq!(
            payload(Key::Side),
            (
                4,
                Payload {
                    page: Some(12),
                    usage: Some(149),
                    ..Payload::default()
                }
            )
        );
        assert_eq!(
            payload(Key::Home),
            (
                4,
                Payload {
                    button: Some("home"),
                    ..Payload::default()
                }
            )
        );
        // Rotate flips the announced orientation; the keyboard key is the software toggle.
        match key_action(Key::Rotate, "portrait").expect("a turn") {
            KeyAction::Press(message) => {
                assert_eq!(message.tag, 7);
                assert_eq!(message.payload.orientation, Some("landscape_left"));
            }
            KeyAction::Type(_) => panic!("a turn types nothing"),
        }
        assert_eq!(
            key_action(Key::Keyboard, "portrait").expect("a toggle"),
            KeyAction::Press(Message {
                tag: 12,
                payload: Payload::default()
            })
        );
        // Return types a newline, as today's Simulator typing does.
        assert_eq!(
            key_action(Key::Enter, "portrait").ok(),
            Some(KeyAction::Type("\n".into()))
        );
        assert_eq!(
            key_action(Key::Back, "portrait")
                .expect_err("refused")
                .to_string(),
            "not_supported: iOS has no Back key"
        );
    }
}

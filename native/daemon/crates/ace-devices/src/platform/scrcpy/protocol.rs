// SPDX-License-Identifier: Apache-2.0
//! `scrcpy-protocol.ts`'s control half: the client-to-server control messages and the
//! server-to-client stream reader. Pure: no sockets, no clocks. The video half is D3.3's.

use serde::{Deserialize, Serialize};

use crate::platform::{Error, Failure};

/// The server refuses longer injected text; longer strings are split by the caller.
pub const INJECT_TEXT_LIMIT: usize = 300;
/// The server's control message cap is 256 KiB; a clipboard message carries 14 header bytes.
pub const CLIPBOARD_TEXT_LIMIT: usize = (1 << 18) - 14;

/// A display's size in points or video pixels.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ScreenSize {
    pub width: f64,
    pub height: f64,
}

/// Android `MotionEvent` actions the server accepts per pointer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TouchAction {
    Down,
    Up,
    Move,
    Cancel,
}

impl TouchAction {
    fn code(self) -> u8 {
        match self {
            Self::Down => 0,
            Self::Up => 1,
            Self::Move => 2,
            Self::Cancel => 3,
        }
    }
}

/// Android `KeyEvent` actions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyAction {
    Down,
    Up,
}

impl KeyAction {
    fn code(self) -> u8 {
        match self {
            Self::Down => 0,
            Self::Up => 1,
        }
    }
}

/// Android `KeyEvent` codes ace sends.
pub mod keycode {
    pub const HOME: i32 = 3;
    pub const BACK: i32 = 4;
    pub const VOLUME_UP: i32 = 24;
    pub const VOLUME_DOWN: i32 = 25;
    pub const POWER: i32 = 26;
    pub const ENTER: i32 = 66;
    pub const APP_SWITCH: i32 = 187;
    pub const K: i32 = 39;
    pub const ALT_LEFT: i32 = 57;
}

/// `KeyEvent` meta state with the left Alt key held: META_ALT_ON | META_ALT_LEFT_ON.
pub const ALT_ON: i32 = 0x12;

/// The control messages this client sends, as `ControlMessage` names them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ControlMessage {
    Keycode {
        action: KeyAction,
        keycode: i32,
        /// Absent until a key repeats, as today's messages leave it.
        #[serde(default, skip_serializing_if = "is_zero")]
        repeat: i32,
        /// Absent unless a modifier is held, as today's messages leave it.
        #[serde(default, skip_serializing_if = "is_zero")]
        meta: i32,
    },
    Text {
        text: String,
    },
    Touch {
        action: TouchAction,
        #[serde(rename = "pointerId")]
        pointer_id: PointerId,
        x: f64,
        y: f64,
        screen: ScreenSize,
        pressure: f64,
    },
    Scroll {
        x: f64,
        y: f64,
        screen: ScreenSize,
        dx: f64,
        dy: f64,
    },
    BackOrScreenOn {
        action: KeyAction,
    },
    GetClipboard,
    SetClipboard {
        #[serde(rename = "sequence")]
        sequence: PointerId,
        text: String,
        paste: bool,
    },
    Rotate,
    ResetVideo,
}

/// Whether a key message's field is today's default and stays out of its JSON.
fn is_zero(value: &i32) -> bool {
    *value == 0
}

/// A `bigint` on the wire: the shell writes it as its decimal digits, so a sequence past
/// `Number.MAX_SAFE_INTEGER` keeps every bit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct PointerId(pub u64);

impl TryFrom<String> for PointerId {
    type Error = String;
    fn try_from(text: String) -> Result<Self, Self::Error> {
        text.parse::<u64>().map(Self).map_err(|_| text)
    }
}

impl From<PointerId> for String {
    fn from(id: PointerId) -> Self {
        id.0.to_string()
    }
}

/// `Math.max(0, Math.min(0x7fffffff, Math.round(value)))`.
fn clamp_int(value: f64) -> i32 {
    let rounded = js_round(value);
    rounded.clamp(0.0, 0x7fff_ffff as f64) as i32
}

/// `Math.max(0, Math.min(0xffff, Math.round(value)))`.
fn u16_clamped(value: f64) -> u16 {
    js_round(value).clamp(0.0, 0xffff as f64) as u16
}

/// `Math.round`, which rounds a half up towards positive infinity where `f64::round` rounds a
/// half away from zero. Points are clamped non-negative first, but a scroll can be negative.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// Pressure is an unsigned 16-bit fixed-point fraction where 0xffff is exactly 1.0.
fn pressure(value: f64) -> u16 {
    if value >= 1.0 {
        0xffff
    } else {
        u16_clamped(value.max(0.0) * 0x1_0000 as f64)
    }
}

/// Scroll amounts are signed 16-bit fixed point over [-16, 16].
fn scroll_amount(value: f64) -> i16 {
    let scaled = js_round((value.clamp(-16.0, 16.0) / 16.0) * 0x8000 as f64);
    scaled.clamp(-0x8000 as f64, 0x7fff as f64) as i16
}

fn position(out: &mut Vec<u8>, x: f64, y: f64, screen: ScreenSize) {
    out.extend_from_slice(&clamp_int(x).to_be_bytes());
    out.extend_from_slice(&clamp_int(y).to_be_bytes());
    out.extend_from_slice(&u16_clamped(screen.width).to_be_bytes());
    out.extend_from_slice(&u16_clamped(screen.height).to_be_bytes());
}

/// The message's server text as UTF-8, refused past `limit` bytes as `scrcpy-protocol.ts` does.
fn utf8(text: &str, limit: usize) -> Result<&[u8], Error> {
    let bytes = text.as_bytes();
    if bytes.len() > limit {
        return Err(Error::Invalid(
            "scrcpy text exceeds the server's limit".into(),
        ));
    }
    Ok(bytes)
}

/// The bytes the control socket carries for `message`.
pub fn encode(message: &ControlMessage) -> Result<Vec<u8>, Error> {
    match message {
        ControlMessage::Keycode {
            action,
            keycode,
            repeat,
            meta,
        } => {
            let mut out = Vec::with_capacity(14);
            out.push(0);
            out.push(action.code());
            out.extend_from_slice(&keycode.to_be_bytes());
            out.extend_from_slice(&repeat.to_be_bytes());
            out.extend_from_slice(&meta.to_be_bytes());
            Ok(out)
        }
        ControlMessage::Text { text } => {
            let bytes = utf8(text, INJECT_TEXT_LIMIT)?;
            let mut out = Vec::with_capacity(5 + bytes.len());
            out.push(1);
            out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
            out.extend_from_slice(bytes);
            Ok(out)
        }
        ControlMessage::Touch {
            action,
            pointer_id,
            x,
            y,
            screen,
            pressure: force,
        } => {
            let mut out = Vec::with_capacity(32);
            out.push(2);
            out.push(action.code());
            out.extend_from_slice(&(pointer_id.0 as i64).to_be_bytes());
            position(&mut out, *x, *y, *screen);
            out.extend_from_slice(&pressure(*force).to_be_bytes());
            // A finger has no mouse buttons: action button and button state are both zero.
            out.extend_from_slice(&0i32.to_be_bytes());
            out.extend_from_slice(&0i32.to_be_bytes());
            Ok(out)
        }
        ControlMessage::Scroll {
            x,
            y,
            screen,
            dx,
            dy,
        } => {
            let mut out = Vec::with_capacity(21);
            out.push(3);
            position(&mut out, *x, *y, *screen);
            out.extend_from_slice(&scroll_amount(*dx).to_be_bytes());
            out.extend_from_slice(&scroll_amount(*dy).to_be_bytes());
            out.extend_from_slice(&0i32.to_be_bytes());
            Ok(out)
        }
        ControlMessage::BackOrScreenOn { action } => Ok(vec![4, action.code()]),
        // Copy key "none": read the clipboard without pressing copy or cut first.
        ControlMessage::GetClipboard => Ok(vec![8, 0]),
        ControlMessage::SetClipboard {
            sequence,
            text,
            paste,
        } => {
            let bytes = utf8(text, CLIPBOARD_TEXT_LIMIT)?;
            let mut out = Vec::with_capacity(14 + bytes.len());
            out.push(9);
            out.extend_from_slice(&sequence.0.to_be_bytes());
            out.push(if *paste { 1 } else { 0 });
            out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
            out.extend_from_slice(bytes);
            Ok(out)
        }
        ControlMessage::Rotate => Ok(vec![11]),
        ControlMessage::ResetVideo => Ok(vec![17]),
    }
}

/// A message the device sent on the control socket.
#[derive(Debug, Clone, PartialEq)]
pub enum DeviceMessage {
    Clipboard(String),
    ClipboardAck(u64),
    UhidOutput { id: u16, bytes: u16 },
    Unknown(u8),
}

/// Splits the server's device-to-client control stream into messages. An unknown message type
/// has no length we can trust, so it ends parsing: the caller reports it and stops reading.
#[derive(Debug, Default)]
pub struct DeviceMessageReader {
    buffer: Vec<u8>,
    broken: bool,
}

/// The reader's own oversize text, as today's `Error` messages spell them.
fn too_large(message: &'static str) -> Error {
    Error::Failed(Failure {
        code: crate::platform::Code::CommandFailed,
        message: message.to_string(),
        hint: "Restart the device view.".to_string(),
    })
}

impl DeviceMessageReader {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds one socket chunk and returns every complete message it holds.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<DeviceMessage>, Error> {
        if self.broken {
            return Ok(Vec::new());
        }
        self.buffer.extend_from_slice(chunk);
        if self.buffer.len() > CLIPBOARD_TEXT_LIMIT + 64 {
            return Err(too_large("scrcpy device message exceeds limit"));
        }
        let mut messages = Vec::new();
        while let Some((message, consumed)) = self.next()? {
            messages.push(message);
            self.buffer.drain(..consumed);
            if self.broken {
                break;
            }
        }
        Ok(messages)
    }

    fn next(&mut self) -> Result<Option<(DeviceMessage, usize)>, Error> {
        let buffer = &self.buffer;
        let Some(&code) = buffer.first() else {
            return Ok(None);
        };
        match code {
            0 => {
                if buffer.len() < 5 {
                    return Ok(None);
                }
                let length = u32::from_be_bytes([buffer[1], buffer[2], buffer[3], buffer[4]]);
                if length as usize > CLIPBOARD_TEXT_LIMIT {
                    return Err(too_large("scrcpy clipboard exceeds limit"));
                }
                if buffer.len() < 5 + length as usize {
                    return Ok(None);
                }
                let text = String::from_utf8_lossy(&buffer[5..5 + length as usize]).into_owned();
                Ok(Some((DeviceMessage::Clipboard(text), 5 + length as usize)))
            }
            1 => {
                if buffer.len() < 9 {
                    return Ok(None);
                }
                let mut word = [0u8; 8];
                word.copy_from_slice(&buffer[1..9]);
                Ok(Some((
                    DeviceMessage::ClipboardAck(u64::from_be_bytes(word)),
                    9,
                )))
            }
            2 => {
                if buffer.len() < 5 {
                    return Ok(None);
                }
                let id = u16::from_be_bytes([buffer[1], buffer[2]]);
                let length = u16::from_be_bytes([buffer[3], buffer[4]]);
                if buffer.len() < 5 + length as usize {
                    return Ok(None);
                }
                Ok(Some((
                    DeviceMessage::UhidOutput { id, bytes: length },
                    5 + length as usize,
                )))
            }
            other => {
                self.broken = true;
                Ok(Some((DeviceMessage::Unknown(other), 0)))
            }
        }
    }
}

/// The 31-bit session id names the device's abstract socket, so concurrent servers never meet.
pub fn socket_name(scid: u32) -> String {
    format!("scrcpy_{:08x}", scid)
}

/// One server profile, as `ServerProfile` declares it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ServerProfile {
    pub scid: u32,
    pub max_size: f64,
    pub bitrate: f64,
    pub fps: f64,
    /// false: control only, the picture comes from elsewhere (an emulator encoded on the host).
    pub video: bool,
}

/// Server arguments after the class name: video on (unless asked off), audio off, control on.
pub fn server_args(version: &str, profile: &ServerProfile) -> Vec<String> {
    let mut args = vec![
        version.to_string(),
        format!("scid={:08x}", profile.scid),
        "log_level=warn".to_string(),
        format!("video={}", profile.video),
        "audio=false".to_string(),
        "control=true".to_string(),
        "tunnel_forward=true".to_string(),
    ];
    if profile.video {
        args.push("video_codec=h264".to_string());
        args.push(format!(
            "max_size={}",
            floor(profile.max_size).max(0.0) as i64
        ));
        args.push(format!(
            "video_bit_rate={}",
            floor(profile.bitrate).max(1.0) as i64
        ));
        args.push(format!("max_fps={}", floor(profile.fps).max(1.0) as i64));
    }
    // Device clipboard changes would otherwise be pushed to the daemon, which never uses them.
    args.extend(
        [
            "clipboard_autosync=false",
            "cleanup=true",
            "power_on=false",
            "stay_awake=false",
            "show_touches=false",
        ]
        .map(str::to_string),
    );
    args
}

fn floor(value: f64) -> f64 {
    value.floor()
}

/// Device H.264 encoders commonly refuse an edge much past 2160 (an emulator's did in
/// landscape), and the server only shrinks after a failed start; keep the longer edge there.
const LONGEST_FRAME_EDGE: f64 = 2160.0;

/// The server's `max_size` bounds the longer edge. Fit the display inside the viewer's box, keep
/// the aspect ratio, never upscale, and stay within what encoders accept in either orientation.
pub fn max_size(display: ScreenSize, box_width: f64, box_height: f64) -> i64 {
    let factor = 1.0_f64
        .min(box_width / display.width)
        .min(box_height / display.height);
    let longest = display.width.max(display.height);
    let fitted = (longest * factor).min(LONGEST_FRAME_EDGE);
    if fitted >= longest {
        return 0;
    }
    (floor(fitted / 8.0) * 8.0).max(16.0) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(action: TouchAction, x: f64, y: f64, force: f64) -> Vec<u8> {
        let message = ControlMessage::Touch {
            action,
            pointer_id: PointerId(0),
            x,
            y,
            screen: ScreenSize {
                width: 540.0,
                height: 1200.0,
            },
            pressure: force,
        };
        encode(&message).expect("encodes")
    }

    #[test]
    fn a_keycode_message_is_fourteen_bytes_of_the_servers_layout() {
        let message = ControlMessage::Keycode {
            action: KeyAction::Down,
            keycode: keycode::HOME,
            repeat: 0,
            meta: 0,
        };
        assert_eq!(
            encode(&message).expect("encodes"),
            vec![0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0]
        );
    }

    #[test]
    fn alt_k_carries_the_alt_meta_state_on_the_keys_it_holds() {
        let down = encode(&ControlMessage::Keycode {
            action: KeyAction::Down,
            keycode: keycode::K,
            repeat: 0,
            meta: ALT_ON,
        })
        .expect("encodes");
        assert_eq!(down[0], 0);
        assert_eq!(down[1], 0);
        assert_eq!(&down[2..6], &39i32.to_be_bytes());
        assert_eq!(&down[10..14], &0x12i32.to_be_bytes());
    }

    #[test]
    fn a_touch_message_is_32_bytes_with_the_picture_size_and_fixed_point_pressure() {
        assert_eq!(
            touch(TouchAction::Down, 50.0, 1000.0, 1.0),
            vec![
                2, 0, // type, action
                0, 0, 0, 0, 0, 0, 0, 0, // pointer id
                0, 0, 0, 50, // x
                0, 0, 3, 232, // y
                2, 28, // screen width 540
                4, 176, // screen height 1200
                255, 255, // pressure 1.0
                0, 0, 0, 0, 0, 0, 0, 0, // buttons
            ]
        );
        assert_eq!(&touch(TouchAction::Up, 0.0, 0.0, 0.0)[22..24], &[0, 0]);
        assert_eq!(&touch(TouchAction::Move, 0.0, 0.0, 0.5)[22..24], &[128, 0]);
    }

    #[test]
    fn a_scroll_message_is_21_bytes_of_signed_fixed_point() {
        let message = ControlMessage::Scroll {
            x: 1.0,
            y: 2.0,
            screen: ScreenSize {
                width: 540.0,
                height: 1200.0,
            },
            dx: 16.0,
            dy: -16.0,
        };
        let bytes = encode(&message).expect("encodes");
        assert_eq!(bytes.len(), 21);
        assert_eq!(bytes[0], 3);
        assert_eq!(&bytes[13..15], &0x7fffi16.to_be_bytes());
        assert_eq!(&bytes[15..17], &(-0x8000i16).to_be_bytes());
        assert_eq!(&bytes[17..21], &[0, 0, 0, 0]);
    }

    #[test]
    fn text_is_its_utf8_length_and_a_clipboard_write_keeps_its_sequence_and_paste_flag() {
        let text = encode(&ControlMessage::Text { text: "é".into() }).expect("encodes");
        assert_eq!(&text[..5], &[1, 0, 0, 0, 2]);
        assert_eq!(&text[5..], "é".as_bytes());

        let clipboard = encode(&ControlMessage::SetClipboard {
            sequence: PointerId(7),
            text: "hi".into(),
            paste: true,
        })
        .expect("encodes");
        assert_eq!(clipboard.len(), 16);
        assert_eq!(clipboard[0], 9);
        assert_eq!(&clipboard[1..9], &7u64.to_be_bytes());
        assert_eq!(clipboard[9], 1);
        assert_eq!(&clipboard[10..14], &2u32.to_be_bytes());
        assert_eq!(&clipboard[14..], b"hi");
    }

    #[test]
    fn back_rotate_and_clipboard_reads_are_the_servers_small_fixed_frames() {
        assert_eq!(
            encode(&ControlMessage::BackOrScreenOn {
                action: KeyAction::Up
            })
            .expect("encodes"),
            vec![4, 1]
        );
        assert_eq!(
            encode(&ControlMessage::GetClipboard).expect("encodes"),
            vec![8, 0]
        );
        assert_eq!(encode(&ControlMessage::Rotate).expect("encodes"), vec![11]);
        assert_eq!(
            encode(&ControlMessage::ResetVideo).expect("encodes"),
            vec![17]
        );
    }

    #[test]
    fn text_past_the_servers_limit_is_refused_rather_than_split_here() {
        let long = "a".repeat(INJECT_TEXT_LIMIT + 1);
        assert!(encode(&ControlMessage::Text { text: long }).is_err());
    }

    #[test]
    fn the_device_stream_splits_clipboard_acknowledgements_and_uhid_output() {
        let mut reader = DeviceMessageReader::new();
        assert_eq!(reader.push(&[1, 0, 0]).expect("reads"), Vec::new());
        assert_eq!(
            reader.push(&[0, 0, 0, 0, 0, 3]).expect("reads"),
            vec![DeviceMessage::ClipboardAck(3)]
        );
        let mut clipboard = vec![0, 0, 0, 0, 2];
        clipboard.extend_from_slice(b"hi");
        clipboard.extend_from_slice(&[2, 0, 1, 0, 2, 0xaa, 0xbb]);
        assert_eq!(
            reader.push(&clipboard).expect("reads"),
            vec![
                DeviceMessage::Clipboard("hi".into()),
                DeviceMessage::UhidOutput { id: 1, bytes: 2 },
            ]
        );
    }

    #[test]
    fn an_unknown_device_message_ends_the_stream_and_is_reported_once() {
        let mut reader = DeviceMessageReader::new();
        assert_eq!(
            reader.push(&[9, 1, 2, 3]).expect("reads"),
            vec![DeviceMessage::Unknown(9)]
        );
        assert_eq!(reader.push(&[0, 0]).expect("reads"), Vec::new());
    }

    #[test]
    fn the_session_socket_and_the_server_arguments_follow_the_profile() {
        assert_eq!(socket_name(0x1234), "scrcpy_00001234");
        let profile = ServerProfile {
            scid: 0x0abc,
            max_size: 1080.0,
            bitrate: 12_000_000.0,
            fps: 60.0,
            video: true,
        };
        assert_eq!(
            server_args("2.4", &profile),
            vec![
                "2.4",
                "scid=00000abc",
                "log_level=warn",
                "video=true",
                "audio=false",
                "control=true",
                "tunnel_forward=true",
                "video_codec=h264",
                "max_size=1080",
                "video_bit_rate=12000000",
                "max_fps=60",
                "clipboard_autosync=false",
                "cleanup=true",
                "power_on=false",
                "stay_awake=false",
                "show_touches=false",
            ]
        );
        let control_only = ServerProfile {
            video: false,
            ..profile
        };
        let args = server_args("2.4", &control_only);
        assert!(args.contains(&"video=false".to_string()));
        assert!(!args.iter().any(|arg| arg.starts_with("max_size=")));
    }

    #[test]
    fn the_longer_edge_fits_the_viewers_box_and_never_upscales() {
        let display = ScreenSize {
            width: 1080.0,
            height: 2400.0,
        };
        assert_eq!(max_size(display, 540.0, 1200.0), 1200);
        let phone = ScreenSize {
            width: 402.0,
            height: 874.0,
        };
        assert_eq!(max_size(phone, 4000.0, 4000.0), 0);
        assert_eq!(max_size(display, 100.0, 100.0), 96);
        // An encoder's refused edge: the longer side stops at 2160 even in a window that fits it.
        let tall = ScreenSize {
            width: 1080.0,
            height: 4000.0,
        };
        assert_eq!(max_size(tall, 1080.0, 4000.0), 2160);
    }
}

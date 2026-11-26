// SPDX-License-Identifier: Apache-2.0
//! `one-off-screenshot.ts`: one still of a device screen, fitted to a frame packet through
//! ace-media. A cut-short picture is refused, never shown to an agent with grey in it. The
//! image job, the temporary file and the SDK commands are the shell's; this decides the bounds,
//! the fit, the scale, the frame header and the guest file name.

use ace_json::JsString;
use serde::Serialize;

use crate::platform::{Code, Error, Failure};

/// The frame packet bounds (ScreenLegacyFrameHeader): a portrait phone is fitted to 2160 high.
pub const MAX_WIDTH: u32 = 1920;
pub const MAX_HEIGHT: u32 = 2160;
/// The most a device's own screenshot may be before ace-media sees it.
pub const MAX_SOURCE_BYTES: usize = 32 * 1024 * 1024;
/// The largest device screens are a few megapixels (a 13-inch iPad is 5.7).
pub const MAX_PIXELS: u64 = 16 * 1024 * 1024;
pub const QUALITY: u8 = 80;

/// One still of a device screen, JPEG, sized to fit a frame packet.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DeviceShot {
    pub payload: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// Image pixels per device input point, as live frames report it.
    pub scale: f64,
}

/// The ace-media fit a screenshot asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct FitOp {
    pub max_pixels: u64,
    pub width: u32,
    pub height: u32,
    pub auto_orient: bool,
    pub quality: u8,
}

pub fn fit_op() -> FitOp {
    FitOp {
        max_pixels: MAX_PIXELS,
        width: MAX_WIDTH,
        height: MAX_HEIGHT,
        auto_orient: false,
        quality: QUALITY,
    }
}

/// Refuses a source ace-media should not be asked to read.
pub fn check_source(len: usize) -> Result<(), Error> {
    if len == 0 || len > MAX_SOURCE_BYTES {
        return Err(failed(
            Code::InvalidData,
            "Device screenshot is empty or too large",
            "Retry; if it persists, restart the device.",
        ));
    }
    Ok(())
}

/// Image pixels per device input point: the fitted width over the stored width.
pub fn scale(encoded_width: u32, source_width: u32) -> f64 {
    if source_width == 0 {
        return 0.0;
    }
    f64::from(encoded_width) / f64::from(source_width)
}

/// A frame header for a one-off still, so screenshot callers treat it like a live frame.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FrameHeader {
    pub version: u8,
    #[serde(rename = "sessionId")]
    pub session_id: JsString,
    pub sequence: u64,
    pub timestamp: f64,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub codec: &'static str,
    pub keyframe: bool,
    pub bytes: usize,
}

pub fn one_off_header(shot: &DeviceShot, now_ms: f64, runtime_id: &str) -> FrameHeader {
    FrameHeader {
        version: 1,
        session_id: session_id(runtime_id),
        sequence: 0,
        timestamp: now_ms,
        width: shot.width,
        height: shot.height,
        scale: shot.scale,
        codec: "jpeg",
        keyframe: true,
        bytes: shot.payload.len(),
    }
}

/// `shot-<id>` with every character outside `[a-zA-Z0-9_-]` replaced, cut to 64 UTF-16 units
/// exactly as `.slice(0, 64)` cuts it.
pub fn session_id(runtime_id: &str) -> JsString {
    let mut text = String::with_capacity(runtime_id.len() + 5);
    text.push_str("shot-");
    for character in runtime_id.chars() {
        let keep = character.is_ascii_alphanumeric() || character == '_' || character == '-';
        text.push(if keep { character } else { '-' });
    }
    JsString::from(text).slice_units(0, 64)
}

/// The device's uniquely named guest file a screenshot is captured into.
pub fn guest_name(uuid: &str) -> String {
    format!("/data/local/tmp/ace-shot-{uuid}.png")
}

/// The three commands that capture, pull and remove one emulator screenshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenshotPlan {
    /// `adb shell <screencap>`; the shell quotes each argument.
    pub screencap: Vec<String>,
    pub pull: Vec<String>,
    pub remove: Vec<String>,
    pub screencap_max_bytes: u64,
    pub pull_max_bytes: u64,
    pub remove_max_bytes: u64,
}

pub fn emulator_screenshot(guest: &str, path: &str) -> ScreenshotPlan {
    ScreenshotPlan {
        screencap: vec![
            "shell".to_string(),
            "screencap".to_string(),
            "-p".to_string(),
            guest.to_string(),
        ],
        pull: vec!["pull".to_string(), guest.to_string(), path.to_string()],
        remove: vec![
            "shell".to_string(),
            "rm".to_string(),
            "-f".to_string(),
            guest.to_string(),
        ],
        screencap_max_bytes: 8192,
        pull_max_bytes: 8192,
        remove_max_bytes: 4096,
    }
}

fn failed(code: Code, message: &str, hint: &str) -> Error {
    Error::Failed(Failure {
        code,
        message: message.to_string(),
        hint: hint.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shot(width: u32, height: u32, source_width: u32) -> DeviceShot {
        DeviceShot {
            payload: vec![0xff, 0xd8, 0xff, 0xd9],
            width,
            height,
            scale: scale(width, source_width),
        }
    }

    #[test]
    fn an_empty_or_oversized_screenshot_is_refused_before_ace_media_sees_it() {
        assert!(check_source(0).is_err());
        assert!(check_source(MAX_SOURCE_BYTES).is_ok());
        match check_source(MAX_SOURCE_BYTES + 1) {
            Err(Error::Failed(failure)) => {
                assert_eq!(failure.code, Code::InvalidData);
                assert_eq!(failure.message, "Device screenshot is empty or too large");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn the_fit_is_a_1920_by_2160_jpeg_at_quality_80_without_auto_orientation() {
        assert_eq!(
            fit_op(),
            FitOp {
                max_pixels: 16 * 1024 * 1024,
                width: 1920,
                height: 2160,
                auto_orient: false,
                quality: 80
            }
        );
    }

    #[test]
    fn a_fitted_screenshot_reports_its_scale_against_the_stored_width() {
        assert_eq!(shot(972, 2160, 1080).scale, 0.9);
        assert_eq!(scale(1, 0), 0.0);
    }

    #[test]
    fn a_one_off_header_is_single_frame_jpeg_cut_to_64_units() {
        let header = one_off_header(&shot(972, 2160, 1080), 1_234.5, "abc-123");
        assert_eq!(header.version, 1);
        assert_eq!(header.session_id.as_str(), "shot-abc-123");
        assert_eq!((header.sequence, header.timestamp), (0, 1_234.5));
        assert_eq!((header.width, header.height), (972, 2160));
        assert_eq!(header.codec, "jpeg");
        assert!(header.keyframe);
        assert_eq!(header.bytes, 4);
        // The cut is 64 UTF-16 units; the sanitize step has already made every unit ASCII (an
        // emoji becomes two dashes), so no cut can split one here.
        let cut = session_id(&"a".repeat(80));
        assert_eq!(cut.len_utf16(), 64);
        assert!(cut.is_well_formed());
        assert_eq!(session_id("\u{1f600}").as_str(), "shot--");
        // Characters outside the frame's alphabet become dashes.
        assert_eq!(session_id("a b/c").as_str(), "shot-a-b-c");
    }

    #[test]
    fn the_emulator_screenshot_names_a_guest_file_and_its_three_commands() {
        assert_eq!(guest_name("1234"), "/data/local/tmp/ace-shot-1234.png");
        let plan = emulator_screenshot("/data/local/tmp/ace-shot-1234.png", "/tmp/screen.png");
        assert_eq!(
            plan.screencap,
            vec![
                "shell".to_string(),
                "screencap".to_string(),
                "-p".to_string(),
                "/data/local/tmp/ace-shot-1234.png".to_string()
            ]
        );
        assert_eq!(
            plan.pull,
            vec![
                "pull".to_string(),
                "/data/local/tmp/ace-shot-1234.png".to_string(),
                "/tmp/screen.png".to_string()
            ]
        );
        assert_eq!(
            plan.remove,
            vec![
                "shell".to_string(),
                "rm".to_string(),
                "-f".to_string(),
                "/data/local/tmp/ace-shot-1234.png".to_string()
            ]
        );
        assert_eq!(
            (
                plan.screencap_max_bytes,
                plan.pull_max_bytes,
                plan.remove_max_bytes
            ),
            (8192, 8192, 4096)
        );
    }
}

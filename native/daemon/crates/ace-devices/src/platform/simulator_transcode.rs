// SPDX-License-Identifier: Apache-2.0
//! `simulator-transcode.ts`: when ace-media re-encodes a Simulator's picture for a viewer
//! (E3b, in `media-vt`), and at what size. Pure: no encoder, no clock, no sockets.

/// The least serve-sim sends while the screen is busy (its documented default is 6 to 30 Mbit/s
/// by screen size). Until a busier rate has been measured, a viewer is judged against this.
pub const SIMULATOR_SOURCE_FLOOR: f64 = 6_000_000.0;
/// Below this share of the source's rate a viewer can't carry it: ace-media re-encodes for it.
const TRANSCODE_BELOW: f64 = 5.0 / 6.0;
/// And at or above this share, serve-sim's own stream passes through again (hysteresis).
const PASS_THROUGH_FROM: f64 = 5.5 / 6.0;

/// A width and height, in pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

/// The largest picture a viewer's panel takes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Box {
    pub max_width: f64,
    pub max_height: f64,
}

/// Everything a transcode decision reads.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TranscodeInput {
    pub transcoding: bool,
    pub bitrate: f64,
    pub box_: Box,
    pub native: Option<Size>,
    /// serve-sim's busiest recent rate in bit/s, as measured; the floor when unknown.
    pub source: Option<f64>,
}

/// Whether a Simulator live view needs its picture re-encoded: its link can't carry serve-sim's
/// stream, or its panel is smaller than the Simulator's native picture. `transcoding` is the
/// current state, so the rate has some room before it flips back.
pub fn needs_transcode(input: &TranscodeInput) -> bool {
    let larger = input.native.is_some_and(|native| {
        native.width > input.box_.max_width || native.height > input.box_.max_height
    });
    if larger {
        return true;
    }
    let source = SIMULATOR_SOURCE_FLOOR.max(input.source.unwrap_or(0.0));
    let share = if input.transcoding {
        PASS_THROUGH_FROM
    } else {
        TRANSCODE_BELOW
    };
    input.bitrate < source * share
}

/// The settings an encode is planned from.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EncodeSettings {
    pub max_width: f64,
    pub max_height: f64,
    pub bitrate: f64,
}

/// The encode ace-media re-encodes a Simulator at for a viewer (E3b, the `--transcode`
/// replacement): serve-sim's native picture fitted inside the viewer's box at its aspect, never
/// larger than native, even sides, at the viewer's bit rate.
#[derive(Debug, Clone, PartialEq)]
pub struct EncodeSpec {
    pub id: u32,
    pub codec: &'static str,
    pub width: f64,
    pub height: f64,
    pub fps: u32,
    pub bitrate: f64,
}

pub fn encode_spec(native: Size, settings: EncodeSettings) -> EncodeSpec {
    let fit = 1.0_f64
        .min(settings.max_width / native.width)
        .min(settings.max_height / native.height);
    EncodeSpec {
        id: 1,
        codec: "avc1.640033",
        width: even(native.width * fit),
        height: even(native.height * fit),
        fps: 60,
        bitrate: settings.bitrate,
    }
}

/// The largest even size at or below `value`, as every hardware encoder takes.
fn even(value: f64) -> f64 {
    2.0_f64.max((value / 2.0).floor() * 2.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn native() -> Size {
        Size {
            width: 1206.0,
            height: 2622.0,
        }
    }

    #[test]
    fn ace_media_re_encodes_inside_the_viewers_box_at_its_aspect_with_even_sides() {
        let spec = encode_spec(
            native(),
            EncodeSettings {
                max_width: 800.0,
                max_height: 1280.0,
                bitrate: 3_000_000.0,
            },
        );
        assert_eq!(
            spec,
            EncodeSpec {
                id: 1,
                codec: "avc1.640033",
                width: 588.0,
                height: 1280.0,
                fps: 60,
                bitrate: 3_000_000.0
            }
        );
        let large = encode_spec(
            native(),
            EncodeSettings {
                max_width: 4000.0,
                max_height: 4000.0,
                bitrate: 1.0,
            },
        );
        assert_eq!(
            (large.width, large.height),
            (1206.0, 2622.0),
            "never above native"
        );
        let narrow = encode_spec(
            native(),
            EncodeSettings {
                max_width: 301.0,
                max_height: 4000.0,
                bitrate: 1.0,
            },
        );
        assert_eq!((narrow.width, narrow.height), (300.0, 654.0));
    }

    #[test]
    fn a_smaller_panel_always_needs_a_re_encode() {
        let input = TranscodeInput {
            transcoding: false,
            bitrate: 30_000_000.0,
            box_: Box {
                max_width: 800.0,
                max_height: 1280.0,
            },
            native: Some(native()),
            source: None,
        };
        assert!(needs_transcode(&input));
    }

    #[test]
    fn a_link_below_the_measured_source_re_encodes_and_a_transcoding_link_needs_more_room() {
        let base = TranscodeInput {
            transcoding: false,
            bitrate: 4_000_000.0,
            box_: Box {
                max_width: 4000.0,
                max_height: 4000.0,
            },
            native: None,
            source: None,
        };
        // The floor is 6 Mbit/s: below 5/6 of it re-encodes.
        assert!(needs_transcode(&base));
        let comfortable = TranscodeInput {
            bitrate: 6_000_000.0,
            ..base
        };
        assert!(!needs_transcode(&comfortable));
        // Already transcoding: pass-through resumes only at 5.5/6 of the source.
        let low = TranscodeInput {
            transcoding: true,
            bitrate: 5_400_000.0,
            ..base
        };
        assert!(needs_transcode(&low));
        let enough = TranscodeInput {
            transcoding: true,
            bitrate: 5_600_000.0,
            ..base
        };
        assert!(!needs_transcode(&enough));
        // A measured source above the floor is the rate judged against.
        let measured = TranscodeInput {
            bitrate: 9_000_000.0,
            source: Some(12_000_000.0),
            ..base
        };
        assert!(needs_transcode(&measured));
        assert!(!needs_transcode(&TranscodeInput {
            bitrate: 11_000_000.0,
            ..measured
        }));
    }

    #[test]
    fn a_viewer_with_no_panel_and_a_link_above_the_floor_passes_the_stream_through() {
        let input = TranscodeInput {
            transcoding: false,
            bitrate: 30_000_000.0,
            box_: Box {
                max_width: 4000.0,
                max_height: 4000.0,
            },
            native: None,
            source: None,
        };
        assert!(!needs_transcode(&input));
        let zero = TranscodeInput {
            bitrate: 0.0,
            ..input
        };
        assert!(needs_transcode(&zero));
    }
}

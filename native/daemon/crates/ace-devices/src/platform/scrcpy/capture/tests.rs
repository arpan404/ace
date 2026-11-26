// SPDX-License-Identifier: Apache-2.0
//! The moved `scrcpy-restart.test.ts` cases, the profile and display decisions, the forwarded
//! frame's fields and the capture's own error codes, beside the code they name.

use super::*;

fn profile() -> ServerProfile {
    ServerProfile {
        scid: 1,
        max_size: 1920.0,
        bitrate: 8_000_000.0,
        fps: 60.0,
        video: true,
    }
}

#[test]
fn a_new_size_or_frame_rate_restarts_the_scrcpy_server_at_once() {
    assert!(restart_worth_it(
        &profile(),
        &ServerProfile {
            max_size: 1440.0,
            ..profile()
        },
        0.0
    ));
    assert!(restart_worth_it(
        &profile(),
        &ServerProfile {
            fps: 30.0,
            ..profile()
        },
        0.0
    ));
}

#[test]
fn a_wavering_link_never_keeps_the_view_restarting() {
    assert!(!restart_worth_it(&profile(), &profile(), 60_000.0));
    assert!(!restart_worth_it(
        &profile(),
        &ServerProfile {
            bitrate: 6_500_000.0,
            ..profile()
        },
        60_000.0
    ));
    assert!(!restart_worth_it(
        &profile(),
        &ServerProfile {
            bitrate: 4_000_000.0,
            ..profile()
        },
        5_000.0
    ));
    assert!(restart_worth_it(
        &profile(),
        &ServerProfile {
            bitrate: 4_000_000.0,
            ..profile()
        },
        10_000.0
    ));
    assert!(restart_worth_it(
        &profile(),
        &ServerProfile {
            bitrate: 12_000_000.0,
            ..profile()
        },
        10_000.0
    ));
}

#[test]
fn a_run_is_sized_by_the_transport_and_the_streams_settings() {
    let settings = CaptureSettings {
        max_width: 1920.0,
        max_height: 1080.0,
        fps: 60.0,
        bitrate: 8_000_000.0,
    };
    let wanted = profile_for(
        settings,
        ScreenSize {
            width: 1080.0,
            height: 2400.0,
        },
        7,
    );
    assert_eq!(wanted.scid, 7);
    assert!(wanted.max_size > 0.0, "a tall display is fitted");
    assert_eq!((wanted.fps, wanted.bitrate), (60.0, 8_000_000.0));
    assert!(wanted.video);
    assert!(media_video(&wanted, true));
    assert!(!media_video(&wanted, false));
    assert!(!media_video(
        &ServerProfile {
            video: false,
            ..wanted
        },
        true
    ));
}

#[test]
fn a_frame_shows_the_display_in_its_own_orientation() {
    let portrait = display_for(2400.0, 1080.0, 1080.0, 2400.0);
    assert_eq!((portrait.width, portrait.height), (1080.0, 2400.0));
    let landscape = display_for(2400.0, 1080.0, 2400.0, 1080.0);
    assert_eq!((landscape.width, landscape.height), (2400.0, 1080.0));
}

#[test]
fn a_forwarded_frame_keeps_the_pictures_size_the_displays_and_the_producer_stamp() {
    let unit = VideoUnit {
        payload: vec![0, 0, 0, 1, 0x65, 9],
        keyframe: true,
        video_codec: "avc1.640033".to_string(),
        width: 1080,
        height: 2400,
        pts: 1_234_567,
        encode: None,
    };
    let forwarded = frame(
        &unit,
        ScreenSize {
            width: 1080.0,
            height: 2400.0,
        },
        42,
    );
    assert_eq!(forwarded.kind, 1);
    assert_eq!(forwarded.flags, 1);
    assert_eq!(
        (
            forwarded.width,
            forwarded.height,
            forwarded.display_width,
            forwarded.display_height
        ),
        (1080, 2400, 1080, 2400)
    );
    assert_eq!(forwarded.scale, 1000);
    assert_eq!(forwarded.codec_string, "avc1.640033");
    assert_eq!(forwarded.payload, unit.payload);
    // The stamp: tag 1, length 24, sequence 42, capture time in ms, scale 1.
    assert_eq!(&forwarded.extension[..4], &[0, 1, 0, 24]);
    assert_eq!(
        u64::from_be_bytes(forwarded.extension[4..12].try_into().expect("bytes")),
        42
    );
    assert_eq!(
        f64::from_be_bytes(forwarded.extension[12..20].try_into().expect("bytes")),
        1234.567
    );
    assert_eq!(
        f64::from_be_bytes(forwarded.extension[20..28].try_into().expect("bytes")),
        1.0
    );
    let delta = frame(
        &VideoUnit {
            keyframe: false,
            ..unit
        },
        ScreenSize {
            width: 1080.0,
            height: 2400.0,
        },
        43,
    );
    assert_eq!(delta.flags, 0);
    assert_eq!(delta.codec_string, "", "a delta names no codec of its own");
}

#[test]
fn the_captures_errors_keep_their_codes_and_next_steps() {
    let cases = [
        (
            unavailable(true),
            Code::CommandFailed,
            "The Android screen stream ended",
        ),
        (
            unavailable(false),
            Code::Busy,
            "Android control is reconnecting",
        ),
        (
            input_backlog(),
            Code::Busy,
            "Android input backlog exceeded limit",
        ),
        (
            screen_ended(),
            Code::CommandFailed,
            "The Android screen stream ended",
        ),
        (
            server_stopped(),
            Code::CommandFailed,
            "scrcpy-server stopped on the device",
        ),
        (control_restarted(), Code::Busy, "Android control restarted"),
        (
            screen_not_started(),
            Code::Busy,
            "The Android screen has not started yet",
        ),
        (capture_stopped(), Code::Busy, "Device capture has stopped"),
        (
            media_needed(),
            Code::CommandFailed,
            "The Android live view needs ace-media",
        ),
    ];
    for (error, code, message) in cases {
        match error {
            Error::Failed(failure) => {
                assert_eq!(failure.code, code);
                assert_eq!(failure.message, message);
                assert!(!failure.hint.is_empty());
            }
            other => panic!("unexpected error: {other}"),
        }
    }
}

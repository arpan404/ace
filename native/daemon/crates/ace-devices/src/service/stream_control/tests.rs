// SPDX-License-Identifier: Apache-2.0
//! The device's stream rules (`stream-control.ts`): what an unwatched capture
//! streams, the JPEG refusal a live view gets, and the codec a capture must reach.
//!
//! The owners' arbitration is `@ace/screen`'s `StreamOwners` (screen S-items);
//! these cases cover the device's own rules around it.

use super::{
    Codec, DEVICE_IMAGE_STREAM, DEVICE_RECORDING_STREAM, DEVICE_STILL_STREAM, DEVICE_VIDEO_STREAM,
    StreamSettings, check_applied, common_device_stream, common_stream, idle_stream,
    live_view_request, same_stream,
};
use crate::error::DeviceErrorCode;
use crate::service::words;

fn jpeg() -> StreamSettings {
    StreamSettings {
        codec: Codec::Jpeg,
        max_width: 1920,
        max_height: 2160,
        fps: 30,
        bitrate: 4_000_000,
    }
}

fn h264() -> StreamSettings {
    StreamSettings {
        codec: Codec::H264,
        ..jpeg()
    }
}

#[test]
fn the_four_device_streams_keep_their_numbers() {
    assert_eq!(DEVICE_IMAGE_STREAM.codec, Codec::Jpeg);
    assert_eq!(
        (
            DEVICE_IMAGE_STREAM.max_width,
            DEVICE_IMAGE_STREAM.max_height
        ),
        (1920, 2160)
    );
    assert_eq!(DEVICE_IMAGE_STREAM.fps, 30);
    assert_eq!(DEVICE_IMAGE_STREAM.bitrate, 4_000_000);

    // A still on demand streams nothing between asks.
    assert_eq!(DEVICE_STILL_STREAM.fps, 2);
    assert_eq!(DEVICE_STILL_STREAM.codec, Codec::Jpeg);

    // A recording nobody watches is H.264.
    assert_eq!(DEVICE_RECORDING_STREAM.codec, Codec::H264);
    assert_eq!(
        (
            DEVICE_RECORDING_STREAM.max_width,
            DEVICE_RECORDING_STREAM.max_height
        ),
        (1280, 2560)
    );

    // A live view that has not sized itself yet: 60 fps in a phone-sized box.
    assert_eq!(DEVICE_VIDEO_STREAM.fps, 60);
    assert_eq!(
        (
            DEVICE_VIDEO_STREAM.max_width,
            DEVICE_VIDEO_STREAM.max_height
        ),
        (1440, 2880)
    );
    assert_eq!(DEVICE_VIDEO_STREAM.bitrate, 8_000_000);
}

#[test]
fn a_live_view_that_asks_for_jpeg_is_refused() {
    let refused = live_view_request(jpeg()).expect_err("JPEG is out of date");
    assert_eq!(refused.code(), DeviceErrorCode::NotSupported);
    assert_eq!(refused, words::refusal("liveViewH264Only"));
    // H.264 passes through untouched.
    assert_eq!(live_view_request(h264()).expect("h264"), h264());
}

#[test]
fn an_idle_capture_streams_a_recording_while_one_runs() {
    assert_eq!(idle_stream(false, DEVICE_IMAGE_STREAM), DEVICE_IMAGE_STREAM);
    assert_eq!(
        idle_stream(true, DEVICE_IMAGE_STREAM),
        DEVICE_RECORDING_STREAM
    );
    assert_eq!(idle_stream(false, DEVICE_STILL_STREAM), DEVICE_STILL_STREAM);
}

#[test]
fn a_still_capable_capture_returns_to_two_fps_after_recording_ends() {
    assert_eq!(idle_stream(false, DEVICE_STILL_STREAM), DEVICE_STILL_STREAM);
    assert_eq!(
        idle_stream(true, DEVICE_STILL_STREAM),
        DEVICE_RECORDING_STREAM
    );
    assert_eq!(idle_stream(false, DEVICE_STILL_STREAM), DEVICE_STILL_STREAM);
}

#[test]
fn a_capture_that_cannot_reach_h264_refuses_the_live_view() {
    check_applied(Codec::H264, Codec::H264).expect("H.264");
    // A JPEG capture serving a live view is refused, never downgraded.
    let refused = check_applied(Codec::H264, Codec::Jpeg).expect_err("cannot stream video");
    assert_eq!(refused, words::refusal("captureNoVideo"));
    // An unwatched capture may stay JPEG.
    check_applied(Codec::Jpeg, Codec::Jpeg).expect("a still capture");
}

#[test]
fn the_slowest_viewer_sets_the_shared_capture() {
    let big = StreamSettings {
        max_width: 1440,
        max_height: 2880,
        fps: 60,
        bitrate: 12_000_000,
        ..h264()
    };
    let small = StreamSettings {
        max_width: 390,
        max_height: 844,
        fps: 30,
        bitrate: 5_000_000,
        ..h264()
    };
    let common = common_stream(&[big, small]).expect("two viewers");
    assert_eq!(common.codec, Codec::H264);
    assert_eq!((common.max_width, common.max_height), (390, 844));
    assert_eq!(common.fps, 30);
    assert_eq!(common.bitrate, 5_000_000);
    // Every viewer decodes H.264 whatever it asked for.
    assert_eq!(
        common_stream(&[jpeg(), h264()]).map(|s| s.codec),
        Some(Codec::H264)
    );

    // Nobody watching: the unwatched capture's own stream.
    assert_eq!(common_stream(&[]), None);
    assert_eq!(common_device_stream(&[]), DEVICE_IMAGE_STREAM);
    assert_eq!(
        common_device_stream(&[small]),
        common_stream(&[small]).expect("one")
    );

    // `sameStream` is the five settings.
    assert!(same_stream(h264(), h264()));
    assert!(!same_stream(h264(), jpeg()));
    assert!(!same_stream(h264(), StreamSettings { fps: 59, ..h264() }));
    assert!(!same_stream(
        h264(),
        StreamSettings {
            max_width: 800,
            ..h264()
        }
    ));
    assert!(!same_stream(
        h264(),
        StreamSettings {
            max_height: 600,
            ..h264()
        }
    ));
    assert!(!same_stream(
        h264(),
        StreamSettings {
            bitrate: 1,
            ..h264()
        }
    ));
}

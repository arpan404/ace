// SPDX-License-Identifier: Apache-2.0
//! The device's stream rules (`stream-control.ts`): what an unwatched capture
//! streams, the JPEG refusal a live view gets, and the codec a capture must reach.
//!
//! The owners' arbitration is `@ace/screen`'s `StreamOwners` (screen S-items);
//! these cases cover the device's own rules around it.

use super::{
    Codec, DEVICE_IMAGE_STREAM, DEVICE_RECORDING_STREAM, DEVICE_STILL_STREAM, DEVICE_VIDEO_STREAM,
    StreamSettings, check_applied, idle_stream, live_view_request,
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
    assert_eq!(idle_stream(false), DEVICE_IMAGE_STREAM);
    assert_eq!(idle_stream(true), DEVICE_RECORDING_STREAM);
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

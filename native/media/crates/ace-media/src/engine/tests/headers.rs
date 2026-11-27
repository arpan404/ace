// SPDX-License-Identifier: Apache-2.0
//! Header geometry: a browser page's CSS size beside the coded pixels, and a device
//! frame's scale back to its source points.
use super::*;
use media_core::envelope::Assembler;
use media_core::headers::decode_picture;

/// A browser view's delivered video header: the page size it maps clicks in, beside the
/// encoded pixels. None when no browser video reached the view, or the client would reject it.
fn browser_video_header(effects: &[Effect]) -> Option<(u32, u32, u16, u16)> {
    let mut assembler = Assembler::new();
    binaries(effects).iter().find_map(|p| {
        let envelope = assembler.push(p).ok().flatten()?;
        if envelope.kind != 2 {
            return None;
        }
        media_core::headers::decode_video(envelope.meta, envelope.payload)
            .ok()
            .map(|v| (v.width, v.height, v.coded_width, v.coded_height))
    })
}

/// A browser keyframe of `coded` encoded pixels with `display` display pixels.
fn browser_key(n: u8, coded: (u16, u16), display: (u16, u16)) -> MediaFrame {
    let mut key = h264(true, n, 1, Vec::new());
    key.width = coded.0;
    key.height = coded.1;
    key.display_width = display.0;
    key.display_height = display.1;
    key
}

#[test]
fn a_browser_view_header_gives_the_page_css_size_beside_the_coded_size() {
    let mut engine = watched(json!({ "kind": "browser", "threadId": "t1" }));
    // The daemon said the page is 640x400 CSS px at scale 2; the encoder sends 1280x800.
    send(
        &mut engine,
        json!({ "type": "source.page", "source": "s1", "width": 640, "height": 400, "scale": 2 }),
        &[],
        NOW,
    );
    let effects = ingest(
        &mut engine,
        1,
        browser_key(0, (1280, 800), (1280, 800)),
        NOW,
    );
    let Some((width, height, coded_width, coded_height)) = browser_video_header(&effects) else {
        panic!("no browser video reached the view");
    };
    assert_eq!((width, height), (640, 400));
    assert_eq!((coded_width, coded_height), (1280, 800));
}

#[test]
fn a_browser_view_header_scales_an_oversized_page_to_fit_what_the_client_takes() {
    let mut engine = watched(json!({ "kind": "browser", "threadId": "t1" }));
    // At 25% zoom the desktop reports 5120x3200; the client rejects sides outside 100..=4096,
    // so both scale together to fit, keeping the aspect.
    send(
        &mut engine,
        json!({ "type": "source.page", "source": "s1", "width": 5120, "height": 3200, "scale": 1 }),
        &[],
        NOW,
    );
    let effects = ingest(
        &mut engine,
        1,
        browser_key(0, (1280, 800), (1280, 800)),
        NOW,
    );
    let Some((width, height, coded_width, coded_height)) = browser_video_header(&effects) else {
        panic!("no browser video reached the view");
    };
    assert_eq!((width, height), (4096, 2560));
    assert_eq!((coded_width, coded_height), (1280, 800));
}

#[test]
fn a_browser_view_header_scales_a_tiny_page_up_to_what_the_client_takes() {
    let mut engine = watched(json!({ "kind": "browser", "threadId": "t1" }));
    // A 40x30 page scales up together until the smaller side clears 100, keeping the 4:3
    // aspect as far as rounding allows.
    send(
        &mut engine,
        json!({ "type": "source.page", "source": "s1", "width": 40, "height": 30, "scale": 1 }),
        &[],
        NOW,
    );
    let effects = ingest(
        &mut engine,
        1,
        browser_key(0, (1280, 800), (1280, 800)),
        NOW,
    );
    let Some((width, height, coded_width, coded_height)) = browser_video_header(&effects) else {
        panic!("no browser video reached the view");
    };
    assert_eq!((width, height), (133, 100));
    assert_eq!((coded_width, coded_height), (1280, 800));
}

#[test]
fn a_browser_view_header_keeps_the_display_size_until_the_daemon_announces_the_page() {
    let mut engine = watched(json!({ "kind": "browser", "threadId": "t1" }));
    // No source.page yet: the first unit's display size seeds planning, but the header keeps
    // the display size of the unit it carries, even after the encoder's size changed.
    let first = ingest(
        &mut engine,
        1,
        browser_key(0, (1280, 800), (1280, 800)),
        NOW,
    );
    assert_eq!(browser_video_header(&first), Some((1280, 800, 1280, 800)));
    let second = ingest(&mut engine, 1, browser_key(1, (640, 400), (640, 400)), NOW);
    assert_eq!(browser_video_header(&second), Some((640, 400, 640, 400)));
    // The daemon announces the CSS page: the header uses it beside the coded size.
    send(
        &mut engine,
        json!({ "type": "source.page", "source": "s1", "width": 320, "height": 200, "scale": 1 }),
        &[],
        NOW,
    );
    let third = ingest(&mut engine, 1, browser_key(2, (640, 400), (640, 400)), NOW);
    assert_eq!(browser_video_header(&third), Some((320, 200, 640, 400)));
}

#[test]
fn a_browser_view_header_uses_an_announced_page_matching_the_seeded_size() {
    let mut engine = watched(json!({ "kind": "browser", "threadId": "t1" }));
    // The first unit's display size seeds planning at scale 1; the daemon then announces the
    // same size, so nothing replans.
    let mut seeded = browser_key(0, (1280, 800), (1280, 800));
    seeded.scale = 1000;
    let first = ingest(&mut engine, 1, seeded, NOW);
    assert_eq!(browser_video_header(&first), Some((1280, 800, 1280, 800)));
    send(
        &mut engine,
        json!({ "type": "source.page", "source": "s1", "width": 1280, "height": 800, "scale": 1 }),
        &[],
        NOW,
    );
    // The announced page sizes the header even though nothing replanned: the coded size stays
    // the encoded pixels.
    let second = ingest(&mut engine, 1, browser_key(1, (640, 400), (640, 400)), NOW);
    assert_eq!(browser_video_header(&second), Some((1280, 800, 640, 400)));
}

#[test]
fn a_browser_view_header_follows_the_announced_page_closest_to_each_frames_shape() {
    let mut engine = watched(json!({ "kind": "browser", "threadId": "t1" }));
    // A resize from landscape to portrait: frames of both shapes are in flight, and each
    // keeps the geometry it was captured in.
    send(
        &mut engine,
        json!({ "type": "source.page", "source": "s1", "width": 1280, "height": 800, "scale": 1 }),
        &[],
        NOW,
    );
    send(
        &mut engine,
        json!({ "type": "source.page", "source": "s1", "width": 800, "height": 1280, "scale": 1 }),
        &[],
        NOW,
    );
    let landscape = ingest(
        &mut engine,
        1,
        browser_key(0, (1280, 800), (1280, 800)),
        NOW,
    );
    assert_eq!(
        browser_video_header(&landscape),
        Some((1280, 800, 1280, 800))
    );
    let portrait = ingest(
        &mut engine,
        1,
        browser_key(1, (800, 1280), (800, 1280)),
        NOW,
    );
    assert_eq!(
        browser_video_header(&portrait),
        Some((800, 1280, 800, 1280))
    );
}

fn device_unit(
    width: u16,
    height: u16,
    display_width: u16,
    display_height: u16,
    scale: u16,
) -> MediaFrame {
    let mut unit = h264(true, 9, 1, Vec::new());
    unit.width = width;
    unit.height = height;
    unit.display_width = display_width;
    unit.display_height = display_height;
    unit.scale = scale;
    unit
}

fn device_header(unit: MediaFrame) -> (u16, u16, f64) {
    let mut engine = watched(json!({ "kind": "device", "deviceId": "android:emulator-5554" }));
    let effects = ingest(&mut engine, 1, unit, NOW);
    let pieces = binaries(&effects);
    let mut assembler = Assembler::new();
    let Some((kind, meta, payload)) = pieces.iter().find_map(|p| {
        assembler
            .push(p)
            .ok()
            .flatten()
            .map(|e| (e.kind, e.meta.to_vec(), e.payload.to_vec()))
    }) else {
        panic!("no picture reached the device view");
    };
    assert_eq!(kind, 4);
    let Ok(picture) = decode_picture(4, &meta, &payload) else {
        panic!("a header the client can't read");
    };
    (picture.width, picture.height, picture.scale)
}

#[test]
fn a_transcoded_device_frame_keeps_its_source_width_in_its_header_scale() {
    // A Simulator re-encoded at 824x1792 from a 1206x2622 source at scale 1: the client divides
    // the encoded width by the header scale to get back the 1206 source points it sends input in.
    let (width, height, scale) = device_header(device_unit(824, 1792, 1206, 2622, 1000));
    assert_eq!((width, height), (824, 1792));
    assert!(
        (f64::from(width) / scale - 1206.0).abs() < 1.0,
        "width/scale is the source width, got {width} / {scale}",
    );
    assert!(
        (scale - 824.0 / 1206.0).abs() < 0.002,
        "scale is encoded px per source point, got {scale}",
    );
}

#[test]
fn a_native_size_device_frame_keeps_scale_1() {
    let (width, height, scale) = device_header(device_unit(1206, 2622, 1206, 2622, 1000));
    assert_eq!((width, height), (1206, 2622));
    assert!(
        (scale - 1.0).abs() < 0.0005,
        "a native-size frame keeps its scale, got {scale}",
    );
}

#[test]
fn a_downscaled_mac_frame_reports_points_in_its_header_scale() {
    // 1440x900 encoded from a 2880x1800 source at scale 2: the header scale is 1, so
    // width/scale is the 1440 points input uses.
    let (width, height, scale) = device_header(device_unit(1440, 900, 2880, 1800, 2000));
    assert_eq!((width, height), (1440, 900));
    assert!(
        (scale - 1.0).abs() < 0.002,
        "scale is encoded px per point, got {scale}",
    );
    assert!(
        (f64::from(width) / scale - 1440.0).abs() < 1.0,
        "width/scale is points"
    );
}

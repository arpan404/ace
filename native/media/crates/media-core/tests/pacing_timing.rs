// SPDX-License-Identifier: Apache-2.0
use media_core::{device_control::*, keyframes::*, link_rate::*, plan::*, quantizer::*, scale::*};
#[test]
fn forced_keys_coalesce_and_wait_half_a_second_while_periodic_keys_need_no_request() {
    let mut p = EncodePacer::new(60.0);
    assert_eq!(p.frame(0.0, false), Decision::Key);
    p.request_keyframe();
    p.request_keyframe();
    assert_eq!(p.frame(100.0, false), Decision::Delta);
    assert_eq!(p.frame(499.0, false), Decision::Delta);
    assert_eq!(p.frame(500.0, false), Decision::Key);
    assert_eq!(p.frame(20_499.0, false), Decision::Delta);
    assert_eq!(p.frame(20_500.0, false), Decision::Key);
}
#[test]
fn busy_encoder_keeps_key_owed_and_a_skipped_last_frame_catches_up_once() {
    let mut p = EncodePacer::new(30.0);
    assert_eq!(p.frame(0.0, true), Decision::Skip);
    assert_eq!(p.frame(40.0, false), Decision::Key);
    assert_eq!(p.frame(50.0, false), Decision::Skip);
    assert!(!p.catch_up(52.0, false));
    assert!(!p.catch_up(70.0, true));
    assert!(p.catch_up(70.0, false));
    assert!(!p.catch_up(90.0, false));
}
#[test]
fn still_key_precedes_one_sharp_settle_per_still_spell() {
    let mut p = EncodePacer::new(60.0);
    p.frame(0.0, false);
    p.frame(20.0, false);
    p.request_keyframe();
    assert!(!p.still(500.0, 450.0, false));
    assert!(!p.settle(500.0, 20.0, true));
    assert!(p.still(500.0, 20.0, false));
    assert!(!p.settle(799.0, 20.0, true));
    assert!(!p.settle(800.0, 20.0, false));
    assert!(p.settle(800.0, 20.0, true));
    assert!(!p.settle(900.0, 20.0, true));
    p.frame(1000.0, false);
    assert!(p.settle(1300.0, 1000.0, true));
}
#[test]
fn jitter_and_pauses_keep_requested_frame_rate_without_bursts() {
    for fps in [8.0, 30.0, 60.0] {
        let mut p = EncodePacer::new(fps);
        for start in [0.0, 5000.0] {
            let count = (0..60)
                .filter(|i| {
                    let jitter = match i % 4 {
                        0 => 5.0,
                        2 => -5.0,
                        _ => 0.0,
                    };
                    p.frame(start + f64::from(*i) * 1000.0 / 60.0 + jitter, false) != Decision::Skip
                })
                .count();
            assert!((count as f64 - fps).abs() <= 1.0, "{count} at {fps}");
        }
    }
}
#[test]
fn picture_requests_have_one_deadline_and_never_burst() {
    let mut k = PictureKeyframes::default();
    assert_eq!(k.request(0.0), Some(0.0));
    assert!(k.poll(0.0));
    assert_eq!(k.request(100.0), Some(500.0));
    assert_eq!(k.request(300.0), None);
    assert!(!k.poll(499.0));
    assert!(k.poll(500.0));
    assert!(!k.poll(500.0));
}
#[test]
fn scale_sizes_first_picture_immediately_and_cancels_short_pressure_spells() {
    let mut scale = PictureScale::default();
    let small = scale.update(1000.0, 2_073_600.0, 60.0, 0.0);
    assert!((small - 0.84_f64.powi(6)).abs() < 1e-14);
    assert_eq!(scale.update(16_000_000.0, 2_073_600.0, 60.0, 100.0), small);
    scale.update(1000.0, 2_073_600.0, 60.0, 2000.0);
    assert_eq!(scale.update(16_000_000.0, 2_073_600.0, 60.0, 3100.0), small);
    assert_eq!(scale.update(16_000_000.0, 2_073_600.0, 60.0, 6100.0), 1.0);
}
#[test]
fn stale_and_reset_acks_do_not_change_link_estimate_and_drops_respect_bounds() {
    let mut r = LinkRate::new(Limits::default());
    r.sent(1, 1000, 0.0);
    r.reset();
    r.acknowledged(1, 100.0);
    assert_eq!(r.rtt(), None);
    assert_eq!(r.rate(), 1_500_000.0);
    for t in 0..30 {
        r.dropped(f64::from(t));
    }
    assert_eq!(r.rate(), 500_000.0);
    let previous = r.rate();
    r.acknowledged(100, 1000.0);
    assert_eq!(r.rate(), previous);
}
#[test]
fn quantizer_limits_retarget_and_settle_budget_follow_content() {
    let mut q = QuantizerControl::new(1_000_000.0, 60.0);
    assert_eq!(q.settled(), None);
    for _ in 0..90 {
        q.next(false);
        q.observe(1_000_000, false);
    }
    assert_eq!(q.next(false), 51.0);
    assert_eq!(q.next(true), 51.0);
    q.observe(1_000_000, true);
    assert_eq!(q.settled(), None);
    q.retarget(16_000_000.0, 60.0);
    for _ in 0..500 {
        q.next(false);
        q.observe(1, false);
    }
    assert_eq!(q.next(false), 18.0);
    assert_eq!(q.next(true), 24.0);
    q.observe(100, true);
    assert_eq!(q.settled(), Some(18.0));
    assert_eq!(q.settled(), None);
    assert!(!affords_settle_key(None, 1_000_000.0));
    assert!(affords_settle_key(Some(500_000.0), 1_000_000.0));
}
#[test]
fn common_device_budget_takes_each_minimum_and_refuses_jpeg_live_views() {
    let a = VIDEO_STREAM;
    let b = StreamSettings {
        max_width: 720,
        fps: 30,
        bitrate: 2_000_000,
        ..a
    };
    assert_eq!(common_device_stream(&[a, b]), b);
    assert_eq!(common_device_stream(&[]), IMAGE_STREAM);
    assert_eq!(live_view_request(IMAGE_STREAM), None);
    assert_eq!(live_view_request(a), Some(a));
}
#[test]
fn unsupported_and_native_viewers_are_excluded_and_smallest_link_sets_shared_rate() {
    let source = Source {
        width: 1920.0,
        height: 1080.0,
        scale: 2.0,
        codecs: &["h264"],
    };
    let viewport = || Viewport {
        width: 1000.0,
        height: 1000.0,
        device_pixel_ratio: 2.0,
        native_shown: false,
    };
    let viewers = [
        VideoViewer {
            id: "a",
            viewport: viewport(),
            codecs: &["h264"],
            link: 8_000_000.0,
            scale: 1.0,
        },
        VideoViewer {
            id: "b",
            viewport: viewport(),
            codecs: &["h264"],
            link: 700_000.0,
            scale: 1.0,
        },
        VideoViewer {
            id: "c",
            viewport: viewport(),
            codecs: &["vp9"],
            link: 1_000_000.0,
            scale: 1.0,
        },
        VideoViewer {
            id: "d",
            viewport: Viewport {
                native_shown: true,
                ..viewport()
            },
            codecs: &["h264"],
            link: 500_000.0,
            scale: 1.0,
        },
    ];
    let plan = plan_video(&source, &viewers);
    assert_eq!(plan.encodes.len(), 1);
    assert_eq!(plan.viewers.len(), 2);
    assert_eq!(plan.encodes[0].bitrate, 700_000);
    assert_eq!(
        plan.capture,
        Picture {
            width: 2000,
            height: 1126
        }
    );
}

#[test]
fn fifth_size_joins_nearest_matching_encode_and_a_fifth_codec_gets_no_assignment() {
    let source = Source {
        width: 2560.0,
        height: 1440.0,
        scale: 1.0,
        codecs: &["a", "b", "c", "d", "e"],
    };
    let make = |id, side, codec| VideoViewer {
        id,
        viewport: Viewport {
            width: side,
            height: side,
            device_pixel_ratio: 1.0,
            native_shown: false,
        },
        codecs: codec,
        link: 8_000_000.0,
        scale: 1.0,
    };
    let sizes = [
        make("a", 2560.0, &["a"]),
        make("b", 1600.0, &["a"]),
        make("c", 1000.0, &["a"]),
        make("d", 500.0, &["a"]),
        make("e", 200.0, &["a"]),
    ];
    let plan = plan_video(&source, &sizes);
    assert_eq!(plan.encodes.len(), 4);
    assert_eq!(plan.viewers.len(), 5);
    assert_eq!(plan.viewers[3].1, plan.viewers[4].1);
    let codecs = [
        make("a", 2560.0, &["a"]),
        make("b", 1600.0, &["b"]),
        make("c", 1000.0, &["c"]),
        make("d", 500.0, &["d"]),
        make("e", 200.0, &["e"]),
    ];
    let plan = plan_video(&source, &codecs);
    assert_eq!(plan.encodes.len(), 4);
    assert_eq!(plan.viewers.len(), 4);
    assert!(plan.viewers.iter().all(|(id, _)| id != "e"));
}

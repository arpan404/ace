// SPDX-License-Identifier: Apache-2.0
//! Delivery through the engine: the plan's codecs, and the pictures a view gets —
//! their codec, parameter sets and capture time.
use super::*;
use crate::serve_sim::{Record, Translator};
use media_core::envelope::Assembler;
use media_core::headers::decode_picture;

#[test]
fn a_device_view_gets_annex_b_pictures_with_parameter_sets_on_keyframes() {
    let mut engine = watched(json!({ "kind": "device", "deviceId": "android:emulator-5554" }));
    // A length-prefixed unit, as the Simulator's reader gives one, with its avcC.
    let sps = vec![0x67, 0x42, 0xc0, 0x1f, 0xaa];
    let pps = vec![0x68, 0xce, 0x3c, 0x80];
    let mut avcc = vec![1, 0x42, 0xc0, 0x1f, 0xff, 0xe1];
    avcc.extend_from_slice(&(sps.len() as u16).to_be_bytes());
    avcc.extend_from_slice(&sps);
    avcc.push(1);
    avcc.extend_from_slice(&(pps.len() as u16).to_be_bytes());
    avcc.extend_from_slice(&pps);
    let effects = ingest(&mut engine, 1, h264(true, 7, 2, avcc), NOW);
    let pieces = binaries(&effects);
    let mut assembler = Assembler::new();
    let envelope = pieces.iter().find_map(|p| {
        assembler
            .push(p)
            .ok()
            .flatten()
            .map(|e| (e.kind, e.meta.to_vec(), e.payload.to_vec()))
    });
    let Some((kind, meta, payload)) = envelope else {
        panic!("no picture reached the device view");
    };
    assert_eq!(kind, 4);
    let Ok(picture) = decode_picture(4, &meta, &payload) else {
        panic!("a header the client can't read");
    };
    assert_eq!(picture.source_id, "android:emulator-5554");
    assert!(picture.key);
    let mut expected = vec![0, 0, 0, 1];
    expected.extend_from_slice(&sps);
    expected.extend_from_slice(&[0, 0, 0, 1]);
    expected.extend_from_slice(&pps);
    expected.extend_from_slice(&[0, 0, 0, 1, 0x65, 7]);
    assert_eq!(payload, expected);
}

/// One Simulator access unit of two NAL units, each with a 4-byte length; `first` is the leading
/// NAL's first byte (its type in the low five bits).
fn sim_unit(first: u8) -> Vec<u8> {
    let mut out = Vec::new();
    for nal in [[first, 0x88, 0x84], [0x06, 0x05, 0x01]] {
        out.extend_from_slice(&(nal.len() as u32).to_be_bytes());
        out.extend_from_slice(&nal);
    }
    out
}

#[test]
fn a_simulator_delta_reaches_a_device_view_with_a_codec_its_header_names() {
    // serve-sim's records, as its reader gives them: the avcC description, a keyframe, a delta.
    let fixture = include_bytes!("../../../../media-mp4/tests/vectors/h264.bin");
    let n = u32::from_be_bytes([fixture[0], fixture[1], fixture[2], fixture[3]]) as usize;
    let mut translate = Translator::default();
    assert_eq!(
        translate.frame(Record::Description(fixture[4..4 + n].to_vec())),
        Ok(None)
    );
    let mut engine = watched(json!({ "kind": "device", "deviceId": "android:emulator-5554" }));
    let Ok(Some(key)) = translate.frame(Record::Key(sim_unit(0x25))) else {
        panic!("a keyframe after its description is a frame");
    };
    assert_eq!(binaries(&ingest(&mut engine, 1, key, NOW)).len(), 1);
    let Ok(Some(delta)) = translate.frame(Record::Delta(sim_unit(0x21))) else {
        panic!("a delta is a frame");
    };
    let effects = ingest(&mut engine, 1, delta, at(1_100));
    let pieces = binaries(&effects);
    let mut assembler = Assembler::new();
    let codec = pieces.iter().find_map(|piece| {
        let envelope = assembler.push(piece).ok().flatten()?;
        let picture = decode_picture(4, envelope.meta, envelope.payload).ok()?;
        Some(picture.codec.to_owned())
    });
    let Some(codec) = codec else {
        panic!("a delta reached the device view with no header a client can read: {effects:?}");
    };
    assert!(
        codec.starts_with("avc1."),
        "the delta's header names the codec it carries: {codec:?}"
    );
}

/// The encode the first unit plans for the view, as the effects ask the producer for it.
fn planned_encode(effects: &[Effect]) -> u32 {
    let Some(plan) = wants(effects).pop() else {
        panic!("the first unit's size plans the view");
    };
    let Some(encode) = plan.first() else {
        panic!("the view decodes a codec the producer encodes");
    };
    encode.id
}

#[test]
fn a_device_delta_that_names_no_codec_is_delivered_with_its_encodes_codec() {
    let mut engine = watched(json!({ "kind": "device", "deviceId": "android:emulator-5554" }));
    let planned = planned_encode(&ingest(&mut engine, 1, h264(true, 0, 1, Vec::new()), NOW));
    let mut key = h264(true, 1, 1, Vec::new());
    key.encode = planned;
    ingest(&mut engine, 1, key, at(1_100));
    // A producer's re-encoded delta can arrive without naming its codec.
    let mut delta = h264(false, 2, 1, Vec::new());
    delta.encode = planned;
    delta.codec_string = String::new();
    let pieces = binaries(&ingest(&mut engine, 1, delta, at(1_200)));
    let mut assembler = Assembler::new();
    let envelope = pieces.iter().find_map(|p| {
        assembler
            .push(p)
            .ok()
            .flatten()
            .map(|e| (e.kind, e.meta.to_vec(), e.payload.to_vec()))
    });
    let Some((kind, meta, payload)) = envelope else {
        panic!("no picture reached the device view");
    };
    assert_eq!(kind, 4);
    let Ok(picture) = decode_picture(4, &meta, &payload) else {
        panic!("a header the client can't read");
    };
    assert_eq!(picture.codec, "avc1.42E033");
    assert!(!picture.key);
}

#[test]
fn a_delta_that_names_no_codec_before_its_encode_did_is_not_sent_as_a_picture() {
    let mut engine = watched(json!({ "kind": "device", "deviceId": "android:emulator-5554" }));
    let planned = planned_encode(&ingest(&mut engine, 1, h264(true, 0, 1, Vec::new()), NOW));
    // Nothing named this encode's codec yet: not even its keyframe.
    let mut key = h264(true, 1, 1, Vec::new());
    key.encode = planned;
    key.codec_string = String::new();
    assert!(binaries(&ingest(&mut engine, 1, key, at(1_100))).is_empty());
    let mut delta = h264(false, 2, 1, Vec::new());
    delta.encode = planned;
    delta.codec_string = String::new();
    assert!(
        binaries(&ingest(&mut engine, 1, delta, at(1_200))).is_empty(),
        "no header the client would reject for a codec it doesn't know"
    );
    // The keyframe that names the codec still starts the view.
    let mut named = h264(true, 3, 1, Vec::new());
    named.encode = planned;
    assert_eq!(binaries(&ingest(&mut engine, 1, named, at(1_300))).len(), 1);
}

/// The codecs ace-media asks the producer of `s1` for, once it said it encodes `encodes` and
/// its first unit gave the size.
fn planned_codecs(view: Value, encodes: Value) -> Vec<String> {
    let mut engine = watched_decoding(json!({ "kind": "screen", "sessionId": "screen-1" }), view);
    send(
        &mut engine,
        json!({ "type": "source.codecs", "source": "s1", "codecs": encodes }),
        &[],
        NOW,
    );
    let effects = ingest(&mut engine, 1, h264(true, 0, 1, Vec::new()), NOW);
    let Some(plan) = wants(&effects).pop() else {
        panic!("the first unit's size plans the view");
    };
    plan.into_iter().map(|encode| encode.codec).collect()
}

#[test]
fn a_phone_that_prefers_hevc_gets_h264_from_a_producer_that_only_encodes_h264() {
    assert_eq!(
        planned_codecs(
            json!(["hvc1.1.6.L153.B0", "avc1.42E033"]),
            json!(["avc1.42E033"])
        ),
        ["avc1.42E033"]
    );
}

#[test]
fn a_phone_that_prefers_hevc_gets_hevc_from_a_producer_that_encodes_it() {
    assert_eq!(
        planned_codecs(
            json!(["hvc1.1.6.L153.B0", "avc1.42E033"]),
            json!(["avc1.42E033", "hvc1.1.6.L153.B0"])
        ),
        ["hvc1.1.6.L153.B0"]
    );
}

#[test]
fn a_producer_left_with_no_codec_that_works_is_asked_for_none() {
    let mut engine = watched_decoding(
        json!({ "kind": "browser", "threadId": "t1" }),
        json!(["hvc1.1.6.L153.B0", "avc1.42E033"]),
    );
    let first = ingest(&mut engine, 1, h264(true, 0, 1, Vec::new()), NOW);
    assert!(
        !wants(&first).is_empty(),
        "planned from what the view decodes"
    );
    let none = send(
        &mut engine,
        json!({ "type": "source.codecs", "source": "s1", "codecs": [] }),
        &[],
        NOW,
    );
    assert_eq!(wants(&none).pop(), Some(Vec::new()));
}

#[test]
fn a_view_naming_another_h264_profile_takes_the_one_the_producer_encodes() {
    assert_eq!(
        planned_codecs(json!(["avc1.640033"]), json!(["avc1.42E033"])),
        ["avc1.42E033"]
    );
}

#[test]
fn a_view_takes_the_nearest_encode_a_producer_sends_when_it_doesnt_follow_the_plan() {
    let mut engine = watched(json!({ "kind": "screen", "sessionId": "screen-1" }));
    // The producer still runs the daemon's own encodes: ids 3 and 4, at two sizes.
    let mut small = h264(true, 1, 1, Vec::new());
    small.encode = 3;
    small.width = 390;
    small.height = 844;
    let mut large = h264(true, 2, 1, Vec::new());
    large.encode = 4;
    large.codec_string = "avc1.640033".into();
    ingest(&mut engine, 1, small.clone(), NOW);
    let first = ingest(&mut engine, 1, large.clone(), NOW);
    // The plan wants 1170 × 2532 for a 390-point-wide phone at 3×: the large one, whose
    // profile differs from the one the viewer named but whose family it decodes.
    assert_eq!(binaries(&first).len(), 1);
    small.flags = 0;
    assert!(binaries(&ingest(&mut engine, 1, small, at(1_100))).is_empty());
    large.flags = 0;
    assert_eq!(binaries(&ingest(&mut engine, 1, large, at(1_100))).len(), 1);
}

#[test]
fn a_view_on_a_fallback_encode_keeps_playing_through_deltas_that_carry_no_codec() {
    let mut engine = watched(json!({ "kind": "screen", "sessionId": "screen-1" }));
    // The producer ignores the plan: its own encode 4, in an H.264 profile the viewer doesn't
    // name but its family it decodes.
    let mut key = h264(true, 1, 1, Vec::new());
    key.encode = 4;
    key.codec_string = "avc1.640033".into();
    assert_eq!(binaries(&ingest(&mut engine, 1, key, NOW)).len(), 1);
    // serve-sim names the codec only on keyframes: a delta of the same encode carries none.
    let mut delta = h264(false, 2, 1, Vec::new());
    delta.encode = 4;
    delta.codec_string = String::new();
    let effects = ingest(&mut engine, 1, delta, at(1_100));
    assert_eq!(binaries(&effects).len(), 1, "the delta reached the view");
    assert!(
        !effects.iter().any(|e| matches!(
            e,
            Effect::Normal(FromMedia::ViewerPlaying { playing: false, .. })
        )),
        "the view was told it stopped: {effects:?}"
    );
}

#[test]
fn a_piece_carries_the_units_capture_time_on_the_wall_clock() {
    let mut engine = watched(json!({ "kind": "browser", "threadId": "t1" }));
    let stamped = |unit: &mut MediaFrame, at: f64| {
        let mut extension = vec![0, 1, 0, 24];
        extension.extend_from_slice(&7u64.to_be_bytes());
        extension.extend_from_slice(&at.to_be_bytes());
        extension.extend_from_slice(&1.0f64.to_be_bytes());
        unit.extension = extension;
    };
    let timestamp = |effects: &[Effect]| {
        let mut assembler = Assembler::new();
        binaries(effects).iter().find_map(|p| {
            let envelope = assembler.push(p).ok().flatten()?;
            media_core::headers::decode_video(envelope.meta, envelope.payload)
                .ok()
                .map(|v| v.timestamp)
        })
    };
    let mut key = h264(true, 0, 1, Vec::new());
    stamped(&mut key, 1_700_000_000_123.5);
    assert_eq!(
        timestamp(&ingest(&mut engine, 1, key, NOW)),
        Some(1_700_000_000_123.5)
    );
    // Without a stamp: the wall clock less the unit's age.
    let mut delta = h264(false, 1, 1, Vec::new());
    delta.age_us = 20_000;
    assert_eq!(
        timestamp(&ingest(&mut engine, 1, delta, NOW)),
        Some(NOW.wall_ms as f64 - 20.0)
    );
}

#[test]
fn a_page_that_changes_size_plans_its_views_again_at_its_new_shape() {
    let mut engine = watched(json!({ "kind": "browser", "threadId": "t1" }));
    // Planned at the first unit's size: a phone-shaped page.
    let first = ingest(&mut engine, 1, h264(true, 0, 1, Vec::new()), NOW);
    assert!(!wants(&first).is_empty());
    // The tab is resized to 800 x 600: views are planned at its shape, never letterboxed into
    // the old one.
    let page = json!({ "type": "source.page", "source": "s1", "width": 800, "height": 600,
                       "scale": 1 });
    let resized = send(&mut engine, page.clone(), &[], at(1_000));
    let Some(plan) = wants(&resized).pop() else {
        panic!("a new page size plans the views again");
    };
    let shape = f64::from(plan[0].width) / f64::from(plan[0].height);
    assert!((shape - 800.0 / 600.0).abs() < 0.02, "{shape}");
    // The same size again changes nothing.
    assert!(wants(&send(&mut engine, page, &[], at(1_500))).is_empty());
    // A unit's own size never overrides the page the producer said.
    let later = ingest(&mut engine, 1, h264(false, 1, 1, Vec::new()), at(2_000));
    assert!(wants(&later).is_empty());
}

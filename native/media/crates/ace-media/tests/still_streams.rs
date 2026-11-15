// SPDX-License-Identifier: Apache-2.0
//! Stills through the engine and the real still threads on this Mac's decoder, from streams
//! that change under them: a codec, layout and size switch whose new keyframe carries its
//! parameter sets only in band, and two encodes interleaved on one source. Each still is
//! decoded again by the independent CPU decoder.
#![cfg(target_os = "macos")]
#[path = "../bench/screen.rs"]
mod screen;

use ace_media::engine::egress::NoEgress;
use ace_media::engine::recorder::NoRecorders;
use ace_media::engine::stills::StillOutcome;
use ace_media::engine::{Effect, Engine, Now};
use ace_media::stills::StillThreads;
use media_bitstream::hvcc::HevcConfig;
use media_bitstream::nal::length_prefixed_to_annex_b;
use media_codec::*;
use media_vt::VtEncoder;
use media_wire::control::{Capability, FromMedia, KeyReason, ToMedia};
use media_wire::frame::MediaFrame;
use serde_json::json;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

const NOW: Now = Now {
    mono_ms: 1_000,
    mono_us: 1_000_000,
    wall_ms: 1_000,
};

#[path = "support/probed.rs"]
mod probed;
use probed::probed;

struct Rig {
    engine: Engine,
    results: Receiver<StillOutcome>,
}

impl Rig {
    fn new() -> Self {
        Self::with(&probed())
    }

    fn with(capabilities: &[Capability]) -> Self {
        let (tx, results) = channel();
        let started = Instant::now();
        let threads = StillThreads::probed(
            1,
            capabilities,
            Arc::new(move || started.elapsed().as_micros() as u64),
            Arc::new(move |outcome| {
                let _ = tx.send(outcome);
            }),
        );
        let Ok(threads) = threads else {
            panic!("still threads")
        };
        let engine =
            Engine::new(Box::new(NoRecorders), Box::new(NoEgress)).with_stills(Box::new(threads));
        let mut rig = Self { engine, results };
        rig.control(
            json!({ "type": "source.open", "source": "s1", "handle": 1, "epoch": 1,
                    "origin": { "kind": "tab" } }),
            &[9; 32],
        );
        assert!(rig.engine.ingest_hello(1, &[9; 32]));
        rig
    }

    fn control(&mut self, value: serde_json::Value, payload: &[u8]) -> Vec<Effect> {
        let message: ToMedia = match serde_json::from_value(value) {
            Ok(message) => message,
            Err(error) => panic!("{error}"),
        };
        self.engine
            .control(message, Zeroizing::new(payload.to_vec()), NOW);
        self.engine.effects().collect()
    }

    fn feed(&mut self, frames: Vec<MediaFrame>) {
        for frame in frames {
            self.engine.ingest(1, frame, NOW);
        }
        self.engine.effects().for_each(drop);
    }

    /// A still of the whole picture: its JPEG's size as the CPU decoder reads it.
    fn still(&mut self, request: &str) -> Size {
        match self.answer(request) {
            Ok(size) => size,
            Err(reason) => panic!("{request}: still.failed {reason}"),
        }
    }

    /// Sends `still.take` and lets the maker's result reach the engine.
    fn ask(&mut self, request: &str) -> Vec<Effect> {
        self.control(
            json!({ "type": "still.take", "request": request, "source": "s1", "maxWidth": 4000,
                    "maxHeight": 4000, "maxPixels": 16_000_000, "quality": 80,
                    "deadlineMs": 5_000 }),
            &[],
        )
    }

    fn arrive(&mut self) -> Vec<Effect> {
        match self.results.recv_timeout(Duration::from_secs(5)) {
            Ok(outcome) => self.engine.still_finished(outcome),
            Err(_) => return Vec::new(),
        }
        self.engine.effects().collect()
    }

    fn answer(&mut self, request: &str) -> Result<Size, String> {
        let mut effects = self.ask(request);
        if effects.is_empty() {
            effects = self.arrive();
        }
        match effects.as_slice() {
            [Effect::NormalWith(FromMedia::StillDone { .. }, jpeg)] => decoded(request, jpeg),
            [Effect::Normal(FromMedia::StillFailed { reason, .. })] => Err(reason.clone()),
            other => panic!("{request}: expected an answer, got {other:?}"),
        }
    }
}

fn decoded(request: &str, jpeg: &[u8]) -> Result<Size, String> {
    match StillCodec::decode(&mut CpuJpegCodec::default(), jpeg) {
        Ok(picture) => Ok(picture.size()),
        Err(error) => panic!("{request}: not a JPEG: {error}"),
    }
}

/// `frames` frames of the screen at `size` from VideoToolbox: length-prefixed units, the
/// configuration record on the keyframe.
fn encoded(codec: Codec, size: Size, frames: u32) -> Vec<EncodedUnit> {
    let mut encoder = VtEncoder::new();
    let configured = encoder.configure(&EncodeSpec {
        codec,
        size,
        fps: 60,
        rate: RateControl::Bitrate(4_000_000),
    });
    assert!(configured.is_ok(), "{configured:?}");
    let mut units = Vec::new();
    for frame in 0..frames {
        assert!(
            encoder
                .encode(Picture::Cpu(screen::screen(size, frame)), frame == 0)
                .is_ok()
        );
        while let Ok(Some(unit)) = encoder.poll_result() {
            units.push(unit);
        }
    }
    assert!(encoder.flush().is_ok());
    while let Ok(Some(unit)) = encoder.poll_result() {
        units.push(unit);
    }
    assert!(units.first().is_some_and(|u| u.key));
    units
}

fn frame(
    unit: &EncodedUnit,
    codec: u8,
    encode: u32,
    payload: Vec<u8>,
    description: Vec<u8>,
) -> MediaFrame {
    MediaFrame {
        kind: 1,
        flags: u32::from(unit.key) | if description.is_empty() { 0 } else { 4 },
        age_us: 0,
        width: unit.size.width as u16,
        height: unit.size.height as u16,
        display_width: unit.size.width as u16,
        display_height: unit.size.height as u16,
        scale: 1000,
        rotation: 0,
        codec,
        encode,
        epoch: 1,
        codec_string: String::new(),
        description,
        extension: Vec::new(),
        payload,
    }
}

/// As a producer sends length-prefixed units: the record on the keyframe only.
fn length_prefixed(units: &[EncodedUnit], encode: u32) -> Vec<MediaFrame> {
    units
        .iter()
        .map(|u| {
            let codec = if u.codec == Codec::H264 { 2 } else { 4 };
            let description = if u.key {
                u.description.clone().unwrap_or_default()
            } else {
                Vec::new()
            };
            frame(u, codec, encode, u.data.clone(), description)
        })
        .collect()
}

/// As an Annex B producer sends HEVC: parameter sets in band on the keyframe, no record.
fn annex_b_hevc(units: &[EncodedUnit], encode: u32) -> Vec<MediaFrame> {
    let record = units[0].description.clone().unwrap_or_default();
    let Ok(config) = HevcConfig::parse(&record) else {
        panic!("hvcC")
    };
    units
        .iter()
        .map(|u| {
            let mut payload = Vec::new();
            if u.key {
                for nal in config.arrays.iter().flat_map(|a| &a.units) {
                    payload.extend_from_slice(&[0, 0, 0, 1]);
                    payload.extend_from_slice(nal);
                }
            }
            let mut picture = Vec::new();
            assert!(length_prefixed_to_annex_b(&u.data, 4, &mut picture).is_ok());
            payload.extend(picture);
            frame(u, 3, encode, payload, Vec::new())
        })
        .collect()
}

const LARGE: Size = Size {
    width: 640,
    height: 480,
};
const SMALL: Size = Size {
    width: 320,
    height: 240,
};

#[test]
fn a_switch_to_annex_b_hevc_at_another_size_decodes_from_its_own_parameter_sets() {
    let mut rig = Rig::new();
    rig.feed(length_prefixed(&encoded(Codec::H264, LARGE, 3), 1));
    assert_eq!(rig.still("avcc"), LARGE);
    // The producer restarts its encode as Annex B HEVC, smaller, with no record attached.
    rig.feed(annex_b_hevc(&encoded(Codec::Hevc, SMALL, 3), 1));
    assert_eq!(rig.still("annex-b"), SMALL);
    // And back: a new record arrives with the new keyframe.
    rig.feed(length_prefixed(&encoded(Codec::Hevc, LARGE, 2), 1));
    assert_eq!(rig.still("hvcc"), LARGE);
}

#[test]
fn interleaved_encodes_give_stills_of_one_of_them() {
    let mut rig = Rig::new();
    let large = length_prefixed(&encoded(Codec::H264, LARGE, 4), 1);
    let small = length_prefixed(&encoded(Codec::H264, SMALL, 4), 2);
    let mut interleaved = Vec::new();
    for (a, b) in large.into_iter().zip(small) {
        interleaved.push(a);
        interleaved.push(b);
    }
    rig.feed(interleaved);
    // The latest keyframe was the small encode's; the large one's deltas never reach it.
    assert_eq!(rig.still("q1"), SMALL);
    rig.feed(length_prefixed(&encoded(Codec::H264, LARGE, 2), 1).split_off(1));
    assert_eq!(rig.still("q2"), SMALL);
}

#[test]
fn a_path_found_after_start_takes_over_from_the_next_keyframe() {
    // Started before the VideoToolbox trial answered: the CPU path, which can't decode video.
    let mut rig = Rig::with(&[]);
    rig.feed(length_prefixed(&encoded(Codec::H264, LARGE, 3), 1));
    assert_eq!(rig.answer("before"), Err("decode-unavailable".into()));
    // The trial's late result arrives as capabilities.changed.
    let found = probed();
    rig.engine.capabilities_changed(&found);
    // The group began before the new path's decoder existed: it asks for a keyframe.
    let asked = rig.ask("after");
    let asked: Vec<Effect> = if asked.is_empty() {
        rig.arrive()
    } else {
        asked
    };
    assert!(
        asked.iter().any(|e| matches!(
            e,
            Effect::Normal(FromMedia::SourceKeyframe {
                reason: KeyReason::Drop,
                ..
            })
        )),
        "{asked:?}"
    );
    rig.feed(length_prefixed(&encoded(Codec::H264, LARGE, 1), 1));
    let effects = rig.arrive();
    let [Effect::NormalWith(FromMedia::StillDone { .. }, jpeg)] = effects.as_slice() else {
        panic!("expected the still after the keyframe, got {effects:?}")
    };
    assert_eq!(decoded("after", jpeg), Ok(LARGE));
}

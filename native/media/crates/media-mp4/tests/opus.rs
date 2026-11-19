// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::unwrap_used)]
#[path = "support/reader.rs"]
mod reader;
use media_mp4::{Error, Group, Muxer, OpusConfig, Sample, VideoCodec, VideoConfig};
use reader::*;

fn mux() -> Muxer {
    let fixture = include_bytes!("vectors/h264.bin");
    let len = u32at(fixture, 0) as usize;
    Muxer::new(
        VideoConfig {
            codec: VideoCodec::H264,
            width: 64,
            height: 64,
            timescale: 90000,
            description: fixture[4..4 + len].to_vec(),
        },
        Some(OpusConfig {
            channels: 2,
            input_sample_rate: 48000,
            priming_samples: 0,
            output_gain: 0,
        }),
    )
    .unwrap()
}
fn video() -> Sample<'static> {
    let fixture = include_bytes!("vectors/h264.bin");
    let at = 4 + u32at(fixture, 0) as usize;
    let len = u32at(fixture, at) as usize;
    Sample {
        timestamp: 0,
        keyframe: true,
        data: &fixture[at + 4..at + 4 + len],
    }
}
fn audio(timestamp: u64) -> Sample<'static> {
    Sample {
        timestamp,
        keyframe: true,
        data: &[0xf8, 0xff, 0xfe],
    }
}
fn group<'a>(v: &'a [Sample<'a>], a: &'a [Sample<'a>], end: u64) -> Group<'a> {
    Group {
        video: v,
        video_end: 12000,
        audio: a,
        audio_end: end,
    }
}
#[test]
fn a_precise_final_cut_keeps_video_and_only_valid_audio_samples() {
    for valid in [1, 119, 120, 960] {
        let mut mux = mux();
        let v = [video()];
        let a = [audio(0), audio(960)];
        if valid < 120 {
            assert_eq!(
                mux.fragment(group(&v, &a, 960 + valid)),
                Err(Error::InvalidTimestamp)
            );
        }
        let f = mux.final_fragment(group(&v, &a, 960 + valid)).unwrap();
        assert_eq!(u32at(child(reader::boxes(&f)[0].body, b"mfhd"), 4), 1);
        let tracks = runs(&f);
        assert_eq!(tracks[0].payloads[0], v[0].data);
        assert_eq!(tracks[1].durations, [960, valid as u32]);
        assert_eq!(tracks[1].payloads[1], a[1].data);
        assert_eq!(mux.fragment(group(&v, &a, 1920)), Err(Error::Finished));
        assert_eq!(
            mux.final_fragment(group(&v, &a, 1920)),
            Err(Error::Finished)
        );
        assert!(mux.finish().is_ok());
    }
}
#[test]
fn a_final_cut_still_rejects_short_interior_or_nonpositive_final_audio() {
    let mut mux = mux();
    let v = [video()];
    for a in [[audio(0), audio(119)], [audio(0), audio(0)]] {
        assert_eq!(
            mux.final_fragment(group(&v, &a, 1079)),
            Err(Error::InvalidTimestamp)
        );
    }
    let a = [audio(0), audio(960)];
    for end in [959, 960] {
        assert_eq!(
            mux.final_fragment(group(&v, &a, end)),
            Err(Error::InvalidTimestamp)
        );
    }
    assert!(mux.final_fragment(group(&v, &a, 1079)).is_ok());
}
#[test]
fn opus_silence_with_a_trimmed_tail_can_be_exported_for_native_decode() {
    let mut mux = mux();
    let v = [video()];
    let a: Vec<_> = (0..6).map(|i| audio(i * 960)).collect();
    let mut file = mux.init_segment().to_vec();
    let f = mux.final_fragment(group(&v, &a, 5 * 960 + 119)).unwrap();
    assert_eq!(runs(&f)[1].durations, [960, 960, 960, 960, 960, 119]);
    file.extend(f);
    file.extend(mux.finish().unwrap());
    if let Ok(dir) = std::env::var("ACE_MP4_PLAYBACK_DIR") {
        std::fs::write(format!("{dir}/opus-cut.mp4"), file).unwrap();
    }
}

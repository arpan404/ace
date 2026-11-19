// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::unwrap_used)]
#[path = "support/reader.rs"]
mod reader;
use media_mp4::{Error, Group, Muxer, OpusConfig, Sample, VideoCodec, VideoConfig};
use reader::*;
fn config(codec: VideoCodec) -> VideoConfig {
    VideoConfig {
        codec,
        width: 1920,
        height: 1080,
        timescale: 90000,
        description: match codec {
            VideoCodec::H264 => vec![
                1, 66, 0, 30, 255, 225, 0, 4, 103, 66, 0, 30, 1, 0, 2, 104, 0,
            ],
            VideoCodec::Hevc => vec![
                1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 120, 240, 0, 252, 253, 248, 248, 0, 0, 15, 0,
            ],
        },
    }
}
fn sample(timestamp: u64, keyframe: bool) -> Sample<'static> {
    Sample {
        timestamp,
        keyframe,
        data: if keyframe {
            &[0, 0, 0, 2, 0x65, 0x88]
        } else {
            &[0, 0, 0, 2, 0x41, 0x9a]
        },
    }
}
fn group<'a>(v: &'a [Sample<'a>], end: u64) -> Group<'a> {
    Group {
        video: v,
        video_end: end,
        audio: &[],
        audio_end: 0,
    }
}
#[test]
fn init_describes_both_codecs_and_empty_fragmented_sample_tables() {
    for (codec, entry, desc) in [
        (VideoCodec::H264, b"avc1", b"avcC"),
        (VideoCodec::Hevc, b"hvc1", b"hvcC"),
    ] {
        let cfg = config(codec);
        let mux = Muxer::new(cfg.clone(), None).unwrap();
        let top = boxes(mux.init_segment());
        assert_eq!(
            top.iter().map(|b| b.kind).collect::<Vec<_>>(),
            [b"ftyp", b"moov"]
        );
        assert_eq!(&top[0].body[..4], b"iso6");
        let moov = top[1].body;
        let mvhd = child(moov, b"mvhd");
        assert_eq!(u32at(mvhd, 12), 48000);
        let trak = child(moov, b"trak");
        let tk = child(trak, b"tkhd");
        assert_eq!(u32at(tk, 76), 1920 << 16);
        assert_eq!(u32at(tk, 80), 1080 << 16);
        let mdia = child(trak, b"mdia");
        assert_eq!(u32at(child(mdia, b"mdhd"), 12), 90000);
        let stbl = child(child(mdia, b"minf"), b"stbl");
        let sd = child(stbl, b"stsd");
        assert_eq!(u32at(sd, 4), 1);
        let entries = boxes(&sd[8..]);
        assert_eq!(entries[0].kind, entry);
        assert_eq!(child(&entries[0].body[78..], desc), cfg.description);
        assert_eq!(u32at(child(stbl, b"stsz"), 8), 0);
        assert_eq!(u32at(child(child(moov, b"mvex"), b"trex"), 4), 1);
    }
}
#[test]
fn variable_timestamps_and_payloads_round_trip_for_both_video_codecs() {
    for codec in [VideoCodec::H264, VideoCodec::Hevc] {
        let mut mux = Muxer::new(config(codec), None).unwrap();
        let samples = [
            sample(1_u64 << 33, true),
            sample((1_u64 << 33) + 1500, false),
            sample((1_u64 << 33) + 4500, false),
        ];
        let bytes = mux.fragment(group(&samples, (1_u64 << 33) + 9000)).unwrap();
        let r = runs(&bytes);
        assert_eq!(r[0].id, 1);
        assert_eq!(r[0].time, 1_u64 << 33);
        assert_eq!(r[0].durations, [1500, 3000, 4500]);
        assert_eq!(r[0].flags, [0x2000000, 0x1010000, 0x1010000]);
        assert_eq!(
            r[0].payloads,
            samples.iter().map(|s| s.data.to_vec()).collect::<Vec<_>>()
        );
    }
}
#[test]
fn every_keyframe_starts_a_fragment_and_index_points_to_sync_samples() {
    let mut mux = Muxer::new(config(VideoCodec::H264), None).unwrap();
    let mut file = mux.init_segment().to_vec();
    let mut offsets = vec![];
    for start in [0, 6000, 20000] {
        offsets.push(file.len());
        let s = [sample(start, true), sample(start + 1500, false)];
        let frag = mux.fragment(group(&s, start + 3000)).unwrap();
        assert_eq!(
            u32at(child(boxes(&frag)[0].body, b"mfhd"), 4),
            offsets.len() as u32
        );
        file.extend(frag);
    }
    let index = mux.finish().unwrap();
    let mfra = child(&index, b"mfra");
    let tfra = child(mfra, b"tfra");
    assert_eq!(u32at(tfra, 12), 3);
    for (i, (time, offset)) in [0, 6000, 20000].iter().zip(offsets).enumerate() {
        assert_eq!(u64at(tfra, 16 + i * 19), *time);
        assert_eq!(u64at(tfra, 24 + i * 19), offset as u64);
        assert_eq!(&tfra[32 + i * 19..35 + i * 19], &[1, 1, 1]);
    }
    assert_eq!(u32at(child(mfra, b"mfro"), 4), index.len() as u32);
    assert_eq!(committed(&file), 3);
    assert_eq!(mux.finish(), Err(Error::Finished));
}
#[test]
fn every_mid_fragment_cut_preserves_exactly_the_last_whole_fragment() {
    let mut mux = Muxer::new(config(VideoCodec::H264), None).unwrap();
    let s = [sample(0, true), sample(3000, false)];
    let first = mux.fragment(group(&s, 6000)).unwrap();
    let mut file = mux.init_segment().to_vec();
    file.extend(first);
    let s = [sample(6000, true), sample(9000, false)];
    let second = mux.fragment(group(&s, 12000)).unwrap();
    for cut in 0..second.len() {
        let mut crash = file.clone();
        crash.extend(&second[..cut]);
        assert_eq!(media_mp4::recovery_prefix(&crash).unwrap(), file.len());
        assert_eq!(committed(&crash), 1, "cut={cut}");
    }
    file.extend(second);
    assert_eq!(committed(&file), 2);
}
#[test]
fn invalid_groups_do_not_advance_the_sequence_or_accept_deltas_after_gaps() {
    let mut mux = Muxer::new(config(VideoCodec::H264), None).unwrap();
    for s in [
        vec![sample(0, false)],
        vec![sample(0, true), sample(1500, true)],
    ] {
        assert_eq!(mux.fragment(group(&s, 3000)), Err(Error::InvalidGroup));
    }
    for s in [
        vec![sample(3000, true), sample(1500, false)],
        vec![sample(0, true), sample(0, false)],
    ] {
        assert_eq!(mux.fragment(group(&s, 6000)), Err(Error::InvalidTimestamp));
    }
    let s = [sample(0, true)];
    let f = mux.fragment(group(&s, 3000)).unwrap();
    assert_eq!(u32at(child(boxes(&f)[0].body, b"mfhd"), 4), 1);
    let s = [sample(20000, false)];
    assert_eq!(mux.fragment(group(&s, 23000)), Err(Error::InvalidGroup));
    let s = [sample(20000, true)];
    assert_eq!(
        runs(&mux.fragment(group(&s, 23000)).unwrap())[0].time,
        20000
    );
}
#[test]
fn opus_has_48khz_timing_sync_packets_pre_roll_and_priming_edit() {
    let a = OpusConfig {
        channels: 2,
        input_sample_rate: 48000,
        priming_samples: 312,
        output_gain: -256,
    };
    let mut mux = Muxer::new(config(VideoCodec::H264), Some(a)).unwrap();
    let tracks = boxes(child(mux.init_segment(), b"moov"));
    let trak = tracks
        .iter()
        .filter(|b| b.kind == b"trak")
        .nth(1)
        .unwrap()
        .body;
    let edit = child(child(trak, b"edts"), b"elst");
    assert_eq!(u64at(edit, 8), 0);
    assert_eq!(u64at(edit, 16), 312);
    let mdia = child(trak, b"mdia");
    assert_eq!(&child(mdia, b"hdlr")[8..12], b"soun");
    assert_eq!(u32at(child(mdia, b"mdhd"), 12), 48000);
    let stbl = child(child(mdia, b"minf"), b"stbl");
    let stsd = child(stbl, b"stsd");
    let entry = boxes(&stsd[8..]);
    assert_eq!(entry[0].kind, b"Opus");
    assert_eq!(
        child(&entry[0].body[28..], b"dOps"),
        &[0, 2, 15, 0, 0, 0, 187, 128, 255, 0, 0]
    );
    assert_eq!(&child(stbl, b"sgpd")[16..18], &[255, 224]);
    let v = [sample(0, true)];
    let audio = [
        Sample {
            timestamp: 0,
            keyframe: false,
            data: &[0xf8, 0xff, 0xfe],
        },
        Sample {
            timestamp: 960,
            keyframe: false,
            data: &[0xf8, 0xff, 0xfe],
        },
    ];
    let f = mux
        .fragment(Group {
            video: &v,
            video_end: 3600,
            audio: &audio,
            audio_end: 1920,
        })
        .unwrap();
    let r = runs(&f);
    assert_eq!(r.len(), 2);
    assert_eq!(r[1].id, 2);
    assert_eq!(r[1].durations, [960, 960]);
    assert_eq!(r[1].flags, [0x2000000, 0x2000000]);
    assert_eq!(r[1].payloads[0], audio[0].data);
    let trafs = boxes(boxes(&f)[0].body);
    let at = trafs.iter().filter(|b| b.kind == b"traf").nth(1).unwrap();
    assert_eq!(u32at(child(at.body, b"sbgp"), 16), 1);
}
#[test]
fn part_limit_reserves_space_for_the_final_index_without_consuming_a_group() {
    let mut mux = Muxer::new(config(VideoCodec::H264), None).unwrap();
    let data = vec![0; 1024 * 1024];
    let mut timestamp = 0;
    loop {
        let v = [Sample {
            timestamp,
            keyframe: true,
            data: &data,
        }];
        match mux.fragment(group(&v, timestamp + 3000)) {
            Ok(_) => timestamp += 3000,
            Err(Error::PartFull) => break,
            other => panic!("unexpected {other:?}"),
        }
    }
    assert!(timestamp > 500 * 3000);
    assert!(timestamp < 512 * 3000);
    assert!(mux.finish().is_ok());
    let mut fresh = Muxer::new(config(VideoCodec::H264), None).unwrap();
    let v = [Sample {
        timestamp,
        keyframe: true,
        data: &data,
    }];
    assert!(fresh.fragment(group(&v, timestamp + 3000)).is_ok());
}

#[test]
fn fixed_iso_box_layout_vector_is_replayed() {
    let text = include_str!("vectors/video-fragment.hex").trim();
    let expected: Vec<u8> = (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect();
    let mut mux = Muxer::new(config(VideoCodec::H264), None).unwrap();
    let samples = [sample(0, true), sample(1500, false), sample(4500, false)];
    let fragment = mux.fragment(group(&samples, 9000)).unwrap();
    assert_eq!(fragment, expected);
    assert_eq!(runs(&expected)[0].durations, [1500, 3000, 4500]);
}

#[test]
fn platform_encoder_vectors_round_trip_and_can_be_exported_for_playback() {
    for (codec, name, fixture) in [
        (
            VideoCodec::H264,
            "h264",
            include_bytes!("vectors/h264.bin").as_slice(),
        ),
        (
            VideoCodec::Hevc,
            "hevc",
            include_bytes!("vectors/hevc.bin").as_slice(),
        ),
    ] {
        let config_len = u32at(fixture, 0) as usize;
        let description = fixture[4..4 + config_len].to_vec();
        let mut cfg = config(codec);
        cfg.width = 64;
        cfg.height = 64;
        cfg.description = description;
        let mut mux = Muxer::new(cfg, None).unwrap();
        let mut file = mux.init_segment().to_vec();
        let mut at = 4 + config_len;
        let mut count = 0;
        while at < fixture.len() {
            let len = u32at(fixture, at) as usize;
            at += 4;
            let samples = [Sample {
                timestamp: count * 3000,
                keyframe: true,
                data: &fixture[at..at + len],
            }];
            at += len;
            let f = mux.fragment(group(&samples, (count + 1) * 3000)).unwrap();
            assert_eq!(runs(&f)[0].payloads[0], samples[0].data);
            count += 1;
            if count == 3 {
                let mut cut = file.clone();
                cut.extend(&f[..f.len() - 1]);
                assert_eq!(committed(&cut), 2);
                if let Ok(dir) = std::env::var("ACE_MP4_PLAYBACK_DIR") {
                    let prefix = media_mp4::recovery_prefix(&cut).unwrap();
                    std::fs::write(format!("{dir}/{name}-cut.mp4"), &cut[..prefix]).unwrap();
                }
            }
            file.extend(f);
        }
        assert_eq!(count, 3);
        file.extend(mux.finish().unwrap());
        if let Ok(dir) = std::env::var("ACE_MP4_PLAYBACK_DIR") {
            std::fs::write(format!("{dir}/{name}.mp4"), file).unwrap();
        }
    }
}

#[test]
fn recovery_rejects_a_cut_init_and_discards_truncated_index() {
    let mut mux = Muxer::new(config(VideoCodec::H264), None).unwrap();
    for cut in 0..mux.init_segment().len() {
        assert_eq!(
            media_mp4::recovery_prefix(&mux.init_segment()[..cut]),
            Err(Error::InvalidFile)
        );
    }
    let mut file = mux.init_segment().to_vec();
    let s = [sample(0, true)];
    file.extend(mux.fragment(group(&s, 3000)).unwrap());
    let end = file.len();
    let index = mux.finish().unwrap();
    for cut in 0..=index.len() {
        let mut crashed = file.clone();
        crashed.extend(&index[..cut]);
        assert_eq!(media_mp4::recovery_prefix(&crashed).unwrap(), end);
    }
}

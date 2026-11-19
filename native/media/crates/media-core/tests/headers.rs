// SPDX-License-Identifier: Apache-2.0
mod support;
use media_core::{
    envelope::{Assembler, Pieces},
    headers::*,
};
fn video<'a>() -> Video<'a> {
    Video {
        sequence: 7.,
        timestamp: 120.,
        width: 1920,
        height: 1080,
        coded_width: 1280,
        coded_height: 720,
        key: true,
        codec: "avc1.42001f",
        description: &[1, 2],
        thread_id: "thread-1",
        tab_id: Some("tab-1"),
    }
}
fn picture<'a>() -> Picture<'a> {
    Picture {
        sequence: 9.,
        timestamp: 130.,
        width: 1280,
        height: 720,
        scale: 1.5,
        rotation: 90,
        key: true,
        still: false,
        codec: "jpeg",
        source_id: "source-1",
        stream_id: "stream-1",
    }
}
#[test]
fn all_four_shared_headers_encode_byte_for_byte() -> Result<(), Box<dyn std::error::Error>> {
    let fixtures = support::hex_fields(include_str!("../../../vectors/headers/scenarios.json"));
    // First hex field is the video's decoder description; last is the common payload.
    assert_eq!(fixtures.len(), 6);
    let audio = Audio {
        sequence: 8.,
        timestamp: 125.,
        sample_rate: 48000,
        channels: 2,
        codec: "opus",
        thread_id: "thread-1",
        tab_id: Some("tab-1"),
    };
    let mut meta = [0; 1024];
    for (index, kind, id) in [(1, 2, 1), (2, 3, 2), (3, 4, 3), (4, 5, 3)] {
        let n = match kind {
            2 => video().encode(&mut meta)?,
            3 => audio.encode(&mut meta)?,
            _ => picture().encode(&mut meta)?,
        };
        let p = Pieces::new(kind, id, &meta[..n], &fixtures[5])?
            .next()
            .ok_or("piece")?;
        let mut bytes = vec![0; p.len()];
        p.write_to(&mut bytes)?;
        assert_eq!(bytes, fixtures[index]);
        let mut a = Assembler::new();
        let e = a.push(&bytes)?.ok_or("message")?;
        match kind {
            2 => assert_eq!(decode_video(e.meta, e.payload)?, video()),
            3 => assert_eq!(decode_audio(e.meta, e.payload)?, audio),
            // K1 uses a deliberately non-device source id. The legacy decoder rejects it too.
            4 => assert!(decode_picture(kind, e.meta, e.payload).is_err()),
            _ => assert_eq!(decode_picture(kind, e.meta, e.payload)?, picture()),
        }
    }
    Ok(())
}
#[test]
fn truncated_overlong_and_invalid_video_headers_never_decode()
-> Result<(), Box<dyn std::error::Error>> {
    let mut bytes = [0; 1024];
    let n = video().encode(&mut bytes)?;
    for end in 0..n {
        assert!(decode_video(&bytes[..end], &[1]).is_err());
    }
    assert!(decode_video(&bytes[..n + 1], &[1]).is_err());
    assert!(decode_video(&bytes[..n], &[]).is_err());
    for (at, value) in [(29, 255), (30, 255), (16, 255), (24, 255)] {
        let mut bad = bytes;
        bad[at] = value;
        assert!(decode_video(&bad[..n], &[1]).is_err());
    }
    for value in [f64::NAN, f64::INFINITY, -1., 0.5, 9007199254740992.] {
        let mut v = video();
        v.sequence = value;
        let n = v.encode(&mut bytes)?;
        assert!(decode_video(&bytes[..n], &[1]).is_err());
    }
    let mut v = video();
    v.timestamp = -1.;
    v.key = false;
    v.description = &[];
    v.tab_id = None;
    let n = v.encode(&mut bytes)?;
    assert_eq!(decode_video(&bytes[..n], &[1])?, v);
    assert!(video().encode(&mut [0; 10]).is_err());
    Ok(())
}
#[test]
fn pictures_keep_rotation_still_jpeg_key_and_six_digit_scale()
-> Result<(), Box<dyn std::error::Error>> {
    let mut p = picture();
    p.source_id = "android:emulator-5554";
    p.scale = 1. / 3.;
    p.still = true;
    p.key = false;
    let mut bytes = [0; 1024];
    let n = p.encode(&mut bytes)?;
    let decoded = decode_picture(4, &bytes[..n], &[1])?;
    assert!(decoded.key);
    assert!(decoded.still);
    assert_eq!(decoded.scale, 0.333333);
    assert_eq!(decoded.rotation, 90);
    for end in 0..n {
        assert!(decode_picture(4, &bytes[..end], &[1]).is_err());
    }
    for (at, value) in [(24, 1), (27, 255), (20, 255)] {
        let mut bad = bytes;
        bad[at] = value;
        assert!(decode_picture(4, &bad[..n], &[1]).is_err());
    }
    assert!(decode_picture(5, &bytes[..n], &[1]).is_err());
    p.codec = "avc1.640028";
    p.still = false;
    p.rotation = 270;
    p.scale = 2.;
    let n = p.encode(&mut bytes)?;
    assert_eq!(decode_picture(4, &bytes[..n], &[1])?, p);
    p.codec = "vp8";
    let n = p.encode(&mut bytes)?;
    assert!(decode_picture(4, &bytes[..n], &[1]).is_err());
    Ok(())
}
#[test]
fn audio_rejects_invalid_rates_channels_text_and_lengths() -> Result<(), Box<dyn std::error::Error>>
{
    let mut a = Audio {
        sequence: 1.,
        timestamp: -1.,
        sample_rate: 48000,
        channels: 2,
        codec: "opus",
        thread_id: "t🌍",
        tab_id: None,
    };
    let mut bytes = [0; 1024];
    let n = a.encode(&mut bytes)?;
    assert_eq!(decode_audio(&bytes[..n], &[1])?, a);
    for end in 0..n {
        assert!(decode_audio(&bytes[..end], &[1]).is_err());
    }
    for (at, value) in [(16, 255), (20, 0), (21, 255), (22, 255)] {
        let mut bad = bytes;
        bad[at] = value;
        assert!(decode_audio(&bad[..n], &[1]).is_err());
    }
    a.sample_rate = 1;
    let n = a.encode(&mut bytes)?;
    assert!(decode_audio(&bytes[..n], &[1]).is_err());
    Ok(())
}

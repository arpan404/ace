// SPDX-License-Identifier: Apache-2.0
//! The Simulator transcode on VideoToolbox itself: serve-sim's records in, the viewer's frames
//! out.
use super::*;
use crate::serve_sim::{Record, Translator};
use media_codec::{CpuPicture, PixelFormat, Plane};
use media_vt::{PixelPool, VtEncoder, VtFormat, VtSurface};

type TestResult = Result<(), Box<dyn std::error::Error>>;

/// A moving pattern, so every frame differs as a scrolling app's do.
fn picture(size: Size, frame: u32) -> Result<CpuPicture, CodecError> {
    let (w, h) = (size.width as usize, size.height as usize);
    let luma = (0..w * h)
        .map(|i| (16 + ((i % w + i / w + frame as usize * 8) % 200)) as u8)
        .collect();
    let chroma = vec![128u8; w * h / 2];
    CpuPicture::new(
        size,
        PixelFormat::Nv12,
        [
            Plane {
                data: luma,
                stride: w,
            },
            Plane {
                data: chroma,
                stride: w,
            },
        ],
        u64::from(frame) * 16_667,
    )
}

/// serve-sim's stream: VideoToolbox H.264 at the Simulator's native size, as records.
fn serve_sim_records(
    size: Size,
    count: u32,
    keys: &[u32],
) -> Result<Vec<Record>, Box<dyn std::error::Error>> {
    let pool = PixelPool::new(size, VtFormat::Nv12, count as usize)?;
    let mut encoder = VtEncoder::new();
    encoder.configure(&Spec {
        codec: Codec::H264,
        size,
        fps: 60,
        rate: RateControl::Bitrate(12_000_000),
    })?;
    let mut units = Vec::new();
    for index in 0..count {
        let uploaded = pool.upload(&picture(size, index)?)?;
        let surface = VtSurface::of(&uploaded).ok_or(CodecError::NotConfigured)?;
        loop {
            match encoder.encode(
                surface.share().into_picture(u64::from(index) * 16_667)?,
                keys.contains(&index),
            ) {
                Err(CodecError::Backpressure) => {
                    while let Some(unit) = encoder.poll_result()? {
                        units.push(unit);
                    }
                    std::thread::yield_now();
                }
                other => break other?,
            }
        }
        while let Some(unit) = encoder.poll_result()? {
            units.push(unit);
        }
    }
    encoder.flush()?;
    while let Some(unit) = encoder.poll_result()? {
        units.push(unit);
    }
    let mut records = Vec::new();
    for unit in units {
        if let Some(description) = unit.description {
            records.push(Record::Description(description));
        }
        records.push(if unit.key {
            Record::Key(unit.data)
        } else {
            Record::Delta(unit.data)
        });
    }
    Ok(records)
}

#[test]
fn a_simulator_is_re_encoded_at_the_viewers_size_on_videotoolbox_without_a_copy() -> TestResult {
    let records = serve_sim_records(
        Size {
            width: 1206,
            height: 2622,
        },
        12,
        &[0],
    )?;
    let wire = EncodeSpec {
        id: 3,
        codec: "avc1.640033".into(),
        width: 588,
        height: 1280,
        fps: 60,
        bitrate: 4_000_000,
        quantizer: None,
    };
    let mut transcode = Transcode::new(&wire)?;
    let mut translator = Translator::default();
    let mut frames = Vec::new();
    let mut sent = 0;
    for (index, record) in records.into_iter().enumerate() {
        if matches!(record, Record::Description(_)) {
            translator.frame(record).map_err(|e| format!("{e:?}"))?;
            continue;
        }
        let Some(unit) = translator.source(&record, index as u64 * 16_667) else {
            continue;
        };
        sent += 1;
        // Moving pictures 16 ms apart: never still long enough to refresh.
        transcode.push(&unit, index as u64 * 16, &mut frames)?;
    }
    transcode.flush(&mut frames)?;
    assert_eq!(sent, 12);
    assert!(!frames.is_empty() && frames.len() <= 12);
    let first = &frames[0];
    assert_eq!(
        first.flags & 1,
        1,
        "the viewer's stream starts at a keyframe"
    );
    assert!(first.codec_string.starts_with("avc1."));
    assert_eq!(
        &first.payload[..4],
        &[0, 0, 0, 1],
        "Annex B, parameter sets first"
    );
    for frame in &frames {
        assert_eq!((frame.width, frame.height), (588, 1280));
        assert_eq!((frame.kind, frame.codec, frame.encode), (1, 1, 3));
    }
    let acceleration = transcode.acceleration();
    #[cfg(target_arch = "aarch64")]
    assert!(
        acceleration.steps.iter().all(|s| s.hardware),
        "decode, scale and encode on hardware"
    );
    assert!(
        acceleration
            .steps
            .iter()
            .all(|s| s.readbacks == 0 && s.uploads == 0),
        "no CPU copy"
    );
    Ok(())
}

#[test]
fn a_re_encode_that_starts_mid_stream_waits_for_the_next_keyframe() -> TestResult {
    // The viewer asked while serve-sim was between keyframes: deltas come first.
    let records = serve_sim_records(
        Size {
            width: 1206,
            height: 2622,
        },
        12,
        &[0, 6],
    )?;
    let wire = EncodeSpec {
        id: 1,
        codec: "avc1.640033".into(),
        width: 588,
        height: 1280,
        fps: 60,
        bitrate: 4_000_000,
        quantizer: None,
    };
    let mut transcode = Transcode::new(&wire)?;
    let mut translator = Translator::default();
    let mut frames = Vec::new();
    let mut seen_key = false;
    for (index, record) in records.into_iter().enumerate() {
        if matches!(record, Record::Description(_)) {
            translator.frame(record).map_err(|e| format!("{e:?}"))?;
            continue;
        }
        let Some(unit) = translator.source(&record, index as u64 * 16_667) else {
            continue;
        };
        // Skip the first keyframe: the re-encode joins at a delta.
        if unit.key && !seen_key {
            seen_key = true;
            continue;
        }
        transcode.push(&unit, index as u64 * 16, &mut frames)?;
    }
    transcode.flush(&mut frames)?;
    assert!(
        !frames.is_empty(),
        "it re-encodes from the second keyframe on"
    );
    assert_eq!(frames[0].flags & 1, 1);
    assert!(frames.len() <= 6);
    Ok(())
}

/// A still Simulator picture, re-encoded at the starved bitrate, gets one sharp keyframe
/// once it has been still ~300 ms: the refreshed keyframe is bigger (a lower quantizer)
/// than the first bitrate-starved one.
#[test]
fn a_still_pictures_refreshed_keyframe_is_sharper_than_its_first_starved_one() -> TestResult {
    let size = Size {
        width: 1206,
        height: 2622,
    };
    // Still serve-sim stream: the same picture, so every delta after the key is tiny.
    let pool = PixelPool::new(size, VtFormat::Nv12, 4)?;
    let still = picture(size, 0)?;
    let uploaded = pool.upload(&still)?;
    let surface = VtSurface::of(&uploaded).ok_or(CodecError::NotConfigured)?;
    let mut source = VtEncoder::new();
    source.configure(&Spec {
        codec: Codec::H264,
        size,
        fps: 5,
        rate: RateControl::Bitrate(12_000_000),
    })?;
    let mut units = Vec::new();
    for index in 0..6u32 {
        loop {
            match source.encode(
                surface.share().into_picture(u64::from(index) * 200_000)?,
                index == 0,
            ) {
                Err(CodecError::Backpressure) => {
                    while let Some(unit) = source.poll_result()? {
                        units.push(unit);
                    }
                    std::thread::yield_now();
                }
                other => break other?,
            }
        }
        while let Some(unit) = source.poll_result()? {
            units.push(unit);
        }
    }
    source.flush()?;
    while let Some(unit) = source.poll_result()? {
        units.push(unit);
    }
    assert!(
        units.iter().any(|u| u.key),
        "serve-sim starts at a keyframe"
    );

    let wire = EncodeSpec {
        id: 7,
        codec: "avc1.640033".into(),
        width: 588,
        height: 1280,
        fps: 60,
        bitrate: 4_000_000,
        quantizer: None,
    };
    let mut transcode = Transcode::new(&wire)?;
    let mut translator = Translator::default();
    let mut frames: Vec<MediaFrame> = Vec::new();
    // Feed at serve-sim's 5/s: keyframe + tiny deltas, 200 ms apart.
    let mut now_ms = 0u64;
    for (index, unit) in units.iter().enumerate() {
        let record = if unit.key {
            Record::Key(unit.data.clone())
        } else {
            Record::Delta(unit.data.clone())
        };
        if index == 0 {
            // Prime the translator with the description first.
            if let Some(description) = unit.description.clone() {
                let _ = translator.frame(Record::Description(description));
            }
        }
        let Some(source) = translator.source(&record, now_ms * 1_000) else {
            continue;
        };
        transcode.push(&source, now_ms, &mut frames)?;
        now_ms += 200;
    }
    let first_keys: Vec<usize> = frames
        .iter()
        .filter(|f| f.flags & 1 != 0)
        .map(|f| f.payload.len())
        .collect();
    assert!(
        !first_keys.is_empty(),
        "the starved first keyframe came out"
    );
    let first = first_keys[0];
    // Still for 400 ms more: one sharp refresh, then nothing further. VideoToolbox
    // encodes on its own threads, so the test pumps wall time until the keyframe lands.
    for _ in 0..2 {
        transcode.poll(now_ms, &mut frames)?;
        now_ms += 200;
    }
    let end = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while frames.iter().filter(|f| f.flags & 1 != 0).count() < 2 && std::time::Instant::now() < end
    {
        transcode.poll(now_ms, &mut frames)?;
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let keys: Vec<usize> = frames
        .iter()
        .filter(|f| f.flags & 1 != 0)
        .map(|f| f.payload.len())
        .collect();
    assert!(
        keys.len() >= 2,
        "a still picture is refreshed with another keyframe, got {}",
        keys.len()
    );
    assert!(
        keys[1] > first,
        "the refreshed keyframe ({} B) is bigger than the starved first ({} B)",
        keys[1],
        first
    );
    let before = keys.len();
    transcode.poll(now_ms + 1_000, &mut frames)?;
    assert_eq!(
        frames.iter().filter(|f| f.flags & 1 != 0).count(),
        before,
        "no second refresh without a new change"
    );
    Ok(())
}

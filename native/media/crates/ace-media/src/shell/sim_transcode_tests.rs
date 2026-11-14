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
fn serve_sim_records(size: Size, count: u32) -> Result<Vec<Record>, Box<dyn std::error::Error>> {
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
                index == 0,
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
        transcode.push(&unit, &mut frames)?;
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

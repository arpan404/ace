// SPDX-License-Identifier: Apache-2.0
//! The Simulator transcode on VideoToolbox itself: serve-sim's records in, the viewer's frames
//! out.
use super::*;
use crate::serve_sim::{Record, Translator};
use media_codec::{BitstreamFormat, CpuPicture, Decoder, PixelFormat, Plane};
use media_vt::{DecodeOutput, PixelPool, VtDecoder, VtEncoder, VtFormat, VtSurface, read_back};
use std::time::{Duration, Instant};

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

/// A still Simulator picture gets one sharp keyframe once it has been still ~300 ms:
/// the refreshed keyframe is bigger (a lower quantizer) than the first coarse one.
/// Small frames (390x844 target): the mechanism needs no full-size picture to prove.
/// Poll `encoder` until it has nothing left, or fail after `budget`.
/// Every wait on VideoToolbox output above is bounded and names what never arrived.
fn drain(
    encoder: &mut VtEncoder,
    units: &mut Vec<EncodedUnit>,
    budget: Duration,
    what: &str,
) -> TestResult {
    let end = Instant::now() + budget;
    loop {
        match encoder.poll_result()? {
            Some(unit) => units.push(unit),
            None => return Ok(()),
        }
        if Instant::now() >= end {
            return Err(format!("{what}: encoder output never drained").into());
        }
    }
}

/// Encode one picture, retrying past backpressure while draining, or fail after `budget`.
fn encode(
    encoder: &mut VtEncoder,
    surface: &VtSurface,
    pts_us: u64,
    key: bool,
    units: &mut Vec<EncodedUnit>,
    budget: Duration,
    what: &str,
) -> TestResult {
    let end = Instant::now() + budget;
    loop {
        match encoder.encode(surface.share().into_picture(pts_us)?, key) {
            Err(CodecError::Backpressure) => drain(encoder, units, budget, what)?,
            other => break other?,
        }
        if Instant::now() >= end {
            return Err(format!("{what}: encoder never took the picture").into());
        }
    }
    drain(encoder, units, budget, what)
}

#[test]
fn a_still_pictures_refreshed_keyframe_is_sharper_than_its_first_starved_one() -> TestResult {
    // Still serve-sim stream: the same picture, so every delta after the key is tiny.
    // Authored at the transcode target size, so the PSNR reference needs no scaling.
    let size = Size {
        width: 390,
        height: 844,
    };
    let pool = PixelPool::new(size, VtFormat::Nv12, 4)?;
    let still = picture(size, 0)?;
    let uploaded = pool.upload(&still)?;
    let surface = VtSurface::of(&uploaded).ok_or(CodecError::NotConfigured)?;
    let mut source = VtEncoder::new();
    source.configure(&Spec {
        codec: Codec::H264,
        size,
        fps: 5,
        rate: RateControl::Bitrate(4_000_000),
    })?;
    let mut units = Vec::new();
    for index in 0..4u32 {
        encode(
            &mut source,
            surface,
            u64::from(index) * 200_000,
            index == 0,
            &mut units,
            Duration::from_secs(20),
            "serve-sim source encode",
        )?;
    }
    // Explicit: finish what the source holds, then take everything it still has.
    source.flush()?;
    drain(
        &mut source,
        &mut units,
        Duration::from_secs(20),
        "serve-sim source flush",
    )?;
    assert!(
        units.iter().any(|u| u.key),
        "serve-sim starts at a keyframe"
    );

    let wire = EncodeSpec {
        id: 7,
        codec: "avc1.640033".into(),
        width: 390,
        height: 844,
        fps: 60,
        bitrate: 2_000_000,
        quantizer: None,
    };
    let mut transcode = Transcode::new(&wire)?;
    let mut translator = Translator::default();
    let mut frames: Vec<MediaFrame> = Vec::new();
    // Feed keyframe + two tiny deltas at serve-sim's 5/s, 200 ms apart. The refresh may
    // already fire on the last of these (still 300 ms), which is fine: the pump below
    // only waits for what has not landed yet.
    let mut now_ms = 0u64;
    for (index, unit) in units.iter().enumerate().take(3) {
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
    // VideoToolbox delivers on its own threads: pump (bounded) until the first keyframe
    // lands instead of assuming it is already here.
    let end = Instant::now() + Duration::from_secs(10);
    while !frames.iter().any(|f| f.flags & 1 != 0) {
        if Instant::now() >= end {
            return Err("transcode: the first keyframe never came out".into());
        }
        transcode.poll(now_ms, &mut frames)?;
        std::thread::sleep(Duration::from_millis(5));
    }
    // Still past 300 ms: one sharp refresh IDR. Pump (bounded) until it lands.
    let end = Instant::now() + Duration::from_secs(10);
    while transcode.refresh_avcc().is_none() {
        if Instant::now() >= end {
            return Err("still refresh: the sharp keyframe never came out".into());
        }
        transcode.poll(now_ms, &mut frames)?;
        now_ms += 50;
        std::thread::sleep(Duration::from_millis(5));
    }
    // Motion resumes: the next motion unit must be a forced IDR with the motion
    // session's own parameter sets, before any motion delta goes out.
    let Some(fourth) = units.get(3) else {
        return Err("serve-sim test stream has no fourth unit".into());
    };
    let record = if fourth.key {
        Record::Key(fourth.data.clone())
    } else {
        Record::Delta(fourth.data.clone())
    };
    let Some(source) = translator.source(&record, now_ms * 1_000) else {
        return Err("serve-sim test stream ran dry".into());
    };
    transcode.push(&source, now_ms, &mut frames)?;
    let end = Instant::now() + Duration::from_secs(10);
    while frames.iter().filter(|f| f.flags & 1 != 0).count() < 3 {
        if Instant::now() >= end {
            return Err("motion re-key: the post-refresh IDR never came out".into());
        }
        transcode.poll(now_ms, &mut frames)?;
        std::thread::sleep(Duration::from_millis(5));
    }
    let keys: Vec<&MediaFrame> = frames.iter().filter(|f| f.flags & 1 != 0).collect();
    assert_eq!(
        keys.len(),
        3,
        "first keyframe, one refresh IDR, one motion re-key, got {}",
        keys.len()
    );
    // The refresh IDR carries its own parameter sets, decodes, and is sharper (luma PSNR
    // against the source) than the starved first keyframe. Bytes alone prove nothing
    // about sharpness.
    let Some(refresh_avcc) = transcode.refresh_avcc() else {
        return Err("still refresh: no parameter sets came out with the refresh IDR".into());
    };
    let Some(motion_avcc) = transcode.motion_avcc() else {
        return Err("transcode: no parameter sets came out with the first keyframe".into());
    };
    assert_eq!(
        &keys[1].payload[..4],
        &[0, 0, 0, 1],
        "the refresh IDR carries parameter sets in band"
    );
    assert_eq!(
        keys[1].payload[4] & 0x1f,
        7,
        "the refresh IDR starts with an SPS"
    );
    let first_psnr = decode_psnr(&motion_avcc, &keys[0].payload, &still)?;
    let refresh_psnr = decode_psnr(&refresh_avcc, &keys[1].payload, &still)?;
    assert!(
        refresh_psnr > first_psnr + 2.0,
        "the refresh IDR ({refresh_psnr:.1} dB) is sharper than the starved first keyframe ({first_psnr:.1} dB)"
    );
    // The motion re-key decodes under the motion session's own parameter sets again:
    // the decoder is back on the motion session before any delta goes out.
    let rekey_psnr = decode_psnr(&motion_avcc, &keys[2].payload, &still)?;
    assert!(
        rekey_psnr > 25.0,
        "the motion re-key decodes to a sane picture ({rekey_psnr:.1} dB)"
    );
    // Pump briefly so a late duplicate would have landed, then require nothing further.
    let quiet = Instant::now() + Duration::from_millis(500);
    while Instant::now() < quiet {
        transcode.poll(now_ms + 1_000, &mut frames)?;
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        frames.iter().filter(|f| f.flags & 1 != 0).count(),
        3,
        "no second refresh and no stray keyframe without a new change"
    );
    Ok(())
}

/// Decode one Annex B IDR with its avcC and report luma PSNR against `source`.
/// VideoToolbox decodes synchronously: the picture is back when this returns.
fn decode_psnr(
    avcc: &[u8],
    annexb: &[u8],
    source: &CpuPicture,
) -> Result<f64, Box<dyn std::error::Error>> {
    let avcc_data = annexb_to_avcc(annexb)?;
    let unit = EncodedUnit {
        codec: Codec::H264,
        size: source.size(),
        format: BitstreamFormat::Avcc,
        data: avcc_data,
        key: true,
        description: Some(avcc.to_vec()),
        pts_us: 0,
        duration_us: 0,
    };
    let mut decoder = VtDecoder::new(DecodeOutput::default());
    let Some(picture) = decoder.decode(&unit)? else {
        return Err("decode: the decoder held back the IDR".into());
    };
    let decoded = read_back(&picture)?;
    luma_psnr(source, &decoded)
}

/// Annex B (00 00 01 / 00 00 00 01 start codes) to length-prefixed Avcc.
fn annexb_to_avcc(payload: &[u8]) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut units: Vec<&[u8]> = Vec::new();
    let mut i = 0;
    let mut nal_start: Option<usize> = None;
    while i < payload.len() {
        let rest = &payload[i..];
        let four = rest.len() >= 4 && rest[..4] == [0, 0, 0, 1];
        let three = rest.len() >= 3 && rest[..3] == [0, 0, 1];
        if four || three {
            if let Some(s) = nal_start.take() {
                if s < i {
                    units.push(&payload[s..i]);
                }
            }
            i += if four { 4 } else { 3 };
            nal_start = Some(i);
        } else {
            i += 1;
        }
    }
    if let Some(s) = nal_start {
        if s < payload.len() {
            units.push(&payload[s..]);
        }
    }
    if units.is_empty() {
        return Err("decode: no NAL units in the keyframe".into());
    }
    let mut out = Vec::new();
    for u in units {
        out.extend_from_slice(&(u.len() as u32).to_be_bytes());
        out.extend_from_slice(u);
    }
    Ok(out)
}

/// Luma PSNR in dB between same-size NV12 pictures.
fn luma_psnr(source: &CpuPicture, decoded: &CpuPicture) -> Result<f64, Box<dyn std::error::Error>> {
    if source.size() != decoded.size() || decoded.format() != PixelFormat::Nv12 {
        return Err("decode: decoded picture differs in size or layout".into());
    }
    let (w, h) = (source.size().width as usize, source.size().height as usize);
    let (a, b) = (&source.planes()[0], &decoded.planes()[0]);
    let mut error = 0f64;
    for y in 0..h {
        for x in 0..w {
            let d = f64::from(a.data[y * a.stride + x]) - f64::from(b.data[y * b.stride + x]);
            error += d * d;
        }
    }
    let mse = error / (w * h) as f64;
    Ok(if mse == 0.0 {
        99.0
    } else {
        10.0 * (255.0 * 255.0 / mse).log10()
    })
}

/// The refresh path never reconfigures the motion session: its applied rate control stays
/// the planned bitrate before and after a refresh.
#[test]
fn a_refresh_leaves_the_motion_sessions_rate_control_alone() -> TestResult {
    let size = Size {
        width: 480,
        height: 960,
    };
    let pool = PixelPool::new(size, VtFormat::Nv12, 2)?;
    let still = picture(size, 0)?;
    let uploaded = pool.upload(&still)?;
    let surface = VtSurface::of(&uploaded).ok_or(CodecError::NotConfigured)?;
    let mut source = VtEncoder::new();
    source.configure(&Spec {
        codec: Codec::H264,
        size,
        fps: 5,
        rate: RateControl::Bitrate(2_000_000),
    })?;
    let mut units = Vec::new();
    for index in 0..3u32 {
        encode(
            &mut source,
            surface,
            u64::from(index) * 200_000,
            index == 0,
            &mut units,
            Duration::from_secs(20),
            "serve-sim source encode",
        )?;
    }
    source.flush()?;
    drain(
        &mut source,
        &mut units,
        Duration::from_secs(20),
        "serve-sim source flush",
    )?;

    let wire = EncodeSpec {
        id: 9,
        codec: "avc1.640033".into(),
        width: 240,
        height: 480,
        fps: 30,
        bitrate: 1_000_000,
        quantizer: None,
    };
    let mut transcode = Transcode::new(&wire)?;
    assert_eq!(
        transcode.motion_spec().rate,
        RateControl::Bitrate(1_000_000),
        "motion opens in bitrate mode, not quantizer mode"
    );
    let mut translator = Translator::default();
    let mut frames = Vec::new();
    let mut now_ms = 0u64;
    for (index, unit) in units.iter().enumerate() {
        let record = if unit.key {
            Record::Key(unit.data.clone())
        } else {
            Record::Delta(unit.data.clone())
        };
        if index == 0 {
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
    // Pump (bounded) until the refresh IDR lands.
    let end = Instant::now() + Duration::from_secs(10);
    while transcode.refresh_avcc().is_none() {
        if Instant::now() >= end {
            return Err("refresh: the IDR never came out".into());
        }
        transcode.poll(now_ms, &mut frames)?;
        now_ms += 50;
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        transcode.motion_spec().rate,
        RateControl::Bitrate(1_000_000),
        "the refresh never reconfigures the motion session"
    );
    Ok(())
}

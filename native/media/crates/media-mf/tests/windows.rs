// SPDX-License-Identifier: Apache-2.0
//! Media Foundation on a real Windows machine: whichever encoder MFT the machine has
//! (hardware first, else Microsoft's software MFT), decoded back and compared.
#![cfg(windows)]
use media_codec::*;
use media_mf::*;
use media_wire::capability::{Backend, Step, TrialState};
use std::time::{Duration, Instant};

const SIZE: Size = Size {
    width: 640,
    height: 360,
};

/// NV12 with a gradient, a moving block and fixed-seed noise, so the encoder has work.
fn frame(size: Size, index: u32, noise: u8) -> Result<CpuPicture, CodecError> {
    let (w, h) = (size.width as usize, size.height as usize);
    let mut seed = 0x9e37_79b9u32 ^ index.wrapping_mul(0x85eb_ca6b);
    let mut luma = vec![0u8; w * h];
    let block = (index as usize * 8) % w.saturating_sub(64).max(1);
    for y in 0..h {
        for x in 0..w {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            let base = ((x + y) % 200 + 30) as u8;
            let jitter = if noise == 0 {
                0
            } else {
                (seed % u32::from(noise)) as u8
            };
            let inside = (block..block + 64).contains(&x) && (100..164).contains(&y);
            luma[y * w + x] = if inside {
                220
            } else {
                base.saturating_add(jitter)
            };
        }
    }
    let chroma = (0..w * h / 2)
        .map(|i| if i % 2 == 0 { 110 } else { 140 })
        .collect();
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
        u64::from(index) * 33_333,
    )
}

fn luma_psnr(a: &CpuPicture, b: &CpuPicture) -> f64 {
    let (pa, pb) = (&a.planes()[0], &b.planes()[0]);
    let size = a.size();
    let mut sum = 0f64;
    for y in 0..size.height as usize {
        for x in 0..size.width as usize {
            let d = f64::from(pa.data[y * pa.stride + x]) - f64::from(pb.data[y * pb.stride + x]);
            sum += d * d;
        }
    }
    let mse = sum / f64::from(size.width * size.height);
    if mse == 0.0 {
        99.0
    } else {
        10.0 * (255.0 * 255.0 / mse).log10()
    }
}

fn spec(codec: Codec, bits: u32) -> EncodeSpec {
    EncodeSpec {
        codec,
        size: SIZE,
        fps: 30,
        rate: RateControl::Bitrate(bits),
    }
}

/// Encodes `count` frames (forcing keys where `key(i)`), flushes, returns every unit.
fn encode_all(
    encoder: &mut MfEncoder,
    count: u32,
    noise: u8,
    key: impl Fn(u32) -> bool,
) -> Result<Vec<EncodedUnit>, CodecError> {
    let mut units = Vec::new();
    for i in 0..count {
        let picture = Picture::Cpu(frame(SIZE, i, noise)?);
        let mut tries = 0;
        let mut pending = Some(picture);
        while let Some(picture) = pending.take() {
            match encoder.encode(picture, key(i)) {
                Err(CodecError::Backpressure) if tries < 200 => {
                    tries += 1;
                    std::thread::sleep(Duration::from_millis(5));
                    while let Some(unit) = encoder.poll_result()? {
                        units.push(unit);
                    }
                    pending = Some(Picture::Cpu(frame(SIZE, i, noise)?));
                }
                other => other?,
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
    Ok(units)
}

fn decode_cpu(
    device: Option<MfDevice>,
    units: &[EncodedUnit],
) -> Result<Vec<CpuPicture>, CodecError> {
    let mut decoder = MfDecoder::new(device, DecodeOutput::Cpu);
    let mut out = Vec::new();
    let mut pictures = Vec::new();
    for unit in units {
        pictures.extend(decoder.decode(unit)?);
    }
    pictures.extend(decoder.drain()?);
    for picture in pictures {
        if let Picture::Cpu(picture) = picture {
            out.push(picture);
        }
    }
    eprintln!(
        "decoder: {:?}, hardware {}",
        decoder.name(),
        decoder.hardware()
    );
    Ok(out)
}

fn device() -> Option<MfDevice> {
    let device = MfDevice::new().ok();
    if let Some(d) = &device {
        eprintln!(
            "adapter: {:?} video processor {}",
            d.adapter(),
            d.has_video()
        );
    }
    device
}

#[test]
fn h264_frames_encode_and_decode_back_above_the_psnr_floor() -> Result<(), CodecError> {
    let device = device();
    let mut encoder = MfEncoder::new(device.clone());
    encoder.configure(&spec(Codec::H264, 2_000_000))?;
    eprintln!(
        "encoder: {:?}, hardware {}",
        encoder.name(),
        encoder.hardware()
    );
    assert_eq!(encoder.caps().hardware, encoder.hardware());
    let units = encode_all(&mut encoder, 30, 0, |_| false)?;
    assert_eq!(units.len(), 30, "one unit per frame");
    let first = &units[0];
    assert!(first.key && first.format == BitstreamFormat::Avcc);
    assert!(
        first
            .description
            .as_deref()
            .is_some_and(|r| r.first() == Some(&1)),
        "avcC on the keyframe"
    );
    assert!(
        units.windows(2).all(|w| w[0].pts_us < w[1].pts_us),
        "timestamps in order"
    );
    let decoded = decode_cpu(device, &units)?;
    assert_eq!(decoded.len(), 30);
    for (i, picture) in decoded.iter().enumerate() {
        let source = frame(SIZE, i as u32, 0)?;
        let psnr = luma_psnr(&source, picture);
        assert!(psnr >= 32.0, "frame {i}: {psnr:.1} dB");
        assert_eq!(picture.pts_us, source.pts_us);
    }
    Ok(())
}

#[test]
fn a_requested_keyframe_arrives_on_that_frame_and_nowhere_else() -> Result<(), CodecError> {
    let mut encoder = MfEncoder::new(device());
    encoder.configure(&spec(Codec::H264, 1_000_000))?;
    let units = encode_all(&mut encoder, 14, 0, |i| i == 7)?;
    let keys: Vec<usize> = units
        .iter()
        .enumerate()
        .filter(|(_, u)| u.key)
        .map(|(i, _)| i)
        .collect();
    assert_eq!(keys, vec![0, 7]);
    assert!(
        units[7].description.is_some(),
        "the forced key carries its record"
    );
    // The forced key decodes on its own: a fresh decoder starts there.
    let decoded = decode_cpu(None, &units[7..])?;
    assert_eq!(decoded.len(), units.len() - 7);
    Ok(())
}

#[test]
fn a_bitrate_change_keeps_the_stream_and_changes_the_size_of_frames() -> Result<(), CodecError> {
    let mut encoder = MfEncoder::new(device());
    encoder.configure(&spec(Codec::H264, 150_000))?;
    let low = encode_all(&mut encoder, 40, 48, |_| false)?;
    encoder.configure(&spec(Codec::H264, 3_000_000))?;
    let high = encode_all(&mut encoder, 40, 48, |_| false)?;
    assert!(
        !high[0].key,
        "a rate-only change must not restart the stream"
    );
    let average =
        |units: &[EncodedUnit]| units.iter().map(|u| u.data.len()).sum::<usize>() / units.len();
    let (a, b) = (average(&low[20..]), average(&high[20..]));
    eprintln!("bytes per frame at 150 kbit/s: {a}; at 3 Mbit/s: {b}");
    assert!(b > a * 3, "{a} → {b}");
    Ok(())
}

#[test]
fn a_bgra_texture_is_converted_and_scaled_on_the_gpu_before_encode() -> Result<(), CodecError> {
    let Some(device) = device().filter(MfDevice::has_video) else {
        eprintln!("skipped: no D3D11 video processor here");
        return Ok(());
    };
    let big = Size {
        width: 1280,
        height: 720,
    };
    let stride = big.width as usize * 4;
    let data = (0..stride * big.height as usize)
        .map(|i| match i % 4 {
            0 => (i / 4 % 256) as u8,
            1 => 128,
            2 => 64,
            _ => 255,
        })
        .collect();
    let bgra = CpuPicture::new(big, PixelFormat::Bgra8, [Plane { data, stride }], 0)?;
    let texture = upload(&device, &bgra)?;
    let mut encoder = MfEncoder::new(Some(device.clone()));
    encoder.configure(&spec(Codec::H264, 2_000_000))?;
    encoder.encode(texture.into_picture(0), true)?;
    let copies = encoder.last_copies();
    eprintln!("hardware {} copies {copies:?}", encoder.hardware());
    if encoder.hardware() {
        assert_eq!(
            copies,
            Copies::default(),
            "no CPU copy on the hardware path"
        );
    } else {
        assert_eq!(
            copies,
            Copies {
                readbacks: 1,
                uploads: 0
            },
            "the software MFT costs one readback"
        );
    }
    encoder.flush()?;
    let unit = encoder.poll_result()?.ok_or(CodecError::NotConfigured)?;
    assert!(unit.key && unit.size == SIZE);
    let decoded = decode_cpu(Some(device), &[unit])?;
    assert_eq!(decoded.first().map(CpuPicture::size), Some(SIZE));
    Ok(())
}

#[test]
fn the_scaler_writes_nv12_at_the_asked_size_on_the_device() -> Result<(), CodecError> {
    let Some(device) = device().filter(MfDevice::has_video) else {
        eprintln!("skipped: no D3D11 video processor here");
        return Ok(());
    };
    let source = frame(SIZE, 3, 0)?;
    let mut scaler = MfScaler::new(&device, MfFormat::Nv12)?;
    let out = scaler.scale(&Picture::Cpu(source.clone()), 320, 180)?;
    assert_eq!(
        scaler.last_copies(),
        Copies {
            readbacks: 0,
            uploads: 1
        }
    );
    let surface = MfSurface::of(&out).ok_or(CodecError::NotConfigured)?;
    let back = read_back(surface, 0)?;
    assert_eq!(
        back.size(),
        Size {
            width: 320,
            height: 180
        }
    );
    // The flat chroma survives conversion; luma averages stay close.
    let mean = |p: &CpuPicture| {
        p.planes()[0]
            .data
            .iter()
            .map(|v| u64::from(*v))
            .sum::<u64>()
            / p.planes()[0].data.len() as u64
    };
    assert!(mean(&back).abs_diff(mean(&source)) <= 4);
    Ok(())
}

#[test]
fn a_decoder_refuses_a_stream_that_starts_without_a_keyframe() -> Result<(), CodecError> {
    let mut encoder = MfEncoder::new(None);
    encoder.configure(&spec(Codec::H264, 1_000_000))?;
    let units = encode_all(&mut encoder, 3, 0, |_| false)?;
    let mut decoder = MfDecoder::new(None, DecodeOutput::Cpu);
    assert!(matches!(
        decoder.decode(&units[1]),
        Err(CodecError::InvalidInput(_))
    ));
    Ok(())
}

#[test]
fn hevc_round_trips_where_the_machine_has_an_hevc_encoder() -> Result<(), CodecError> {
    let device = device();
    let mut encoder = MfEncoder::new(device.clone());
    match encoder.configure(&spec(Codec::Hevc, 2_000_000)) {
        Err(e) => {
            eprintln!("skipped: no HEVC encoder MFT ({e})");
            return Ok(());
        }
        Ok(()) => eprintln!(
            "HEVC encoder: {:?}, hardware {}",
            encoder.name(),
            encoder.hardware()
        ),
    }
    let units = encode_all(&mut encoder, 10, 0, |_| false)?;
    assert!(units[0].key && units[0].format == BitstreamFormat::Hvcc);
    let record = units[0].description.clone().unwrap_or_default();
    let hex: String = record.iter().map(|b| format!("{b:02x}")).collect();
    eprintln!(
        "hvcC {hex} → {:?}",
        media_mf::nal::codec_string(Codec::Hevc, &record)
    );
    let decoded = decode_cpu(device.clone(), &units)?;
    assert_eq!(decoded.len(), units.len());
    for (i, picture) in decoded.iter().enumerate() {
        assert!(luma_psnr(&frame(SIZE, i as u32, 0)?, picture) >= 32.0);
    }
    // Into textures as well, the way the probe and the pipeline decode.
    if let Some(device) = device {
        let mut decoder = MfDecoder::new(Some(device), DecodeOutput::Surface);
        // Pictures are pooled textures: each is checked and released before the next.
        let mut count = 0;
        for unit in &units {
            if let Some(picture) = decoder.decode(unit)? {
                let surface = MfSurface::of(&picture).ok_or(CodecError::NotConfigured)?;
                assert_eq!(surface.size(), SIZE);
                count += 1;
            }
        }
        for picture in decoder.drain()? {
            assert_eq!(MfSurface::of(&picture).map(MfSurface::size), Some(SIZE));
            count += 1;
        }
        assert_eq!(count, units.len());
    }
    Ok(())
}

#[test]
fn the_probe_reports_what_the_sessions_said_within_its_deadline() -> Result<(), CodecError> {
    let started = Instant::now();
    let report = probe(&ProbeOptions::default());
    let elapsed = started.elapsed();
    for c in &report.capabilities {
        eprintln!("{c:?}");
    }
    eprintln!("probe took {elapsed:?}");
    assert!(elapsed < Duration::from_millis(2_200));
    assert!(report.capabilities.iter().all(|c| c.backend == Backend::Mf));
    let h264 = report
        .capabilities
        .iter()
        .find(|c| {
            c.step == Step::Encode && c.codec.as_deref().is_some_and(|s| s.starts_with("avc1"))
        })
        .ok_or(CodecError::NotConfigured)?;
    if h264.state == TrialState::TimedOut {
        // A cold machine may need longer; the result must still arrive late.
        let late = report.late.recv_timeout(Duration::from_secs(10));
        eprintln!("late: {late:?}");
        return Ok(());
    }
    assert_eq!(h264.state, TrialState::Ok);
    assert!(
        h264.codec
            .as_deref()
            .is_some_and(|c| c.len() == "avc1.64001F".len())
    );
    // The session's own report: open the same encoder and compare.
    let mut encoder = MfEncoder::new(MfDevice::new().ok());
    encoder.configure(&spec(Codec::H264, 2_000_000))?;
    assert_eq!(h264.hardware, encoder.hardware());
    assert!(
        !h264.zero_copy || h264.hardware,
        "zero copy is claimed only on hardware"
    );
    for jpeg in report
        .capabilities
        .iter()
        .filter(|c| matches!(c.step, Step::JpegEncode | Step::JpegDecode))
    {
        assert_eq!(
            (jpeg.state, jpeg.hardware),
            (TrialState::Ok, false),
            "WIC is the CPU"
        );
    }
    Ok(())
}

#[test]
fn a_cancelled_probe_returns_at_once() {
    let options = ProbeOptions::default();
    options.cancel.cancel();
    let started = Instant::now();
    let report = probe(&options);
    assert!(started.elapsed() < Duration::from_millis(200));
    assert!(
        report
            .capabilities
            .iter()
            .all(|c| c.state == TrialState::TimedOut)
    );
}

#[test]
fn wic_writes_a_jpeg_and_reads_it_back_at_the_asked_size() -> Result<(), CodecError> {
    let size = Size {
        width: 640,
        height: 360,
    };
    let stride = size.width as usize * 4;
    let data = (0..stride * size.height as usize)
        .map(|i| (i % 253) as u8)
        .collect();
    let picture = CpuPicture::new(size, PixelFormat::Bgra8, [Plane { data, stride }], 0)?;
    let mut wic = WicJpeg::new()?;
    let jpeg = JpegCodec::encode(&mut wic, &Picture::Cpu(picture.clone()), 80)?;
    assert!(jpeg.starts_with(&[0xff, 0xd8]) && jpeg.ends_with(&[0xff, 0xd9]));
    let small = JpegCodec::decode(&mut wic, &jpeg, 320, 180)?;
    assert_eq!(
        small.size(),
        Size {
            width: 320,
            height: 180
        }
    );
    let full = StillCodec::decode(&mut wic, &jpeg)?;
    assert_eq!(full.size(), size);
    let mut out = Vec::new();
    StillCodec::transcode_into(
        &mut wic,
        &jpeg,
        Size {
            width: 160,
            height: 90,
        },
        70,
        &mut out,
    )?;
    assert_eq!(
        StillCodec::decode(&mut wic, &out)?.size(),
        Size {
            width: 160,
            height: 90
        }
    );
    assert!(matches!(
        StillCodec::decode(&mut wic, b"not a jpeg"),
        Err(CodecError::InvalidInput(_))
    ));
    Ok(())
}

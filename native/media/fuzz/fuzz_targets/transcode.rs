// SPDX-License-Identifier: Apache-2.0
//! Arbitrary bytes through the CPU still path on one long-lived codec. The
//! first byte picks targets and quality; the rest is the JPEG. Checks:
//! no panics; any accepted stream is also accepted by zune-jpeg; output is a
//! JPEG of exactly the target size; repeating a transcode after others gives
//! identical bytes (no stale state); and luma stays close to zune-jpeg's.
#![no_main]
use libfuzzer_sys::fuzz_target;
use media_codec::{CpuJpegCodec, CpuPicture, CpuScaler, Picture, Scaler, Size, StillCodec};
use std::cell::RefCell;
use zune_core::{bytestream::ZCursor, colorspace::ColorSpace, options::DecoderOptions};
use zune_jpeg::JpegDecoder;

thread_local! {
    static CODEC: RefCell<CpuJpegCodec> = RefCell::new(CpuJpegCodec::default());
}

fn zune(jpeg: &[u8], space: ColorSpace) -> Option<(Size, Vec<u8>)> {
    let options = DecoderOptions::default()
        .set_max_width(8192)
        .set_max_height(8192)
        .jpeg_set_out_colorspace(space);
    let mut decoder = JpegDecoder::new_with_options(ZCursor::new(jpeg), options);
    decoder.decode_headers().ok()?;
    let info = decoder.info()?;
    let size = Size {
        width: u32::from(info.width),
        height: u32::from(info.height),
    };
    Some((size, decoder.decode().ok()?))
}

/// zune-jpeg's luma at full size, one byte per pixel, where it can give YCbCr.
fn reference(jpeg: &[u8]) -> Option<(Size, Vec<u8>)> {
    // Grayscale streams only decode to luma.
    let (size, pixels) = zune(jpeg, ColorSpace::YCbCr).or_else(|| zune(jpeg, ColorSpace::Luma))?;
    let area = size.width as usize * size.height as usize;
    let luma = match pixels.len() / area.max(1) {
        1 => pixels,
        3 => pixels.chunks_exact(3).map(|p| p[0]).collect(),
        _ => return None,
    };
    (luma.len() == area).then_some((size, luma))
}

/// The first frame header and scan header, found by walking segments.
struct Headers<'a> {
    sof_marker: u8,
    sof: &'a [u8],
    sos: &'a [u8],
    /// Extra 0xFF fill bytes appeared before some marker.
    fill: bool,
}
fn headers(jpeg: &[u8]) -> Option<Headers<'_>> {
    let mut pos = 2;
    let mut fill = false;
    let mut sof = None;
    loop {
        if *jpeg.get(pos)? != 0xFF {
            return None;
        }
        while jpeg.get(pos + 1) == Some(&0xFF) {
            fill = true;
            pos += 1;
        }
        let marker = *jpeg.get(pos + 1)?;
        pos += 2;
        if matches!(marker, 0x01 | 0xD0..=0xD7) {
            continue;
        }
        let len = usize::from(u16::from_be_bytes([*jpeg.get(pos)?, *jpeg.get(pos + 1)?]));
        let body = jpeg.get(pos + 2..pos + len.max(2))?;
        if sof.is_none() && matches!(marker, 0xC0..=0xCF) && !matches!(marker, 0xC4 | 0xC8 | 0xCC) {
            sof = Some((marker, body));
        }
        if marker == 0xDA {
            let (sof_marker, sof) = sof?;
            return Some(Headers {
                sof_marker,
                sof,
                sos: body,
                fill,
            });
        }
        pos += len.max(2);
    }
}
fn sampling(h: &Headers<'_>) -> Vec<u8> {
    let count = usize::from(*h.sof.get(5).unwrap_or(&0));
    (0..count)
        .filter_map(|i| h.sof.get(7 + i * 3).copied())
        .collect()
}

/// Pixels are compared only for streams the strict baseline decoder owns:
/// 8-bit SOF0/SOF1, one or three components, one full-spectrum interleaved
/// scan. Fallback streams decode through zune-jpeg itself, whose lenient
/// handling of damage differs between its RGB and YCbCr outputs. zune-jpeg 0.5
/// also misreads frames whose first component is not the most finely sampled.
fn luma_comparable(jpeg: &[u8]) -> bool {
    let Some(h) = headers(jpeg) else {
        return false;
    };
    let factors = sampling(&h);
    let count = factors.len();
    if !matches!(h.sof_marker, 0xC0 | 0xC1)
        || h.sof.first() != Some(&8)
        || (count != 1 && count != 3)
    {
        return false;
    }
    let ns = usize::from(*h.sos.first().unwrap_or(&0));
    if ns != count || h.sos.get(1 + ns * 2..4 + ns * 2) != Some(&[0, 63, 0]) {
        return false;
    }
    let first = factors.first().copied().unwrap_or(0);
    factors
        .iter()
        .all(|f| f >> 4 <= first >> 4 && f & 15 <= first & 15)
}

/// Valid streams zune-jpeg 0.5 cannot read, all of which libjpeg decodes:
/// fill bytes (extra 0xFF) before a header marker (T.81 B.1.1.2) and sampling
/// factors that are not powers of two (legal 1..=4, including 3).
fn zune_supports(jpeg: &[u8]) -> bool {
    let Some(h) = headers(jpeg) else {
        return true;
    };
    !h.fill
        && sampling(&h)
            .iter()
            .all(|f| (f >> 4).is_power_of_two() && (f & 15).is_power_of_two())
}

fn mean_error(a: &[u8], b: &[u8]) -> f64 {
    let total: u64 = a
        .iter()
        .zip(b)
        .map(|(x, y)| u64::from(x.abs_diff(*y)))
        .sum();
    total as f64 / a.len().max(1) as f64
}

fuzz_target!(|data: &[u8]| {
    let Some((&selector, jpeg)) = data.split_first() else {
        return;
    };
    // Odd selectors compare pixels at high quality; even ones vary the tables.
    let quality = if selector & 1 == 1 {
        95
    } else {
        40 + selector % 60
    };
    let source = media_codec::jpeg_size(jpeg).ok();
    let mut targets = vec![Size {
        width: 1 + u32::from(selector % 47),
        height: 1 + u32::from(selector / 5),
    }];
    if let Some(s) = source {
        if u64::from(s.width) * u64::from(s.height) <= 1 << 20 {
            targets.push(s);
            targets.push(Size {
                width: s.width.div_ceil(3),
                height: s.height.div_ceil(3),
            });
        }
    }
    CODEC.with(|codec| {
        let mut codec = codec.borrow_mut();
        let mut first: Option<Vec<u8>> = None;
        for (i, &target) in targets.iter().chain(targets.first()).enumerate() {
            let mut out = Vec::new();
            if codec
                .transcode_into(jpeg, target, quality, &mut out)
                .is_err()
            {
                continue;
            }
            if i == 0 {
                first = Some(out.clone());
            } else if i == targets.len() {
                // Same input and target again, after other work: same bytes.
                assert_eq!(
                    first.as_deref(),
                    Some(out.as_slice()),
                    "transcode is not repeatable"
                );
            }
            let (out_size, out_pixels) = reference(&out).expect("output is not a decodable JPEG");
            assert_eq!(out_size, target, "output size");
            if !zune_supports(jpeg) {
                continue;
            }
            assert!(
                zune(jpeg, ColorSpace::RGB).is_some(),
                "accepted a stream zune-jpeg rejects"
            );
            if quality != 95 || !luma_comparable(jpeg) {
                continue;
            }
            let Some((in_size, in_luma)) = reference(jpeg) else {
                continue;
            };
            // Luma only: 4:2:0 output legitimately drops chroma detail.
            let grey: Vec<u8> = in_luma.iter().flat_map(|v| [*v; 3]).collect();
            let Ok(picture) = CpuPicture::new(
                in_size,
                media_codec::PixelFormat::Rgb8,
                [media_codec::Plane {
                    data: grey,
                    stride: in_size.width as usize * 3,
                }],
                0,
            ) else {
                continue;
            };
            let Ok(Picture::Cpu(expected)) =
                CpuScaler::default().scale(&Picture::Cpu(picture), target.width, target.height)
            else {
                continue;
            };
            let expected: Vec<u8> = expected.planes()[0]
                .data
                .chunks_exact(3)
                .map(|p| p[0])
                .collect();
            let error = mean_error(&out_pixels, &expected);
            assert!(
                error < 24.0,
                "mean luma error {error:.1} against zune-jpeg at {target:?}"
            );
        }
        let _ = StillCodec::decode(&mut *codec, jpeg);
    });
});

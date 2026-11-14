// SPDX-License-Identifier: Apache-2.0
#![cfg(target_os = "macos")]
mod support;
use media_codec::*;
use media_vt::{Copies, VtFormat, VtJpeg, VtSurface};
use support::*;

#[test]
fn a_vt_jpeg_still_decodes_with_the_cpu_decoder_and_reports_its_session() -> TestResult {
    let size = Size {
        width: 1206,
        height: 2622,
    };
    let frames = Frames::new(size, 1)?;
    let mut jpeg = VtJpeg::new(VtFormat::Nv12);
    let hardware = jpeg.encode_hardware(size)?;
    let still = JpegCodec::encode(&mut jpeg, &frames.surfaces[0], 80)?;
    let path = jpeg.last_path();
    assert_eq!(
        path.hardware, hardware,
        "hardware is what the encode session reports"
    );
    let expected = if hardware {
        Copies::default()
    } else {
        Copies {
            readbacks: 1,
            uploads: 0,
        }
    };
    assert_eq!(path.copies, expected);
    let decoded = StillCodec::decode(&mut CpuJpegCodec::default(), &still)?;
    assert_eq!(decoded.size(), size);
    // The ramp runs dark (top left) to light (bottom right) in the source.
    let rgb = &decoded.planes()[0];
    let at = |x: usize, y: usize| {
        rgb.data[y * rgb.stride + x * 3..][..3]
            .iter()
            .map(|v| u32::from(*v))
            .sum::<u32>()
    };
    assert!(
        at(4, 4) + 60 < at(1200, 2600),
        "the decoded still keeps the source's ramp"
    );
    Ok(())
}

#[test]
fn jpeg_decode_lands_at_the_requested_size_on_the_reported_path() -> TestResult {
    let source = Size {
        width: 1206,
        height: 2622,
    };
    let rgb_stride = source.width as usize * 3;
    let rgb = CpuPicture::new(
        source,
        PixelFormat::Rgb8,
        [Plane {
            data: (0..rgb_stride * source.height as usize)
                .map(|i| (i % 251) as u8)
                .collect(),
            stride: rgb_stride,
        }],
        0,
    )?;
    let still = StillCodec::encode(&mut CpuJpegCodec::default(), &rgb, 80)?;
    let target = Size {
        width: 722,
        height: 1568,
    };
    let mut jpeg = VtJpeg::new(VtFormat::Bgra);
    let hardware = jpeg.decode_hardware(source, target)?;
    let picture = JpegCodec::decode(&mut jpeg, &still, target.width, target.height)?;
    assert_eq!(picture.size(), target);
    assert!(
        VtSurface::of(&picture).is_some(),
        "decoded stills stay in a CVPixelBuffer"
    );
    let path = jpeg.last_path();
    assert_eq!(
        path.hardware, hardware,
        "hardware is what the decode session reports"
    );
    let expected = if hardware {
        Copies::default()
    } else {
        Copies {
            readbacks: 0,
            uploads: 1,
        }
    };
    assert_eq!(path.copies, expected);
    Ok(())
}

#[test]
fn a_still_goes_from_hevc_to_jpeg_at_the_requested_box() -> TestResult {
    let source = Size {
        width: 1206,
        height: 2622,
    };
    let frames = Frames::new(source, 1)?;
    let mut encoder = media_vt::VtEncoder::new();
    encoder.configure(&EncodeSpec {
        codec: Codec::Hevc,
        size: source,
        fps: 60,
        rate: RateControl::Bitrate(8_000_000),
    })?;
    let units = encode_all(&mut encoder, &frames, 0..1, &[])?;
    let target = fit_size(
        source,
        Size {
            width: 1568,
            height: 1568,
        },
    )?;
    let mut decoder = media_vt::VtDecoder::new(media_vt::DecodeOutput {
        size: Some(target),
        format: VtFormat::Nv12,
    });
    let picture = decoder.decode(&units[0])?.ok_or("nothing decoded")?;
    let still = JpegCodec::encode(&mut VtJpeg::default(), &picture, 80)?;
    assert_eq!(jpeg_size(&still)?, target);
    Ok(())
}

#[test]
fn quality_outside_one_to_a_hundred_is_refused() -> TestResult {
    let frames = Frames::new(
        Size {
            width: 64,
            height: 64,
        },
        1,
    )?;
    let mut jpeg = VtJpeg::default();
    assert!(matches!(
        JpegCodec::encode(&mut jpeg, &frames.surfaces[0], 0),
        Err(CodecError::InvalidInput(_))
    ));
    assert!(matches!(
        JpegCodec::encode(&mut jpeg, &frames.surfaces[0], 101),
        Err(CodecError::InvalidInput(_))
    ));
    Ok(())
}

#[test]
fn without_hardware_jpeg_takes_one_readback_or_one_upload_and_no_session() -> TestResult {
    let size = Size {
        width: 320,
        height: 240,
    };
    // Mid-grey NV12 (video range): Y 126, Cb = Cr = 128.
    let grey = CpuPicture::new(
        size,
        PixelFormat::Nv12,
        [
            Plane {
                data: vec![126; 320 * 240],
                stride: 320,
            },
            Plane {
                data: vec![128; 320 * 120],
                stride: 320,
            },
        ],
        0,
    )?;
    let pool = media_vt::PixelPool::new(size, VtFormat::Nv12, 1)?;
    let surface = pool.upload(&grey)?;
    let mut jpeg = VtJpeg::without_hardware(VtFormat::Nv12);
    assert!(!jpeg.encode_hardware(size)?);
    let still = JpegCodec::encode(&mut jpeg, &surface, 90)?;
    assert_eq!(
        jpeg.last_path(),
        media_vt::JpegPath {
            hardware: false,
            copies: Copies {
                readbacks: 1,
                uploads: 0
            }
        }
    );
    let decoded = StillCodec::decode(&mut CpuJpegCodec::default(), &still)?;
    let pixel = &decoded.planes()[0].data[..3];
    assert!(
        pixel.iter().all(|v| (125..=131).contains(v)),
        "grey stays grey: {pixel:?}"
    );
    let picture = JpegCodec::decode(&mut jpeg, &still, 160, 120)?;
    assert_eq!(
        picture.size(),
        Size {
            width: 160,
            height: 120
        }
    );
    assert_eq!(
        jpeg.last_path(),
        media_vt::JpegPath {
            hardware: false,
            copies: Copies {
                readbacks: 0,
                uploads: 1
            }
        }
    );
    Ok(())
}

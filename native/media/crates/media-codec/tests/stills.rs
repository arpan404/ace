// SPDX-License-Identifier: Apache-2.0
use media_codec::*;
fn image(size: Size) -> Result<CpuPicture, CodecError> {
    let mut data = Vec::new();
    for y in 0..size.height {
        for x in 0..size.width {
            data.extend_from_slice(&[
                (x * 200 / size.width) as u8,
                (y * 200 / size.height) as u8,
                80,
            ]);
        }
    }
    CpuPicture::new(
        size,
        PixelFormat::Rgb8,
        vec![Plane {
            data,
            stride: size.width as usize * 3,
        }],
        123,
    )
}
fn cpu(p: Picture) -> Result<CpuPicture, CodecError> {
    match p {
        Picture::Cpu(p) => Ok(p),
        _ => Err(CodecError::Unsupported("expected CPU".into())),
    }
}
#[test]
fn jpeg_decode_scale_encode_preserves_size_and_colour_within_tolerance() -> Result<(), CodecError> {
    let mut codec: Box<dyn StillCodec> = Box::<CpuJpegCodec>::default();
    let mut scaler: Box<dyn Scaler> = Box::<CpuScaler>::default();
    for (source, target) in [
        (
            Size {
                width: 1280,
                height: 800,
            },
            Size {
                width: 640,
                height: 400,
            },
        ),
        (
            Size {
                width: 1206,
                height: 2622,
            },
            Size {
                width: 722,
                height: 1568,
            },
        ),
        (
            Size {
                width: 17,
                height: 9,
            },
            Size {
                width: 8,
                height: 4,
            },
        ),
    ] {
        let original = image(source)?;
        let jpeg = codec.encode(&original, 90)?;
        let decoded = codec.decode(&jpeg)?;
        assert_eq!(decoded.size(), source);
        let scaled = cpu(scaler.scale(&Picture::Cpu(decoded), target.width, target.height)?)?;
        let encoded = codec.encode(&scaled, 90)?;
        let result = codec.decode(&encoded)?;
        assert_eq!(result.size(), target);
        let expected = image(target)?;
        let total: u64 = result.planes()[0]
            .data
            .iter()
            .zip(&expected.planes()[0].data)
            .map(|(a, b)| u64::from(a.abs_diff(*b)))
            .sum();
        assert!(total as f64 / ((target.width * target.height * 3) as f64) < 15.0);
    }
    Ok(())
}
#[test]
fn fitting_preserves_aspect_with_even_dimensions_and_stays_in_bounds() -> Result<(), CodecError> {
    // Geometry cases from video-policy's nearest-even rule and M5's portrait benchmark.
    for (source, bound, expected) in [
        ((1206, 2622), (1568, 1568), (722, 1568)),
        ((2560, 1600), (1280, 800), (1280, 800)),
        ((1920, 1080), (800, 800), (800, 450)),
        ((800, 450), (2560, 2560), (800, 450)),
        ((101, 51), (100, 100), (100, 50)),
        ((1920, 1080), (801, 451), (800, 450)),
        ((1, 100), (100, 100), (2, 100)),
    ] {
        let size = |(width, height)| Size { width, height };
        assert_eq!(fit_size(size(source), size(bound))?, size(expected));
    }
    assert!(
        fit_size(
            Size {
                width: 0,
                height: 100
            },
            Size {
                width: 100,
                height: 100
            }
        )
        .is_err()
    );
    Ok(())
}
#[test]
fn bad_images_quality_and_plane_layouts_return_errors() -> Result<(), CodecError> {
    let mut codec = CpuJpegCodec::default();
    for data in [&b""[..], &b"not jpeg"[..], &[0xff, 0xd8, 0xff]] {
        assert!(codec.decode(data).is_err());
    }
    let p = image(Size {
        width: 16,
        height: 8,
    })?;
    assert!(codec.encode(&p, 0).is_err());
    assert!(codec.encode(&p, 101).is_err());
    assert!(
        CpuPicture::new(
            p.size(),
            PixelFormat::Rgb8,
            vec![Plane {
                data: vec![0; 16],
                stride: 1
            }],
            0
        )
        .is_err()
    );
    assert!(
        CpuPicture::new(
            Size {
                width: 8192,
                height: 8192
            },
            PixelFormat::Rgb8,
            vec![],
            0
        )
        .is_err()
    );
    let jpeg = codec.encode(&p, 90)?;
    assert!(codec.decode(&jpeg[..jpeg.len() / 2]).is_err());
    Ok(())
}
#[test]
fn padded_bgra_rows_scale_without_swapping_red_and_blue() -> Result<(), CodecError> {
    let p = CpuPicture::new(
        Size {
            width: 2,
            height: 2,
        },
        PixelFormat::Bgra8,
        vec![Plane {
            data: [10, 20, 200, 255, 10, 20, 200, 255, 99, 99, 99, 99].repeat(2),
            stride: 12,
        }],
        567,
    )?;
    let result = cpu(CpuScaler::default().scale(&Picture::Cpu(p), 4, 4)?)?;
    assert_eq!(result.pts_us, 567);
    assert!(
        result.planes()[0]
            .data
            .chunks_exact(3)
            .all(|p| p == [200, 20, 10])
    );
    Ok(())
}

#[test]
fn jpeg_quality_changes_bytes_and_reconstruction_error() -> Result<(), CodecError> {
    let source = image(Size {
        width: 128,
        height: 64,
    })?;
    let mut codec = CpuJpegCodec::default();
    let low = codec.encode(&source, 10)?;
    let high = codec.encode(&source, 95)?;
    assert!(high.len() > low.len());
    let low = codec.decode(&low)?;
    let high = codec.decode(&high)?;
    let error = |p: &CpuPicture| -> u64 {
        p.planes()[0]
            .data
            .iter()
            .zip(&source.planes()[0].data)
            .map(|(a, b)| u64::from(a.abs_diff(*b)))
            .sum()
    };
    assert!(error(&high) < error(&low));
    Ok(())
}

#[test]
fn pixel_budgets_hold_after_even_rounding_and_for_extreme_aspects() -> Result<(), CodecError> {
    let bounds = Size {
        width: 1568,
        height: 1568,
    };
    assert_eq!(
        fit_size_with_max_pixels(
            Size {
                width: 1206,
                height: 2622
            },
            bounds,
            250_000
        )?,
        Size {
            width: 338,
            height: 738
        }
    );
    let result = fit_size_with_max_pixels(
        Size {
            width: 2,
            height: 8192,
        },
        bounds,
        100,
    )?;
    assert_eq!(
        result,
        Size {
            width: 2,
            height: 50
        }
    );
    assert!(fit_size_with_max_pixels(bounds, bounds, 3).is_err());
    Ok(())
}

// SPDX-License-Identifier: Apache-2.0
use media_codec::{fake::*, *};

fn picture(size: Size, pts_us: u64) -> Result<Picture, CodecError> {
    Ok(Picture::Cpu(CpuPicture::new(
        size,
        PixelFormat::Rgb8,
        vec![Plane {
            data: vec![64; size.width as usize * size.height as usize * 3],
            stride: size.width as usize * 3,
        }],
        pts_us,
    )?))
}
fn spec() -> EncodeSpec {
    EncodeSpec {
        codec: Codec::H264,
        size: Size {
            width: 16,
            height: 8,
        },
        fps: 60,
        rate: RateControl::Bitrate(480_000),
    }
}
#[test]
fn scripted_units_keep_order_timing_and_requested_keyframes() -> Result<(), CodecError> {
    let mut encoder: Box<dyn Encoder> = Box::new(FakeEncoder::new([
        EncodeStep::Bytes(13),
        EncodeStep::Bytes(27),
        EncodeStep::Bytes(9),
    ]));
    let spec = spec();
    assert_eq!(
        encoder.encode(picture(spec.size, 0)?, false),
        Err(CodecError::NotConfigured)
    );
    encoder.configure(&spec)?;
    for (pts, force) in [(10, false), (20, false), (30, true)] {
        encoder.encode(picture(spec.size, pts)?, force)?;
    }
    for (pts, len, key) in [(10, 13, true), (20, 27, false), (30, 9, true)] {
        let unit = encoder
            .poll_result()?
            .ok_or(CodecError::Backend("missing output".into()))?;
        assert_eq!(
            (unit.pts_us, unit.data.len(), unit.key, unit.duration_us),
            (pts, len, key, 16_666)
        );
        assert_eq!(unit.description.is_some(), key);
        let mut decoder: Box<dyn Decoder> = Box::<FakeDecoder>::default();
        let decoded = decoder
            .decode(&unit)?
            .ok_or(CodecError::Backend("missing picture".into()))?;
        assert_eq!((decoded.size(), decoded.pts_us()), (spec.size, pts));
    }
    encoder.flush()?;
    assert!(encoder.poll_result()?.is_none());
    Ok(())
}
#[test]
fn rate_changes_keep_pending_units_and_do_not_force_a_keyframe() -> Result<(), CodecError> {
    let mut encoder = FakeEncoder::new([]);
    let mut spec = spec();
    encoder.configure(&spec)?;
    encoder.encode(picture(spec.size, 10)?, false)?;
    spec.rate = RateControl::Bitrate(960_000);
    encoder.configure(&spec)?;
    encoder.encode(picture(spec.size, 20)?, false)?;
    let first = encoder.poll().ok_or(CodecError::NotConfigured)?;
    let second = encoder.poll().ok_or(CodecError::NotConfigured)?;
    assert_eq!((first.data.len(), first.key), (1000, true));
    assert_eq!((second.data.len(), second.key), (2000, false));
    assert_ne!(first.data[..4], second.data[..4]);
    spec.rate = RateControl::Quantizer(30);
    encoder.configure(&spec)?;
    encoder.encode(picture(spec.size, 30)?, false)?;
    assert_eq!(
        encoder.poll().ok_or(CodecError::NotConfigured)?.data.len(),
        352
    );
    spec.size = Size {
        width: 8,
        height: 4,
    };
    encoder.configure(&spec)?;
    encoder.encode(picture(spec.size, 40)?, false)?;
    assert!(encoder.poll().ok_or(CodecError::NotConfigured)?.key);
    Ok(())
}
#[test]
fn failures_are_reported_and_failed_reconfiguration_keeps_the_stream() -> Result<(), CodecError> {
    let failure = CodecError::Backend("device lost".into());
    let mut encoder = FakeEncoder::new([EncodeStep::Error(failure.clone()), EncodeStep::Bytes(12)]);
    let valid = spec();
    encoder.configure(&valid)?;
    let mut invalid = valid.clone();
    invalid.rate = RateControl::Bitrate(0);
    assert!(encoder.configure(&invalid).is_err());
    assert_eq!(
        encoder.encode(picture(valid.size, 1)?, true),
        Err(failure.clone())
    );
    assert!(encoder.poll().is_none());
    encoder.encode(picture(valid.size, 2)?, false)?;
    let unit = encoder.poll().ok_or(CodecError::NotConfigured)?;
    assert!(unit.key);
    let mut decoder = FakeDecoder::default();
    decoder.fail_next(failure.clone());
    assert!(matches!(decoder.decode(&unit), Err(e) if e == failure));
    assert!(decoder.decode(&unit)?.is_some());
    Ok(())
}

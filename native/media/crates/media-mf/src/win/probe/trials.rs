// SPDX-License-Identifier: Apache-2.0
//! The trials themselves: one session, one frame, what the session reported.
use super::{TRIAL, TrialInput, unfinished};
use crate::nal::codec_string;
use crate::win::decoder::{DecodeOutput, MfDecoder};
use crate::win::device::MfDevice;
use crate::win::encoder::MfEncoder;
use crate::win::surface::{MfFormat, MfSurface, upload};
use crate::win::vp::MfScaler;
use crate::win::wic::WicJpeg;
use media_codec::*;
use media_wire::capability::{Backend, Capability, Step, TrialState};

/// An NV12 diagonal gradient, moving with `phase`.
pub(super) fn gradient(size: Size, phase: u32) -> Result<CpuPicture, CodecError> {
    let (w, h) = (size.width as usize, size.height as usize);
    let luma = (0..w * h)
        .map(|i| ((i % w + i / w + phase as usize) % 220 + 16) as u8)
        .collect();
    let chroma = (0..w * h / 2)
        .map(|i| if i % 2 == 0 { 100 } else { 150 })
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
        0,
    )
}

pub(super) fn encode_trial(
    device: Option<&MfDevice>,
    frame: &CpuPicture,
    codec: Codec,
    input: TrialInput,
    max: Size,
) -> (Capability, Option<EncodedUnit>) {
    let name = if codec == Codec::H264 { "avc1" } else { "hvc1" };
    let attempt = || -> Result<(Capability, EncodedUnit), CodecError> {
        let mut encoder = MfEncoder::new(device.cloned())?;
        let spec = EncodeSpec {
            codec,
            size: TRIAL,
            fps: 60,
            rate: RateControl::Bitrate(4_000_000),
        };
        encoder.configure(&spec)?;
        let picture = match (input, device) {
            (TrialInput::Surface, Some(device)) => upload(device, frame)?.into_picture(0),
            _ => Picture::Cpu(frame.clone()),
        };
        encoder.encode(picture, true)?;
        let copies = encoder.last_copies();
        encoder.flush()?;
        let unit = encoder
            .poll_result()?
            .ok_or_else(|| CodecError::Backend("trial frame produced no output".into()))?;
        if !unit.key {
            return Err(CodecError::Backend(
                "the trial's first unit was not a keyframe".into(),
            ));
        }
        let hardware = encoder.hardware();
        Ok((
            Capability {
                step: Step::Encode,
                codec: Some(
                    unit.description
                        .as_deref()
                        .and_then(|r| codec_string(codec, r))
                        .unwrap_or_else(|| name.into()),
                ),
                backend: Backend::Mf,
                hardware,
                zero_copy: hardware
                    && input == TrialInput::Surface
                    && copies.readbacks == 0
                    && copies.uploads == 0,
                state: TrialState::Ok,
                max_width: max.width,
                max_height: max.height,
            },
            unit,
        ))
    };
    match attempt() {
        Ok((capability, unit)) => (capability, Some(unit)),
        Err(_) => (unfinished(Step::Encode, name, TrialState::Failed), None),
    }
}

pub(super) fn decode_trial(
    device: Option<&MfDevice>,
    name: &str,
    unit: Option<&EncodedUnit>,
    max_width: u32,
    max_height: u32,
) -> Capability {
    let Some(unit) = unit else {
        return unfinished(Step::Decode, name, TrialState::Failed);
    };
    let Ok(mut decoder) = MfDecoder::new(device.cloned(), DecodeOutput::Surface) else {
        return unfinished(Step::Decode, name, TrialState::Failed);
    };
    // A decoder that holds the one trial picture back gives it up on drain.
    let decoded = decoder.decode(unit).and_then(|picture| match picture {
        Some(picture) => Ok(Some(picture)),
        None => Ok(decoder.drain()?.into_iter().next()),
    });
    match decoded {
        Ok(Some(picture)) if picture.size() == unit.size => Capability {
            step: Step::Decode,
            codec: Some(
                unit.description
                    .as_deref()
                    .and_then(|r| codec_string(unit.codec, r))
                    .unwrap_or_else(|| name.into()),
            ),
            backend: Backend::Mf,
            hardware: decoder.hardware(),
            zero_copy: decoder.hardware()
                && MfSurface::of(&picture).is_some()
                && decoder.last_copies() == crate::Copies::default(),
            state: TrialState::Ok,
            max_width,
            max_height,
        },
        _ => unfinished(Step::Decode, name, TrialState::Failed),
    }
}

fn still() -> Result<CpuPicture, CodecError> {
    let size = Size {
        width: 640,
        height: 360,
    };
    let stride = size.width as usize * 4;
    let data = (0..stride * size.height as usize)
        .map(|i| (i % 251) as u8)
        .collect();
    CpuPicture::new(size, PixelFormat::Bgra8, [Plane { data, stride }], 0)
}

pub(super) fn jpeg_encode_trial() -> (Capability, Option<Vec<u8>>) {
    let attempt = || -> Result<Vec<u8>, CodecError> {
        let mut jpeg = WicJpeg::new()?;
        JpegCodec::encode(&mut jpeg, &Picture::Cpu(still()?), 80)
    };
    match attempt() {
        Ok(bytes) if bytes.starts_with(&[0xff, 0xd8]) => (
            Capability {
                step: Step::JpegEncode,
                codec: Some("jpeg".into()),
                backend: Backend::Mf,
                hardware: false,
                zero_copy: false,
                state: TrialState::Ok,
                max_width: MAX_DIMENSION,
                max_height: MAX_DIMENSION,
            },
            Some(bytes),
        ),
        _ => (
            unfinished(Step::JpegEncode, "jpeg", TrialState::Failed),
            None,
        ),
    }
}

pub(super) fn jpeg_decode_trial(still: Option<&[u8]>) -> Capability {
    let half = Size {
        width: 320,
        height: 180,
    };
    let result = still
        .ok_or(CodecError::NotConfigured)
        .and_then(|still| JpegCodec::decode(&mut WicJpeg::new()?, still, half.width, half.height));
    match result {
        Ok(picture) if picture.size() == half => Capability {
            step: Step::JpegDecode,
            codec: Some("jpeg".into()),
            backend: Backend::Mf,
            hardware: false,
            zero_copy: false,
            state: TrialState::Ok,
            max_width: MAX_DIMENSION,
            max_height: MAX_DIMENSION,
        },
        _ => unfinished(Step::JpegDecode, "jpeg", TrialState::Failed),
    }
}

/// The video processor runs on the adapter, so it is hardware unless the adapter is
/// Microsoft's software rasteriser.
pub(super) fn scale_trial(device: &MfDevice, frame: &CpuPicture) -> Capability {
    let half = Size {
        width: TRIAL.width / 2,
        height: TRIAL.height / 2,
    };
    let result = upload(device, frame).and_then(|surface| {
        let mut scaler = MfScaler::new(device, MfFormat::Nv12)?;
        scaler.convert(&surface, half)
    });
    match result {
        Ok(out) if out.size() == half => Capability {
            step: Step::Scale,
            codec: None,
            backend: Backend::Mf,
            hardware: !device.adapter().software,
            zero_copy: !device.adapter().software,
            state: TrialState::Ok,
            max_width: MAX_DIMENSION,
            max_height: MAX_DIMENSION,
        },
        _ => unfinished(Step::Scale, "", TrialState::Failed),
    }
}

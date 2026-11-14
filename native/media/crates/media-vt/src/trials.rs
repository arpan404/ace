// SPDX-License-Identifier: Apache-2.0
//! The trials behind the probe: each opens a session, pushes one frame and
//! reports what the session says.
use crate::decoder::{DecodeOutput, VtDecoder};
use crate::encoder::{CompressionSession, VtEncoder};
use crate::jpeg::VtJpeg;
use crate::output::Shared;
use crate::probe::{Gate, TrialInput, unfinished};
use crate::surface::{PixelPool, VtFormat};
use crate::transfer::VtScaler;
use media_codec::*;
use media_wire::capability::{Backend, Capability, Step, TrialState};
use objc2_core_media::{kCMVideoCodecType_H264, kCMVideoCodecType_HEVC};
use std::sync::{Arc, OnceLock};

const TRIAL: Size = Size {
    width: 1280,
    height: 720,
};
/// Candidate sizes, largest first, for the largest hardware encode session.
const CANDIDATES: [Size; 4] = [
    Size {
        width: 8192,
        height: 4320,
    },
    Size {
        width: 4096,
        height: 2304,
    },
    Size {
        width: 3840,
        height: 2160,
    },
    Size {
        width: 1920,
        height: 1088,
    },
];

/// Runs every trial in order, publishing each result. Before each operation
/// it checks the gate (cancellation and deadline) and stops once it closes;
/// the trial already inside a VideoToolbox call finishes and is published.
pub(crate) fn run_trials(input: TrialInput, gate: &Gate, publish: &dyn Fn(Capability)) {
    if !gate.open() {
        return;
    }
    let frame = trial_frame();
    let mut units = Vec::new();
    for (codec, name) in [(Codec::H264, "avc1"), (Codec::Hevc, "hvc1")] {
        if !gate.open() {
            return;
        }
        let (capability, unit) = match &frame {
            Ok(pool) => match encode_trial(pool, codec, input, gate) {
                Some(result) => result,
                None => return,
            },
            Err(_) => (unfinished(Step::Encode, name, TrialState::Failed), None),
        };
        units.push((name, unit, capability.max_width, capability.max_height));
        publish(capability);
    }
    for (name, unit, width, height) in units {
        if !gate.open() {
            return;
        }
        publish(decode_trial(name, unit.as_ref(), width, height));
    }
    if !gate.open() {
        return;
    }
    let mut jpeg = VtJpeg::new(VtFormat::Nv12);
    let (encode, still) = match &frame {
        Ok(pool) => jpeg_encode_trial(&mut jpeg, pool),
        Err(_) => (
            unfinished(Step::JpegEncode, "jpeg", TrialState::Failed),
            None,
        ),
    };
    publish(encode);
    if !gate.open() {
        return;
    }
    publish(jpeg_decode_trial(&mut jpeg, still.as_deref()));
    if !gate.open() {
        return;
    }
    publish(match &frame {
        Ok(pool) => scale_trial(pool),
        Err(_) => unfinished(Step::Scale, "", TrialState::Failed),
    });
}

/// A pooled NV12 surface with a gradient, filled once.
fn trial_frame() -> Result<(PixelPool, Picture), CodecError> {
    let pool = PixelPool::new(TRIAL, VtFormat::Nv12, 2)?;
    let cpu = gradient(TRIAL, 0)?;
    let picture = pool.upload(&cpu)?;
    Ok((pool, picture))
}

pub(crate) fn gradient(size: Size, phase: u32) -> Result<CpuPicture, CodecError> {
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

/// `None` when the gate closed between operations: nothing to publish.
fn encode_trial(
    frame: &(PixelPool, Picture),
    codec: Codec,
    input: TrialInput,
    gate: &Gate,
) -> Option<(Capability, Option<EncodedUnit>)> {
    let name = if codec == Codec::H264 { "avc1" } else { "hvc1" };
    let attempt = || -> Result<(Capability, EncodedUnit), CodecError> {
        let mut encoder = VtEncoder::new();
        encoder.configure(&EncodeSpec {
            codec,
            size: TRIAL,
            fps: 60,
            rate: RateControl::Bitrate(4_000_000),
        })?;
        let picture = match input {
            TrialInput::Surface => {
                let surface =
                    crate::surface::VtSurface::of(&frame.1).ok_or(CodecError::NotConfigured)?;
                surface.share().into_picture(0)?
            }
            TrialInput::Cpu => Picture::Cpu(gradient(TRIAL, 0)?),
        };
        if !gate.open() {
            return Err(CodecError::DeadlineExceeded);
        }
        encoder.encode(picture, true)?;
        encoder.flush()?;
        let unit = encoder
            .poll_result()?
            .ok_or_else(|| CodecError::Backend("trial frame produced no output".into()))?;
        let copies = encoder.last_copies();
        if !gate.open() {
            return Err(CodecError::DeadlineExceeded);
        }
        let max = largest_encode(codec);
        Ok((
            Capability {
                step: Step::Encode,
                codec: Some(
                    codec_string(codec, unit.description.as_deref()).unwrap_or_else(|| name.into()),
                ),
                backend: Backend::Vt,
                hardware: encoder.hardware(),
                zero_copy: encoder.hardware() && copies.uploads == 0 && copies.readbacks == 0,
                state: TrialState::Ok,
                max_width: max.width,
                max_height: max.height,
            },
            unit,
        ))
    };
    match attempt() {
        Ok((capability, unit)) => Some((capability, Some(unit))),
        Err(CodecError::DeadlineExceeded) => None,
        Err(_) => Some((unfinished(Step::Encode, name, TrialState::Failed), None)),
    }
}

fn decode_trial(
    name: &str,
    unit: Option<&EncodedUnit>,
    max_width: u32,
    max_height: u32,
) -> Capability {
    let Some(unit) = unit else {
        return unfinished(Step::Decode, name, TrialState::Failed);
    };
    let mut decoder = VtDecoder::new(DecodeOutput::default());
    match decoder.decode(unit) {
        Ok(Some(picture)) if picture.size() == unit.size => Capability {
            step: Step::Decode,
            codec: Some(
                codec_string(unit.codec, unit.description.as_deref())
                    .unwrap_or_else(|| name.into()),
            ),
            backend: Backend::Vt,
            hardware: decoder.hardware(),
            zero_copy: decoder.hardware()
                && crate::surface::VtSurface::of(&picture).is_some_and(|s| s.is_io_surface()),
            state: TrialState::Ok,
            max_width,
            max_height,
        },
        _ => unfinished(Step::Decode, name, TrialState::Failed),
    }
}

fn jpeg_encode_trial(
    jpeg: &mut VtJpeg,
    frame: &(PixelPool, Picture),
) -> (Capability, Option<Vec<u8>>) {
    let mut out = Vec::new();
    match jpeg.encode_into(&frame.1, 80, &mut out) {
        Ok(()) => {
            let path = jpeg.last_path();
            let capability = Capability {
                step: Step::JpegEncode,
                codec: Some("jpeg".into()),
                backend: Backend::Vt,
                hardware: path.hardware,
                zero_copy: path.hardware && path.copies.readbacks == 0,
                state: TrialState::Ok,
                max_width: MAX_DIMENSION,
                max_height: MAX_DIMENSION,
            };
            (capability, Some(out))
        }
        Err(_) => (
            unfinished(Step::JpegEncode, "jpeg", TrialState::Failed),
            None,
        ),
    }
}

fn jpeg_decode_trial(jpeg: &mut VtJpeg, still: Option<&[u8]>) -> Capability {
    let half = Size {
        width: TRIAL.width / 2,
        height: TRIAL.height / 2,
    };
    let result = still
        .ok_or(CodecError::NotConfigured)
        .and_then(|still| JpegCodec::decode(jpeg, still, half.width, half.height));
    match result {
        Ok(picture) if picture.size() == half => {
            let path = jpeg.last_path();
            Capability {
                step: Step::JpegDecode,
                codec: Some("jpeg".into()),
                backend: Backend::Vt,
                hardware: path.hardware,
                zero_copy: path.hardware && path.copies.uploads == 0,
                state: TrialState::Ok,
                max_width: MAX_DIMENSION,
                max_height: MAX_DIMENSION,
            }
        }
        _ => unfinished(Step::JpegDecode, "jpeg", TrialState::Failed),
    }
}

/// `VTPixelTransferSession` reports no hardware property, so `hardware` stays
/// false: it is never inferred from the chip.
fn scale_trial(frame: &(PixelPool, Picture)) -> Capability {
    let half = Size {
        width: TRIAL.width / 2,
        height: TRIAL.height / 2,
    };
    let result = VtScaler::new(VtFormat::Bgra)
        .and_then(|mut scaler| scaler.scale(&frame.1, half.width, half.height));
    match result {
        Ok(picture) if picture.size() == half => Capability {
            step: Step::Scale,
            codec: None,
            backend: Backend::Vt,
            hardware: false,
            zero_copy: true,
            state: TrialState::Ok,
            max_width: MAX_DIMENSION,
            max_height: MAX_DIMENSION,
        },
        _ => unfinished(Step::Scale, "", TrialState::Failed),
    }
}

/// The largest candidate size a hardware session opens and prepares at.
pub(crate) fn largest_encode(codec: Codec) -> Size {
    static H264: OnceLock<Size> = OnceLock::new();
    static HEVC: OnceLock<Size> = OnceLock::new();
    let (cell, codec_type) = match codec {
        Codec::Hevc => (&HEVC, kCMVideoCodecType_HEVC),
        _ => (&H264, kCMVideoCodecType_H264),
    };
    *cell.get_or_init(|| {
        let shared = Arc::new(Shared::default());
        let specification = crate::encoder::hardware_only();
        CANDIDATES
            .into_iter()
            .find(|size| {
                CompressionSession::open(codec_type, *size, &specification, None, &shared)
                    .and_then(|session| session.prepare().map(|()| session.hardware()))
                    .unwrap_or(false)
            })
            .unwrap_or(Size {
                width: 0,
                height: 0,
            })
    })
}

/// The WebCodecs codec string from an `avcC` or `hvcC` record (ISO/IEC 14496-15).
pub(crate) fn codec_string(codec: Codec, record: Option<&[u8]>) -> Option<String> {
    let record = record?;
    match codec {
        Codec::H264 => {
            let [_, profile, compat, level, ..] = record else {
                return None;
            };
            Some(format!("avc1.{profile:02X}{compat:02X}{level:02X}"))
        }
        Codec::Hevc => {
            let first = *record.get(1)?;
            let space = ["", "A", "B", "C"][usize::from(first >> 6)];
            let tier = if first & 0x20 != 0 { 'H' } else { 'L' };
            let profile = first & 0x1f;
            let compat = u32::from_be_bytes(record.get(2..6)?.try_into().ok()?).reverse_bits();
            let constraints = record.get(6..12)?;
            let level = record.get(12)?;
            let used = constraints
                .iter()
                .rposition(|b| *b != 0)
                .map_or(0, |i| i + 1);
            let mut out = format!("hvc1.{space}{profile}.{compat:X}.{tier}{level}");
            for byte in constraints.iter().take(used) {
                out.push_str(&format!(".{byte:X}"));
            }
            Some(out)
        }
        _ => None,
    }
}

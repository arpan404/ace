// SPDX-License-Identifier: Apache-2.0
//! The VA backend's availability trial for ace-media's probe (docs/media/plan.md, "Probe at
//! start"): open a session per step and push one picture through it. The probe runs this on
//! its own thread under the 2 s deadline and abandons it if it overruns.
use super::device::{Device, OpenError};
use super::encoder::VaEncoder;
use super::ffi::attrib;
use super::jpeg_hw::VaJpegCodec;
use super::surface::{Surface, imports_dmabuf, max_size};
use super::vpp::VaScaler;
use crate::select::{self, entrypoint, profile};
use media_bitstream::{avcc::AvcConfig, hvcc::HevcConfig};
use media_codec::{
    Codec, CodecError, CpuPicture, EncodeSpec, Encoder, JpegCodec, Picture, PixelFormat, Plane,
    RateControl, Scaler, Size,
};
use media_wire::capability::{Backend, Capability, Step, TrialState};
use std::sync::Arc;

/// Nominal codec strings, reported for steps that time out before saying what they ran.
pub const H264_CODEC: &str = "avc1.640028";
pub const HEVC_CODEC: &str = "hvc1.1.6.L120.B0";

/// The steps the trial covers, as `(step, codec, backend)`.
pub fn trial_steps() -> Vec<(Step, Option<String>, Backend)> {
    vec![
        (Step::Encode, Some(H264_CODEC.into()), Backend::Vaapi),
        (Step::Encode, Some(HEVC_CODEC.into()), Backend::Vaapi),
        (Step::Scale, None, Backend::Vaapi),
        (Step::JpegDecode, Some("jpeg".into()), Backend::Vaapi),
        (Step::JpegEncode, Some("jpeg".into()), Backend::Vaapi),
    ]
}

/// Runs the trial on the first usable render node. A machine without libva or a render
/// node has no VA backend and reports nothing; one whose driver fails reports every step
/// `failed`.
pub fn run_trial() -> Vec<Capability> {
    match Device::open() {
        Ok(device) => trial_on(&device),
        Err(OpenError::Absent(_)) => Vec::new(),
        Err(OpenError::Failed(_)) => trial_steps()
            .into_iter()
            .map(|(step, codec, backend)| failed(step, codec, backend))
            .collect(),
    }
}

fn failed(step: Step, codec: Option<String>, backend: Backend) -> Capability {
    Capability {
        step,
        codec,
        backend,
        hardware: false,
        zero_copy: false,
        state: TrialState::Failed,
        max_width: 0,
        max_height: 0,
    }
}

fn ok(step: Step, codec: Option<String>, zero_copy: bool, max: Size) -> Capability {
    Capability {
        step,
        codec,
        backend: Backend::Vaapi,
        // A VA entrypoint is the driver's hardware path.
        hardware: true,
        zero_copy,
        state: TrialState::Ok,
        max_width: max.width,
        max_height: max.height,
    }
}

fn gray_nv12(size: Size) -> Result<CpuPicture, CodecError> {
    let (w, h) = (size.width as usize, size.height as usize);
    CpuPicture::new(
        size,
        PixelFormat::Nv12,
        [
            Plane {
                data: vec![128; w * h],
                stride: w,
            },
            Plane {
                data: vec![128; w * h / 2],
                stride: w,
            },
        ],
        0,
    )
}

const TRIAL: Size = Size {
    width: 256,
    height: 144,
};

/// Whether `(profile, entrypoint)`'s surfaces import DMA-BUFs, and its largest surface.
fn surface_facts(device: &Arc<Device>, profile: i32, entrypoint: i32) -> (bool, Option<Size>) {
    let Ok(config) = device.create_config(
        profile,
        entrypoint,
        &[(attrib::RT_FORMAT, crate::formats::VA_RT_FORMAT_YUV420)],
    ) else {
        return (false, None);
    };
    match device.surface_attributes(&config) {
        Ok(a) => (imports_dmabuf(&a), max_size(&a)),
        Err(_) => (false, None),
    }
}

fn encode_trial(device: &Arc<Device>, codec: Codec) -> Result<Capability, CodecError> {
    let mut encoder = VaEncoder::new(device)?;
    encoder.configure(&EncodeSpec {
        codec,
        size: TRIAL,
        fps: 30,
        rate: RateControl::Bitrate(1_000_000),
    })?;
    encoder.encode(Picture::Cpu(gray_nv12(TRIAL)?), true)?;
    let unit = encoder
        .poll_result()?
        .ok_or_else(|| CodecError::Backend("no output".into()))?;
    let description = unit
        .description
        .filter(|_| unit.key)
        .ok_or_else(|| CodecError::Backend("first unit isn't a described keyframe".into()))?;
    let name = match codec {
        Codec::H264 => AvcConfig::parse(&description).map(|c| c.codec_string()),
        _ => HevcConfig::parse(&description).map(|c| c.codec_string()),
    }
    .map_err(|e| CodecError::Backend(e.to_string()))?;
    let session = encoder
        .session()
        .ok_or_else(|| CodecError::Backend("no session".into()))?;
    let (zero_copy, surface_max) = surface_facts(
        device,
        session.candidate.profile,
        session.candidate.entrypoint,
    );
    let caps = encoder.caps().max_size;
    let max = surface_max.map_or(caps, |s| Size {
        width: s.width.min(caps.width),
        height: s.height.min(caps.height),
    });
    Ok(ok(Step::Encode, Some(name), zero_copy, max))
}

fn scale_trial(device: &Arc<Device>) -> Result<Capability, CodecError> {
    let mut scaler = VaScaler::new(device)?;
    let source = CpuPicture::new(
        TRIAL,
        PixelFormat::Bgra8,
        [Plane {
            data: vec![90; TRIAL.width as usize * TRIAL.height as usize * 4],
            stride: TRIAL.width as usize * 4,
        }],
        0,
    )?;
    let half = Size {
        width: TRIAL.width / 2,
        height: TRIAL.height / 2,
    };
    let out = scaler.scale(&Picture::Cpu(source), half.width, half.height)?;
    let Picture::Platform(p) = out else {
        return Err(CodecError::Backend("scaler returned CPU memory".into()));
    };
    let read = Surface::of(&p)
        .ok_or_else(|| CodecError::Backend("not a VA surface".into()))?
        .read(0)?;
    if read.size() != half {
        return Err(CodecError::Backend("scaled to the wrong size".into()));
    }
    let (zero_copy, max) = surface_facts(device, profile::NONE, entrypoint::VIDEO_PROC);
    Ok(ok(
        Step::Scale,
        None,
        zero_copy,
        max.unwrap_or(Size {
            width: media_codec::MAX_DIMENSION,
            height: media_codec::MAX_DIMENSION,
        }),
    ))
}

fn jpeg_max(device: &Arc<Device>, entry: i32) -> Size {
    let limit = |v: u32| {
        if v == select::ATTRIB_NOT_SUPPORTED {
            media_codec::MAX_DIMENSION
        } else {
            v.min(media_codec::MAX_DIMENSION)
        }
    };
    device
        .attributes(
            profile::JPEG_BASELINE,
            entry,
            &[attrib::MAX_PICTURE_WIDTH, attrib::MAX_PICTURE_HEIGHT],
        )
        .map_or(
            Size {
                width: media_codec::MAX_DIMENSION,
                height: media_codec::MAX_DIMENSION,
            },
            |v| Size {
                width: limit(v[0]),
                height: limit(v[1]),
            },
        )
}

/// JPEG encode then decode of the result; a decode-only driver decodes a CPU JPEG.
fn jpeg_trials(
    device: &Arc<Device>,
) -> (
    Result<Capability, CodecError>,
    Result<Capability, CodecError>,
) {
    let mut codec = match VaJpegCodec::new(device) {
        Ok(c) => c,
        Err(e) => return (Err(e.clone()), Err(e)),
    };
    let picture = match gray_nv12(TRIAL) {
        Ok(p) => p,
        Err(e) => return (Err(e.clone()), Err(e)),
    };
    let encoded = if codec.can_encode() {
        codec.encode(&Picture::Cpu(picture.clone()), 80)
    } else {
        Err(CodecError::Unsupported("no VA JPEG encode".into()))
    };
    let encode = encoded.as_ref().map_err(Clone::clone).and_then(|jpeg| {
        media_codec::jpeg_size(jpeg)?;
        Ok(ok(
            Step::JpegEncode,
            Some("jpeg".into()),
            false,
            jpeg_max(device, entrypoint::ENC_PICTURE),
        ))
    });
    let decode = (|| {
        if !codec.can_decode() {
            return Err(CodecError::Unsupported("no VA JPEG decode".into()));
        }
        let jpeg = match &encoded {
            Ok(j) => j.clone(),
            Err(_) => {
                let rgb = CpuPicture::new(
                    TRIAL,
                    PixelFormat::Rgb8,
                    [Plane {
                        data: vec![128; TRIAL.width as usize * TRIAL.height as usize * 3],
                        stride: TRIAL.width as usize * 3,
                    }],
                    0,
                )?;
                media_codec::StillCodec::encode(
                    &mut media_codec::CpuJpegCodec::default(),
                    &rgb,
                    80,
                )?
            }
        };
        let out = codec.decode(&jpeg, TRIAL.width, TRIAL.height)?;
        if out.size() != TRIAL {
            return Err(CodecError::Backend("decoded to the wrong size".into()));
        }
        Ok(ok(
            Step::JpegDecode,
            Some("jpeg".into()),
            false,
            jpeg_max(device, entrypoint::VLD),
        ))
    })();
    (decode, encode)
}

/// The trial on an open device: one entry per step, `failed` where it didn't work. Steps
/// the driver doesn't list at all are left out: the machine has no hardware for them.
pub fn trial_on(device: &Arc<Device>) -> Vec<Capability> {
    let listed = device.profiles().unwrap_or_default();
    let mut out = Vec::new();
    for (codec, nominal) in [(Codec::H264, H264_CODEC), (Codec::Hevc, HEVC_CODEC)] {
        if select::encode_candidates(codec, &listed).is_empty() {
            continue;
        }
        out.push(
            encode_trial(device, codec)
                .unwrap_or_else(|_| failed(Step::Encode, Some(nominal.into()), Backend::Vaapi)),
        );
    }
    if select::lists(&listed, profile::NONE, entrypoint::VIDEO_PROC) {
        out.push(scale_trial(device).unwrap_or_else(|_| failed(Step::Scale, None, Backend::Vaapi)));
    }
    let lists_decode = select::lists(&listed, profile::JPEG_BASELINE, entrypoint::VLD);
    let lists_encode = select::lists(&listed, profile::JPEG_BASELINE, entrypoint::ENC_PICTURE);
    if lists_decode || lists_encode {
        let (decode, encode) = jpeg_trials(device);
        let jpeg = || Some("jpeg".to_string());
        if lists_decode {
            out.push(decode.unwrap_or_else(|_| failed(Step::JpegDecode, jpeg(), Backend::Vaapi)));
        }
        if lists_encode {
            out.push(encode.unwrap_or_else(|_| failed(Step::JpegEncode, jpeg(), Backend::Vaapi)));
        }
    }
    out
}

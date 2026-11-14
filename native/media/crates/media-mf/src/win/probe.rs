// SPDX-License-Identifier: Apache-2.0
//! The backend's availability trial (ADR 0148): open each session, push one frame, and
//! report what the session says. `hardware` for encode is the MFT's
//! `MFT_ENUM_FLAG_HARDWARE`, for decode DXVA output on a non-software adapter; WIC is
//! never hardware. Trials run on a thread of their own under a deadline; anything
//! unfinished is `timed-out` and arrives later on [`ProbeReport::late`].
use super::decoder::{DecodeOutput, MfDecoder};
use super::device::MfDevice;
use super::encoder::MfEncoder;
use super::surface::{MfFormat, MfSurface, upload};
use super::vp::MfScaler;
use super::wic::WicJpeg;
use crate::nal::codec_string;
use media_codec::*;
use media_wire::capability::{Backend, Capability, Step, TrialState};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

const TRIAL: Size = Size {
    width: 1280,
    height: 720,
};
/// Sizes tried, largest first, for the largest session the encoder MFT opens.
const CANDIDATES: [Size; 3] = [
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

/// How the encode trial is fed. `Cpu` forces one upload or none, which the report shows as
/// `zeroCopy: false`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrialInput {
    Surface,
    Cpu,
}

#[derive(Clone, Debug, Default)]
pub struct ProbeCancel(Arc<AtomicBool>);
impl ProbeCancel {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

#[derive(Clone, Debug)]
pub struct ProbeOptions {
    pub deadline: Duration,
    pub input: TrialInput,
    pub cancel: ProbeCancel,
}
impl Default for ProbeOptions {
    fn default() -> Self {
        Self {
            deadline: Duration::from_secs(2),
            input: TrialInput::Surface,
            cancel: ProbeCancel::default(),
        }
    }
}

pub struct ProbeReport {
    /// One entry per step and codec, in a fixed order.
    pub capabilities: Vec<Capability>,
    /// Results of trials that finished after the deadline.
    pub late: Receiver<Capability>,
}

const STEPS: [(Step, &str); 7] = [
    (Step::Encode, "avc1"),
    (Step::Encode, "hvc1"),
    (Step::Decode, "avc1"),
    (Step::Decode, "hvc1"),
    (Step::JpegEncode, "jpeg"),
    (Step::JpegDecode, "jpeg"),
    (Step::Scale, ""),
];

fn family(capability: &Capability) -> (Step, &str) {
    let codec = capability.codec.as_deref().unwrap_or("");
    (capability.step, codec.get(..4).unwrap_or(codec))
}

fn unfinished(step: Step, codec: &str, state: TrialState) -> Capability {
    Capability {
        step,
        codec: (!codec.is_empty()).then(|| codec.to_owned()),
        backend: Backend::Mf,
        hardware: false,
        zero_copy: false,
        state,
        max_width: 0,
        max_height: 0,
    }
}

/// Runs the trials and waits at most `options.deadline` for them.
pub fn probe(options: &ProbeOptions) -> ProbeReport {
    let (sender, receiver) = mpsc::channel();
    let input = options.input;
    let cancel = options.cancel.clone();
    let spawned = std::thread::Builder::new()
        .name("media-mf-probe".into())
        .spawn(move || run_trials(input, &cancel, &sender));
    let mut found: Vec<Capability> = Vec::with_capacity(STEPS.len());
    let started = Instant::now();
    let mut disconnected = spawned.is_err();
    if spawned.is_ok() {
        while found.len() < STEPS.len() && !options.cancel.is_cancelled() {
            let Some(left) = options.deadline.checked_sub(started.elapsed()) else {
                break;
            };
            match receiver.recv_timeout(left.min(Duration::from_millis(50))) {
                Ok(capability) => found.push(capability),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    disconnected = true;
                    break;
                }
            }
        }
    }
    let capabilities = STEPS
        .iter()
        .map(|&(step, codec)| {
            found
                .iter()
                .find(|c| family(c) == (step, codec))
                .cloned()
                .unwrap_or_else(|| {
                    let state = if disconnected {
                        TrialState::Failed
                    } else {
                        TrialState::TimedOut
                    };
                    unfinished(step, codec, state)
                })
        })
        .collect();
    ProbeReport {
        capabilities,
        late: receiver,
    }
}

fn run_trials(input: TrialInput, cancel: &ProbeCancel, out: &Sender<Capability>) {
    let send = |capability: Capability| out.send(capability).is_ok() && !cancel.is_cancelled();
    let device = MfDevice::new().ok();
    let frame = gradient(TRIAL, 0);
    let mut units = Vec::new();
    for (codec, name) in [(Codec::H264, "avc1"), (Codec::Hevc, "hvc1")] {
        let (capability, unit) = match &frame {
            Ok(frame) => encode_trial(device.as_ref(), frame, codec, input),
            Err(_) => (unfinished(Step::Encode, name, TrialState::Failed), None),
        };
        units.push((name, unit, capability.max_width, capability.max_height));
        if !send(capability) {
            return;
        }
    }
    for (name, unit, width, height) in units {
        if !send(decode_trial(
            device.as_ref(),
            name,
            unit.as_ref(),
            width,
            height,
        )) {
            return;
        }
    }
    let (encode, still) = jpeg_encode_trial();
    if !send(encode) || !send(jpeg_decode_trial(still.as_deref())) {
        return;
    }
    send(match (&device, &frame) {
        (Some(device), Ok(frame)) => scale_trial(device, frame),
        _ => unfinished(Step::Scale, "", TrialState::Failed),
    });
}

/// An NV12 diagonal gradient, moving with `phase`.
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

fn encode_trial(
    device: Option<&MfDevice>,
    frame: &CpuPicture,
    codec: Codec,
    input: TrialInput,
) -> (Capability, Option<EncodedUnit>) {
    let name = if codec == Codec::H264 { "avc1" } else { "hvc1" };
    let attempt = || -> Result<(Capability, EncodedUnit), CodecError> {
        let mut encoder = MfEncoder::new(device.cloned());
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
        let max = largest(device, codec, &spec);
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

/// The largest candidate size the MFT accepts types for, at least the trial size.
fn largest(device: Option<&MfDevice>, codec: Codec, spec: &EncodeSpec) -> Size {
    CANDIDATES
        .into_iter()
        .find(|size| {
            let mut encoder = MfEncoder::new(device.cloned());
            encoder
                .configure(&EncodeSpec {
                    size: *size,
                    codec,
                    ..spec.clone()
                })
                .is_ok()
        })
        .unwrap_or(TRIAL)
}

fn decode_trial(
    device: Option<&MfDevice>,
    name: &str,
    unit: Option<&EncodedUnit>,
    max_width: u32,
    max_height: u32,
) -> Capability {
    let Some(unit) = unit else {
        return unfinished(Step::Decode, name, TrialState::Failed);
    };
    let mut decoder = MfDecoder::new(device.cloned(), DecodeOutput::Surface);
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

fn jpeg_encode_trial() -> (Capability, Option<Vec<u8>>) {
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

fn jpeg_decode_trial(still: Option<&[u8]>) -> Capability {
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
fn scale_trial(device: &MfDevice, frame: &CpuPicture) -> Capability {
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

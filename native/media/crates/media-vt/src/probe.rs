// SPDX-License-Identifier: Apache-2.0
//! The backend's availability trial: open each session, push one frame, and
//! report what the session itself says (ADR 0148). Trials run on a thread of
//! their own under a deadline; anything unfinished is reported `timed-out` and
//! arrives later on [`ProbeReport::late`].
use crate::decoder::{DecodeOutput, VtDecoder};
use crate::encoder::{CompressionSession, VtEncoder};
use crate::jpeg::VtJpeg;
use crate::output::Shared;
use crate::surface::{PixelPool, VtFormat};
use crate::transfer::VtScaler;
use media_codec::*;
use media_wire::capability::{Backend, Capability, Step, TrialState};
use objc2_core_media::{kCMVideoCodecType_H264, kCMVideoCodecType_HEVC};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

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

/// How the trial feeds its encode sessions. `Cpu` forces one upload per frame,
/// which the report must show as `zeroCopy: false`.
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
        backend: Backend::Vt,
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
        .name("media-vt-probe".into())
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
    let frame = trial_frame();
    let mut units = Vec::new();
    for (codec, name) in [(Codec::H264, "avc1"), (Codec::Hevc, "hvc1")] {
        let (capability, unit) = match &frame {
            Ok(pool) => encode_trial(pool, codec, input),
            Err(_) => (unfinished(Step::Encode, name, TrialState::Failed), None),
        };
        units.push((name, unit, capability.max_width, capability.max_height));
        if !send(capability) {
            return;
        }
    }
    for (name, unit, width, height) in units {
        if !send(decode_trial(name, unit.as_ref(), width, height)) {
            return;
        }
    }
    let mut jpeg = VtJpeg::new(VtFormat::Nv12);
    let (encode, still) = match &frame {
        Ok(pool) => jpeg_encode_trial(&mut jpeg, pool),
        Err(_) => (
            unfinished(Step::JpegEncode, "jpeg", TrialState::Failed),
            None,
        ),
    };
    if !send(encode) || !send(jpeg_decode_trial(&mut jpeg, still.as_deref())) {
        return;
    }
    let scale = match &frame {
        Ok(pool) => scale_trial(pool),
        Err(_) => unfinished(Step::Scale, "", TrialState::Failed),
    };
    send(scale);
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

fn encode_trial(
    frame: &(PixelPool, Picture),
    codec: Codec,
    input: TrialInput,
) -> (Capability, Option<EncodedUnit>) {
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
        encoder.encode(picture, true)?;
        encoder.flush()?;
        let unit = encoder
            .poll_result()?
            .ok_or_else(|| CodecError::Backend("trial frame produced no output".into()))?;
        let copies = encoder.last_copies();
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
        Ok((capability, unit)) => (capability, Some(unit)),
        Err(_) => (unfinished(Step::Encode, name, TrialState::Failed), None),
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

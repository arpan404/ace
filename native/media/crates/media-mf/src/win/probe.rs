// SPDX-License-Identifier: Apache-2.0
//! The backend's availability trial (ADR 0148): open each session, push one frame, and
//! report what the session says. `hardware` for encode is the MFT's
//! `MFT_ENUM_FLAG_HARDWARE`, for decode DXVA output on a non-software adapter; WIC is
//! never hardware.
//!
//! The steps run in parallel, each chain on a thread of its own (H.264 encode then decode,
//! HEVC encode then decode, JPEG encode then decode, scale), under one deadline; anything
//! unfinished is `timed-out` and arrives later on [`ProbeReport::late`]. The trial reports
//! the size it ran at as the encode limit; the largest size the MFT opens is found after the
//! trial has reported, cached for the process, and sent on `late` as a refined entry.
mod trials;

use super::device::MfDevice;
use super::encoder::MfEncoder;
use media_codec::*;
use media_wire::capability::{Backend, Capability, Step, TrialState};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

const TRIAL: Size = Size {
    width: 1280,
    height: 720,
};
/// Sizes tried after the trial, smallest first, stopping at the first the MFT refuses.
const CANDIDATES: [Size; 3] = [
    Size {
        width: 1920,
        height: 1088,
    },
    Size {
        width: 3840,
        height: 2160,
    },
    Size {
        width: 4096,
        height: 2304,
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

pub(super) fn unfinished(step: Step, codec: &str, state: TrialState) -> Capability {
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
    let mut spawned = 0;
    for chain in [
        Chain::Video(Codec::H264),
        Chain::Video(Codec::Hevc),
        Chain::Jpeg,
        Chain::Scale,
    ] {
        let (sender, cancel, input) = (sender.clone(), options.cancel.clone(), options.input);
        let started = std::thread::Builder::new()
            .name("media-mf-probe".into())
            .spawn(move || run(chain, input, &cancel, &sender));
        spawned += usize::from(started.is_ok());
    }
    drop(sender);
    let mut found: Vec<Capability> = Vec::with_capacity(STEPS.len());
    let started = Instant::now();
    let mut disconnected = spawned == 0;
    while !disconnected && !options.cancel.is_cancelled() && !complete(&found) {
        let Some(left) = options.deadline.checked_sub(started.elapsed()) else {
            break;
        };
        match receiver.recv_timeout(left.min(Duration::from_millis(50))) {
            Ok(capability) => {
                // A refined entry replaces the first one for its step and codec.
                found.retain(|c| family(c) != family(&capability));
                found.push(capability);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => disconnected = true,
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

fn complete(found: &[Capability]) -> bool {
    STEPS
        .iter()
        .all(|&(step, codec)| found.iter().any(|c| family(c) == (step, codec)))
}

#[derive(Clone, Copy)]
enum Chain {
    Video(Codec),
    Jpeg,
    Scale,
}

fn run(chain: Chain, input: TrialInput, cancel: &ProbeCancel, out: &Sender<Capability>) {
    let send = |capability: Capability| !cancel.is_cancelled() && out.send(capability).is_ok();
    match chain {
        Chain::Video(codec) => {
            let name = if codec == Codec::H264 { "avc1" } else { "hvc1" };
            let device = MfDevice::new().ok();
            let known = limit(codec);
            let (encode, unit) = match trials::gradient(TRIAL, 0) {
                Ok(frame) => trials::encode_trial(
                    device.as_ref(),
                    &frame,
                    codec,
                    input,
                    known.unwrap_or(TRIAL),
                ),
                Err(_) => (unfinished(Step::Encode, name, TrialState::Failed), None),
            };
            let decode = trials::decode_trial(
                device.as_ref(),
                name,
                unit.as_ref(),
                encode.max_width,
                encode.max_height,
            );
            if !send(encode.clone()) || !send(decode.clone()) || known.is_some() {
                return;
            }
            // After the report: the largest session the encoder opens, for `late`.
            if encode.state != TrialState::Ok {
                return;
            }
            let max = largest(device.as_ref(), codec);
            if max != TRIAL {
                let refine = |c: Capability| Capability {
                    max_width: max.width,
                    max_height: max.height,
                    ..c
                };
                let _ = send(refine(encode)) && send(refine(decode));
            }
        }
        Chain::Jpeg => {
            let (encode, still) = trials::jpeg_encode_trial();
            if send(encode) {
                send(trials::jpeg_decode_trial(still.as_deref()));
            }
        }
        Chain::Scale => {
            send(match (MfDevice::new(), trials::gradient(TRIAL, 0)) {
                (Ok(device), Ok(frame)) => trials::scale_trial(&device, &frame),
                _ => unfinished(Step::Scale, "", TrialState::Failed),
            });
        }
    }
}

static LIMITS: Mutex<Vec<(Codec, Size)>> = Mutex::new(Vec::new());

fn limit(codec: Codec) -> Option<Size> {
    let limits = LIMITS.lock().unwrap_or_else(PoisonError::into_inner);
    limits.iter().find(|(c, _)| *c == codec).map(|(_, s)| *s)
}

/// The largest candidate size the encoder MFT opens a session at, at least the trial
/// size; cached for the process (the adapter and driver don't change under it).
fn largest(device: Option<&MfDevice>, codec: Codec) -> Size {
    let mut max = TRIAL;
    for size in CANDIDATES {
        let opened = MfEncoder::new(device.cloned()).and_then(|mut encoder| {
            encoder.configure(&EncodeSpec {
                codec,
                size,
                fps: 60,
                rate: RateControl::Bitrate(4_000_000),
            })
        });
        if opened.is_err() {
            break;
        }
        max = size;
    }
    LIMITS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .push((codec, max));
    max
}

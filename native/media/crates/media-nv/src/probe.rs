// SPDX-License-Identifier: Apache-2.0
//! `media-nv`'s availability trial (docs/media/plan.md, "Probe at start"): per codec, open an
//! NVENC session, encode one picture, and decode it with NVDEC at a smaller output size. It is
//! bounded by the caller: ace-media runs it on a thread of its own under the trial deadline and
//! sets `stop` when the deadline passes; every step checks `stop` first and returns, closing
//! what it opened. Nothing here ranks backends.
use crate::decoder::NvDecoder;
use crate::encoder::{NvEncoder, Preset};
use crate::load::NvRuntime;
use media_codec::{
    Codec, CodecError, CpuPicture, Decoder, EncodeSpec, Encoder, Picture, PixelFormat, Plane,
    RateControl, Size,
};

const TRIAL: Size = Size {
    width: 320,
    height: 240,
};
const TRIAL_OUTPUT: Size = Size {
    width: 160,
    height: 120,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProbeStep {
    Encode,
    Decode,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProbeOutcome {
    /// Hardware, and the largest picture it takes.
    Ok {
        max: Size,
    },
    Failed(String),
    /// `stop` was set before the step finished.
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProbeEntry {
    pub step: ProbeStep,
    pub codec: Codec,
    pub outcome: ProbeOutcome,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NvProbe {
    /// No NVIDIA driver, or one older than the pinned NVENC version: no backend, and why.
    Absent(Vec<String>),
    Present(Vec<ProbeEntry>),
}

/// Loads the driver and runs the trial.
pub fn probe(stop: &dyn Fn() -> bool) -> NvProbe {
    probe_with(&NvRuntime::load(), stop)
}

pub(crate) fn probe_with(runtime: &NvRuntime, stop: &dyn Fn() -> bool) -> NvProbe {
    if !runtime.has_encode() && !runtime.has_decode() {
        return NvProbe::Absent(runtime.missing().to_vec());
    }
    let mut entries = Vec::new();
    for codec in [Codec::H264, Codec::Hevc] {
        let (encode, unit) = trial_encode(runtime, codec, stop);
        entries.push(ProbeEntry {
            step: ProbeStep::Encode,
            codec,
            outcome: encode,
        });
        let decode = match unit {
            _ if stop() => ProbeOutcome::Cancelled,
            _ if !runtime.has_decode() => ProbeOutcome::Failed(runtime.missing().join("; ")),
            Some(unit) => trial_decode(runtime, codec, &unit, stop),
            None => ProbeOutcome::Failed("no trial stream: NVENC failed".into()),
        };
        entries.push(ProbeEntry {
            step: ProbeStep::Decode,
            codec,
            outcome: decode,
        });
    }
    NvProbe::Present(entries)
}

fn failed(error: CodecError) -> ProbeOutcome {
    ProbeOutcome::Failed(error.to_string())
}

fn trial_picture() -> Result<Picture, CodecError> {
    let (w, h) = (TRIAL.width as usize, TRIAL.height as usize);
    Ok(Picture::Cpu(CpuPicture::new(
        TRIAL,
        PixelFormat::Nv12,
        [
            Plane {
                data: vec![96; w * h],
                stride: w,
            },
            Plane {
                data: vec![128; w * h / 2],
                stride: w,
            },
        ],
        0,
    )?))
}

fn trial_encode(
    runtime: &NvRuntime,
    codec: Codec,
    stop: &dyn Fn() -> bool,
) -> (ProbeOutcome, Option<media_codec::EncodedUnit>) {
    if stop() {
        return (ProbeOutcome::Cancelled, None);
    }
    let mut encoder = match NvEncoder::open_cuda(runtime, Preset::P1) {
        Ok(encoder) => encoder,
        Err(e) => return (failed(e), None),
    };
    let spec = EncodeSpec {
        codec,
        size: TRIAL,
        fps: 30,
        rate: RateControl::Bitrate(1_000_000),
    };
    let steps = (|| {
        encoder.configure(&spec)?;
        if stop() {
            return Ok(None);
        }
        encoder.encode(trial_picture()?, true)?;
        encoder.flush()?;
        encoder.poll_result()
    })();
    match steps {
        _ if stop() => (ProbeOutcome::Cancelled, None),
        Ok(Some(unit)) if unit.key && !unit.data.is_empty() => (
            ProbeOutcome::Ok {
                max: encoder.caps().max_size,
            },
            Some(unit),
        ),
        Ok(_) => (
            ProbeOutcome::Failed("NVENC returned no keyframe".into()),
            None,
        ),
        Err(e) => (failed(e), None),
    }
}

fn trial_decode(
    runtime: &NvRuntime,
    codec: Codec,
    unit: &media_codec::EncodedUnit,
    stop: &dyn Fn() -> bool,
) -> ProbeOutcome {
    let result = NvDecoder::new(runtime, codec, Some(TRIAL_OUTPUT)).and_then(|mut decoder| {
        if stop() {
            return Ok(None);
        }
        decoder
            .decode(unit)
            .map(|p| p.map(|p| (p.size(), decoder.max())))
    });
    match result {
        _ if stop() => ProbeOutcome::Cancelled,
        Ok(Some((size, max))) if size == TRIAL_OUTPUT => ProbeOutcome::Ok { max },
        Ok(Some((size, _))) => ProbeOutcome::Failed(format!(
            "NVDEC returned {}x{}, asked for {}x{}",
            size.width, size.height, TRIAL_OUTPUT.width, TRIAL_OUTPUT.height
        )),
        Ok(None) => ProbeOutcome::Failed("NVDEC returned no picture".into()),
        Err(e) => failed(e),
    }
}

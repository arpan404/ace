// SPDX-License-Identifier: Apache-2.0
//! The Linux backends' trials (B3's VA-API, B5's NVENC/NVDEC), in the probe's shape. A
//! machine without a backend reports nothing for it, so its steps fall to the CPU or the
//! last-resort encoder without being called degraded.
use super::Trial;
use media_codec::Codec;
use media_nv::{NvProbe, ProbeOutcome, ProbeStep};
use media_wire::capability::{Backend, Capability, Step, TrialState};

pub struct VaapiTrial;

impl Trial for VaapiTrial {
    fn steps(&self) -> Vec<(Step, Option<String>, Backend)> {
        media_vaapi::trial_steps()
    }

    fn run(self: Box<Self>, publish: &mut dyn FnMut(Vec<Capability>), stop: &dyn Fn() -> bool) {
        publish(media_vaapi::run_trial(stop));
    }
}

const NV_H264: &str = "avc1.640028";
const NV_HEVC: &str = "hvc1.1.6.L120.B0";

pub struct NvTrial;

impl Trial for NvTrial {
    fn steps(&self) -> Vec<(Step, Option<String>, Backend)> {
        [Step::Encode, Step::Decode]
            .into_iter()
            .flat_map(|step| {
                [NV_H264, NV_HEVC].map(|codec| (step, Some(codec.to_owned()), Backend::Nv))
            })
            .collect()
    }

    fn run(self: Box<Self>, publish: &mut dyn FnMut(Vec<Capability>), stop: &dyn Fn() -> bool) {
        publish(nv_entries(media_nv::probe(stop)));
    }
}

/// NVENC and NVDEC are hardware wherever their trial worked. The trial feeds NVENC from CPU
/// memory, so it doesn't claim the capture path's zero copy. Absent, or off by default (the
/// unverified layout), there is no backend to list.
fn nv_entries(probe: NvProbe) -> Vec<Capability> {
    let NvProbe::Present(entries) = probe else {
        return Vec::new();
    };
    entries
        .into_iter()
        .map(|entry| {
            let (state, max) = match entry.outcome {
                ProbeOutcome::Ok { max } => (TrialState::Ok, Some(max)),
                ProbeOutcome::Failed(_) => (TrialState::Failed, None),
                ProbeOutcome::Cancelled => (TrialState::TimedOut, None),
            };
            Capability {
                step: match entry.step {
                    ProbeStep::Encode => Step::Encode,
                    ProbeStep::Decode => Step::Decode,
                },
                codec: Some(
                    if entry.codec == Codec::Hevc {
                        NV_HEVC
                    } else {
                        NV_H264
                    }
                    .into(),
                ),
                backend: Backend::Nv,
                hardware: max.is_some(),
                zero_copy: false,
                state,
                max_width: max.map_or(0, |m| m.width),
                max_height: max.map_or(0, |m| m.height),
            }
        })
        .collect()
}

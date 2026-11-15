//! Which encoder a Linux screen uses, what the hello reports about it, and what a running
//! stream says about its steps (docs/media/plan.md, "Helper changes > Linux", ADR 0148). Pure:
//! the trials' results and the capture's buffer kind come in, decisions come out.
//!
//! Order: VA-API (Intel, AMD), then NVENC (NVIDIA), then the last-resort Chrome encoder.
//! VA-API is routed to only with `ACE_SCREEN_VAAPI=1` until it has passed on real Intel and
//! AMD machines (B3), and NVENC only with media-nv's own `ACE_MEDIA_NV=1` (B5); without
//! them a machine takes the last-resort encoder and says so.
use media_wire::capability::{Acceleration, Backend, Capability, SourceStep, Step, TrialState};

/// The opt-in that lets screens use VA-API before its hardware runs have passed.
pub const VAAPI_OPT_IN: &str = "ACE_SCREEN_VAAPI";

/// The sentence a stream on the last-resort encoder carries in its status line.
pub const LAST_RESORT_REASON: &str =
    "Video runs on the processor here: this computer has no hardware video encoder.";

/// What the trials at helper start found, H.264 encode only (screens send H.264).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Trials {
    /// VA-API's H.264 encode trial; absent without libva, a render node, the driver's
    /// encoder, or the opt-in.
    pub vaapi: Option<Capability>,
    /// NVENC's H.264 encode trial; absent without the driver or the opt-in.
    pub nv: Option<Capability>,
    /// The last-resort encoder's trial; run only when neither of the others worked.
    pub chrome: Option<Capability>,
}

/// How the capture hands pictures over.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Capture {
    /// GPU buffers (`SPA_DATA_DmaBuf`): imported, never touched by the CPU.
    DmaBuf,
    /// Shared memory: uploaded once to the GPU encoder, or read by the CPU.
    SharedMemory,
}

fn usable(capability: &Option<Capability>) -> Option<&Capability> {
    capability
        .as_ref()
        .filter(|c| c.step == Step::Encode && c.state == TrialState::Ok)
}

fn hardware(capability: &Option<Capability>) -> Option<&Capability> {
    usable(capability).filter(|c| c.hardware)
}

/// Whether the last-resort trial is worth running: no hardware encoder worked.
pub fn last_resort_needed(trials: &Trials) -> bool {
    hardware(&trials.vaapi).is_none() && hardware(&trials.nv).is_none()
}

/// The encoder a stream opens: the first that worked, in the order above. `None` when no
/// encoder works here, and the helper offers JPEG only.
pub fn choose(trials: &Trials) -> Option<&Capability> {
    hardware(&trials.vaapi)
        .or_else(|| hardware(&trials.nv))
        .or_else(|| usable(&trials.chrome))
}

/// The hello's `encoders`: capture → encode, every trial that ran, the chosen one first.
/// `capture` is the running stream's buffer kind once one is known: a stream on shared memory
/// isn't zero copy whatever the driver could import.
pub fn encoders(trials: &Trials, capture: Option<Capture>) -> Vec<Capability> {
    let chosen = choose(trials).cloned();
    let mut out: Vec<Capability> = chosen.iter().cloned().collect();
    for c in [&trials.vaapi, &trials.nv, &trials.chrome]
        .into_iter()
        .flatten()
    {
        if Some(c) != chosen.as_ref() {
            out.push(c.clone());
        }
    }
    for c in &mut out {
        c.zero_copy &= c.hardware && capture != Some(Capture::SharedMemory);
    }
    out
}

/// A stream's steps on `backend`, with its picture-sized copies per frame.
pub fn acceleration(backend: Backend, capture: Capture) -> Acceleration {
    let shared = u32::from(capture == Capture::SharedMemory);
    let step = |step, backend, hardware, uploads| SourceStep {
        step,
        backend,
        hardware,
        readbacks: 0,
        uploads,
    };
    match backend {
        Backend::Vaapi | Backend::Nv => Acceleration {
            // A shared-memory picture is uploaded once, before the GPU scales it.
            steps: vec![
                step(Step::Scale, backend, true, shared),
                step(Step::Encode, backend, true, 0),
            ],
            degraded: false,
            reason: None,
        },
        _ => Acceleration {
            // A GPU buffer the CPU must scale is read back once first.
            steps: vec![
                SourceStep {
                    readbacks: 1 - shared,
                    ..step(Step::Scale, Backend::Cpu, false, 0)
                },
                step(Step::Encode, backend, false, 0),
            ],
            degraded: true,
            reason: Some(LAST_RESORT_REASON.into()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trial(backend: Backend, hardware: bool, state: TrialState) -> Option<Capability> {
        Some(Capability {
            step: Step::Encode,
            codec: Some("avc1.640028".into()),
            backend,
            hardware,
            zero_copy: hardware,
            state,
            max_width: 4096,
            max_height: 4096,
        })
    }

    #[test]
    fn va_api_wins_over_nvenc_and_both_over_the_last_resort() {
        let all = Trials {
            vaapi: trial(Backend::Vaapi, true, TrialState::Ok),
            nv: trial(Backend::Nv, true, TrialState::Ok),
            chrome: trial(Backend::Chrome, false, TrialState::Ok),
        };
        assert_eq!(choose(&all).map(|c| c.backend), Some(Backend::Vaapi));
        let nv = Trials {
            vaapi: None,
            ..all.clone()
        };
        assert_eq!(choose(&nv).map(|c| c.backend), Some(Backend::Nv));
        let neither = Trials {
            vaapi: None,
            nv: None,
            ..all
        };
        assert_eq!(choose(&neither).map(|c| c.backend), Some(Backend::Chrome));
    }

    #[test]
    fn a_hardware_trial_that_failed_or_timed_out_is_never_chosen() {
        let trials = Trials {
            vaapi: trial(Backend::Vaapi, true, TrialState::Failed),
            nv: trial(Backend::Nv, true, TrialState::TimedOut),
            chrome: trial(Backend::Chrome, false, TrialState::Ok),
        };
        assert!(last_resort_needed(&trials));
        assert_eq!(choose(&trials).map(|c| c.backend), Some(Backend::Chrome));
    }

    #[test]
    fn with_no_encoder_at_all_the_helper_offers_none() {
        let trials = Trials {
            chrome: trial(Backend::Chrome, false, TrialState::Failed),
            ..Trials::default()
        };
        assert!(choose(&trials).is_none());
        assert_eq!(
            encoders(&trials, None).len(),
            1,
            "the failed trial is still reported"
        );
    }

    #[test]
    fn the_hello_lists_the_chosen_encoder_first_and_shared_memory_is_never_zero_copy() {
        let trials = Trials {
            vaapi: trial(Backend::Vaapi, true, TrialState::Failed),
            nv: trial(Backend::Nv, true, TrialState::Ok),
            chrome: None,
        };
        let listed = encoders(&trials, None);
        assert_eq!(
            listed.iter().map(|c| c.backend).collect::<Vec<_>>(),
            [Backend::Nv, Backend::Vaapi]
        );
        assert!(listed[0].zero_copy);
        assert!(!encoders(&trials, Some(Capture::SharedMemory))[0].zero_copy);
        assert!(encoders(&trials, Some(Capture::DmaBuf))[0].zero_copy);
    }

    #[test]
    fn gpu_buffers_make_no_copies_and_shared_memory_one_upload() {
        let zero = acceleration(Backend::Vaapi, Capture::DmaBuf);
        assert!(!zero.degraded);
        assert!(
            zero.steps
                .iter()
                .all(|s| s.hardware && s.readbacks == 0 && s.uploads == 0)
        );
        let shared = acceleration(Backend::Nv, Capture::SharedMemory);
        assert_eq!(shared.steps.iter().map(|s| s.uploads).sum::<u32>(), 1);
    }

    #[test]
    fn the_last_resort_is_degraded_and_says_so() {
        let fallback = acceleration(Backend::Chrome, Capture::SharedMemory);
        assert!(fallback.degraded);
        assert_eq!(fallback.reason.as_deref(), Some(LAST_RESORT_REASON));
        assert!(fallback.steps.iter().all(|s| !s.hardware));
        assert_eq!(fallback.steps[1].backend, Backend::Chrome);
    }
}

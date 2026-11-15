// SPDX-License-Identifier: Apache-2.0
//! What a source runs on, and whether it is degraded (docs/media/plan.md, "Degraded, and the
//! visible sentence"). Pure: every producer of `source.status.acceleration` (the JPEG encoder,
//! the Simulator transcode) builds its report here, from the steps it runs and what the probe
//! found.
//!
//! A source is degraded when its video encode is not on hardware (the software MFT, the CPU
//! or the last-resort Chrome encoder), or when a step the probe listed for hardware runs on the
//! CPU. "Listed" means a hardware backend has an entry for the step: one whose trial worked
//! on hardware, or one whose trial failed or timed out. A step on the CPU because no hardware
//! backend has an entry for it at all (JPEG on NVIDIA, JPEG encode on most AMD) is the
//! machine's expected path, not a fallback.
use media_wire::capability::{Acceleration, Backend, Capability, SourceStep, Step, TrialState};

/// The one sentence a degraded source's live view carries.
fn sentence(step: Step, listed_failed: bool) -> &'static str {
    match (step, listed_failed) {
        (Step::Encode, false) => {
            "Video runs on the processor here: this computer has no hardware video encoder."
        }
        (Step::Encode, true) => {
            "Video runs on the processor here: the hardware video encoder didn't start."
        }
        (Step::Decode, _) => "Video is decoded on the processor here: the hardware decoder failed.",
        (Step::JpegDecode, _) => {
            "Pictures are decoded on the processor here: the hardware decoder failed."
        }
        (Step::JpegEncode, _) => {
            "Stills are made on the processor here: the hardware JPEG encoder failed."
        }
        (Step::Scale, _) => {
            "Pictures are scaled on the processor here: the hardware scaler failed."
        }
    }
}

fn hardware_backend(backend: Backend) -> bool {
    !matches!(backend, Backend::Cpu | Backend::Chrome)
}

/// How the probe listed `step` on hardware backends: `None` when none has an entry for it,
/// `Some(true)` when only failed or timed-out trials do, `Some(false)` when one worked.
fn listed(probed: &[Capability], step: Step) -> Option<bool> {
    let entries = probed
        .iter()
        .filter(|c| c.step == step && hardware_backend(c.backend));
    let mut any = false;
    for entry in entries {
        match entry.state {
            TrialState::Ok if entry.hardware => return Some(false),
            TrialState::Ok => {}
            TrialState::Failed | TrialState::TimedOut => any = true,
        }
    }
    any.then_some(true)
}

/// The report for a source running `steps`, given what the probe found.
pub fn assess(probed: &[Capability], steps: Vec<SourceStep>) -> Acceleration {
    let mut reason = None;
    for step in steps.iter().filter(|s| !s.hardware) {
        let listing = listed(probed, step.step);
        let degraded = step.step == Step::Encode || listing.is_some();
        if degraded {
            reason = Some(sentence(step.step, listing == Some(true)));
            // The encode's sentence wins: it is the one the viewer feels most.
            if step.step == Step::Encode {
                break;
            }
        }
    }
    Acceleration {
        steps,
        degraded: reason.is_some(),
        reason: reason.map(Into::into),
    }
}

#[cfg(test)]
#[path = "acceleration_tests.rs"]
mod tests;

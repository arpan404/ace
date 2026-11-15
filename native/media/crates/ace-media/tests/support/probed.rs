// SPDX-License-Identifier: Apache-2.0
//! What this Mac's VideoToolbox trial finally found, as ace-media ends up holding it: the list
//! `ready` carries, with every late result applied the way `capabilities.changed` applies it
//! (`probe::Capabilities::update`), once the trial has finished. On a busy machine a step can
//! miss the 2 s deadline and only arrive late; comparing against `ready` alone would read it
//! too early.
use ace_media::probe::{Cancel, TRIAL_DEADLINE, VtTrial, probe};
use media_wire::control::Capability;

pub fn probed() -> Vec<Capability> {
    let (mut capabilities, late) =
        probe(vec![Box::new(VtTrial)], TRIAL_DEADLINE, &Cancel::default());
    // Ends once the trial has returned; the worker itself is bounded (`media_vt::LATE_LIMIT`).
    for (trial, found) in late.iter() {
        capabilities.update(trial, found);
    }
    capabilities.list()
}

// SPDX-License-Identifier: Apache-2.0
//! What this Mac's VideoToolbox trial finally found, as ace-media ends up holding it: the list
//! `ready` carries, with every late result applied the way `capabilities.changed` applies it
//! (`probe::Capabilities::update`), once the trial has finished. On a busy machine a step can
//! miss the 2 s deadline and only arrive late; comparing against `ready` alone would read it
//! too early. Every wait is bounded: `media_vt::LATE_LIMIT` can't interrupt a native call that
//! never returns.
use ace_media::probe::{Cancel, Capabilities, TRIAL_DEADLINE, VtTrial, probe};
use media_wire::control::{Capability, TrialState};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

/// The longest a trial, and so the wait for its final answer, may take: its deadline, the
/// worker's late limit, and slack for a loaded machine.
pub fn settle_within() -> Duration {
    TRIAL_DEADLINE + media_vt::LATE_LIMIT + Duration::from_secs(5)
}

/// Entries, as the wire names them, one per line.
pub fn describe(entries: &[&Capability]) -> String {
    entries
        .iter()
        .map(|c| serde_json::to_string(c).unwrap_or_else(|_| format!("{c:?}")))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Applies late results until the trial is done (`Ok`), or `within` passes (`Err`, naming the
/// entries that still hadn't succeeded).
pub fn settle(
    mut capabilities: Capabilities,
    late: &Receiver<(usize, Vec<Capability>)>,
    within: Duration,
) -> Result<Vec<Capability>, String> {
    let end = Instant::now() + within;
    loop {
        match late.recv_timeout(end.saturating_duration_since(Instant::now())) {
            Ok((trial, found)) => capabilities.update(trial, found),
            Err(RecvTimeoutError::Disconnected) => return Ok(capabilities.list()),
            Err(RecvTimeoutError::Timeout) => {
                let list = capabilities.list();
                let unsettled: Vec<&Capability> =
                    list.iter().filter(|c| c.state != TrialState::Ok).collect();
                return Err(describe(&unsettled));
            }
        }
    }
}

pub fn probed() -> Vec<Capability> {
    let cancel = Cancel::default();
    let (capabilities, late) = probe(vec![Box::new(VtTrial)], TRIAL_DEADLINE, &cancel);
    let settled = settle(capabilities, &late, settle_within());
    cancel.cancel();
    settled.unwrap_or_else(|unsettled| {
        panic!(
            "this Mac's VideoToolbox trial didn't finish within {:?}; still unsettled:\n{unsettled}",
            settle_within()
        )
    })
}

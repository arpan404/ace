// SPDX-License-Identifier: Apache-2.0
//! The shell-output snapshot rule of `output-snapshot.ts`: snapshots append
//! only when their observed prefix agrees with the bounded stream tail.

use crate::item_model::OutputSummary;

/// Whether `aggregate` extends `prior`: it must be at least as long, and the
/// bytes it shares with the tail must agree exactly.
pub fn extends_output(prior: Option<&OutputSummary>, aggregate: &str) -> bool {
    let bytes = aggregate.as_bytes();
    let size = prior.map_or(0, |summary| summary.bytes.max(0) as usize);
    let tail = prior.map_or("", |summary| summary.tail.as_str());
    let tail_size = tail.as_bytes().len();
    if bytes.len() < size {
        return false;
    }
    let start = size.saturating_sub(tail_size);
    bytes.get(start..size).unwrap_or(b"") == tail.as_bytes()
}

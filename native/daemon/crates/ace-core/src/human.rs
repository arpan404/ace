// SPDX-License-Identifier: Apache-2.0
//! The human-attention rule of `human.ts`: the same rule governs thread
//! status and notification links.

/// Whether an interaction needs the person: pending, and either blocking or
/// its owner is not itself working.
pub fn is_actionable_interaction(
    state: &str,
    blocking: bool,
    owner_state: Option<&str>,
) -> bool {
    state == "pending" && (blocking || owner_state != Some("working"))
}

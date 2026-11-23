// SPDX-License-Identifier: Apache-2.0
//! Whether live background work holds its thread open (`background-hold.ts`,
//! ADR 0004 as amended by ADR 0109 and ADR 0116). Pure.

/// The task fields the hold decision reads.
pub struct HoldFacts<'a> {
    /// Long-lived helpers never hold a thread open.
    pub ambient: bool,
    /// The task kind: commands and monitors stop holding after a reply.
    pub kind: &'a str,
    /// ace's own bookkeeping always holds.
    pub internal: bool,
    /// Work beside which the provider takes no new prompt always holds.
    pub blocks_prompts: bool,
}

/// Work an agent leaves running after its final reply that no longer keeps
/// the thread open.
fn released_kind(kind: &str) -> bool {
    matches!(kind, "shell" | "monitor")
}

/// Whether live background work holds its thread open. While its agent
/// works, all of it does, and so after a turn that was stopped or failed.
/// `replied`: its agent and the thread's main agent both finished their turns
/// on their own.
pub fn holds_thread(task: &HoldFacts<'_>, replied: bool) -> bool {
    if task.ambient {
        return false;
    }
    if !replied {
        return true;
    }
    task.internal || task.blocks_prompts || !released_kind(task.kind)
}

/// Running work the thread no longer waits for: shown as left running.
pub fn left_running(
    ambient: bool,
    status_running: bool,
    kind: &str,
    internal: bool,
    blocks_prompts: bool,
    replied: bool,
) -> bool {
    status_running
        && !ambient
        && !holds_thread(
            &HoldFacts {
                ambient,
                kind,
                internal,
                blocks_prompts,
            },
            replied,
        )
}

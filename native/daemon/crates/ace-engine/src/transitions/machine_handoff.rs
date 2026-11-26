// SPDX-License-Identifier: Apache-2.0
//! `machine-handoff.ts` (E5.9): a thread's history carried to another machine (ADR 0101).
//!
//! The capture is the same bounded, conversation-first handoff a provider switch builds
//! (`transition-history.ts`'s `handoff`), and the target keeps it waiting on the new thread so it
//! goes in front of the person's next message there. Cases ported from
//! `context-handoff.process.test.ts` and `machine-handoff` rows of `workspace-change.process`.

/// About 8k tokens, as a cross-provider switch carries (`machine-handoff.ts:13`).
pub const MACHINE_HANDOFF_BYTES: usize = 32_768;

/// `machineHandoffNote` (`:33`): what the new agent is told beyond the excerpts.
pub fn machine_handoff_note(machine: &str) -> String {
    format!(
        "This thread continues one from {machine}. The handoff above was carried from there: \
         its earlier items, full tool output and attachments stayed on {machine} and can't be read from this machine."
    )
}

/// `handoff:<commandId>`: the transcript marker a carried handoff waits behind (`:47`).
pub fn machine_handoff_marker(command_id: &str) -> String {
    format!("handoff:{command_id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    // From `context-handoff.process.test.ts`: a handoff carried to another machine says where it
    // came from, and its marker is the command's own so a retry is recognised.
    #[test]
    fn a_machine_handoff_names_the_machine_it_came_from() {
        assert_eq!(
            machine_handoff_note("studio"),
            "This thread continues one from studio. The handoff above was carried from there: \
             its earlier items, full tool output and attachments stayed on studio and can't be read from this machine."
        );
        assert_eq!(machine_handoff_marker("cmd-1"), "handoff:cmd-1");
        assert_eq!(MACHINE_HANDOFF_BYTES, 32_768);
    }
}

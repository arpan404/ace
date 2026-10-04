# 0065: Transcript input admission and provenance

Date: 2026-10-04. Status: accepted.

The daemon creates a complete user transcript item when it accepts a send, before
opening a provider. Its stable ID is `input:<commandId>`. Clients can display a
pending send under that same ID and replace it when the daemon item arrives.
Transport loss leaves durable commands pending until a receipt or definite refusal.

Input origins distinguish the person's text from interaction answers, delegated
work, handoffs, automation, restart and limit continuation. Optional fields keep
older history readable. Echo matching belongs to the daemon, uses an indexed,
durable journal and matches the oldest sent input with the same text on the root
agent. Echoes update the admitted item, preserve original person-authored parts,
and record the provider's native boundary. They never create another user bubble.

Stop fences the run it targets and pauses queued input. Provider admission and
run completion remain distinct facts. Neither an echo nor a receipt means the
agent tree has completed.

// SPDX-License-Identifier: Apache-2.0
//! The device how-to (`packages/devices/src/sim-guidance.ts`). It reaches an agent
//! only in the result of its first start of a device, so threads that never use a
//! simulator carry none of it.

/// `simGuidance`: the how-to, naming this device and thread.
pub fn sim_guidance(sim_id: &str, thread_id: &str) -> String {
    let cli = format!("ace sim <verb> {sim_id} --thread {thread_id}");
    [
        format!("Driving {sim_id}. Refs first:"),
        String::from("1. Read the screen with sim_ui (pass name, text or role to find). Actionable elements carry refs like @e3; a ref stays valid while its element is on screen."),
        String::from("2. Act on a ref: sim_act {action:\"tap\", ref:\"@e3\"}, {action:\"type\", ref:\"@e3\", text}, or {action:\"ui\", ref, uiAction}. Coordinates (x,y) are the fallback for things without a ref."),
        String::from("3. Read again after the screen changes. stale_ref means the element is gone: read again rather than guessing coordinates."),
        String::from("sim_screenshot only for visual checks (it costs more); it works with or without the live view. sim_stop when you finish."),
        format!("The same tools from a shell, with JSON results and the same refs: {cli} (verbs: list, start, stop, ui, act, screenshot, logs; ace sim --help)."),
        String::from("lease_required means the person took the device: wait, then sim_start again."),
    ]
    .join("\n")
}

#[cfg(test)]
mod tests;

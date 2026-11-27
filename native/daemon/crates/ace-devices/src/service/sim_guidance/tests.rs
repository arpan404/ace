// SPDX-License-Identifier: Apache-2.0
//! The device how-to (`sim-guidance.ts`), byte for byte.
//!
//! `sim-guidance.ts` has no test file of its own (behaviour.md §5 lists none),
//! so this case is the module's only guard.

use super::sim_guidance;

#[test]
fn the_how_to_names_the_device_and_thread() {
    let guidance = sim_guidance("ios:AAAA", "t1");
    let expected = [
        "Driving ios:AAAA. Refs first:",
        "1. Read the screen with sim_ui (pass name, text or role to find). Actionable elements carry refs like @e3; a ref stays valid while its element is on screen.",
        "2. Act on a ref: sim_act {action:\"tap\", ref:\"@e3\"}, {action:\"type\", ref:\"@e3\", text}, or {action:\"ui\", ref, uiAction}. Coordinates (x,y) are the fallback for things without a ref.",
        "3. Read again after the screen changes. stale_ref means the element is gone: read again rather than guessing coordinates.",
        "sim_screenshot only for visual checks (it costs more); it works with or without the live view. sim_stop when you finish.",
        "The same tools from a shell, with JSON results and the same refs: ace sim <verb> ios:AAAA --thread t1 (verbs: list, start, stop, ui, act, screenshot, logs; ace sim --help).",
        "lease_required means the person took the device: wait, then sim_start again.",
    ]
    .join("\n");
    assert_eq!(guidance, expected);
}

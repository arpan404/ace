// SPDX-License-Identifier: Apache-2.0
//! `hasRunningForegroundCommand` (`core/src/steering.ts:26`): a foreground shell command runs to
//! completion before a steer is delivered, and a promoted background command never holds it.

use ace_core::ThreadState;
use ace_core::item_model::ToolDetail;
use ace_core::items::Item;
use std::collections::HashSet;

/// Whether a running foreground shell command holds the thread.
pub fn has_running_foreground_command(state: &ThreadState) -> bool {
    let Some(root_key) = state.root_key.as_deref() else {
        return false;
    };
    let Some(root) = state
        .agents
        .get(root_key)
        .map(|record| record.agent.id.as_str())
    else {
        return false;
    };
    // Read only live work, never transcript history; background tasks do not hold steering.
    let background: HashSet<&str> = state
        .indexes
        .running_tasks
        .keys()
        .filter_map(|key| state.tasks.get(key))
        .filter_map(|task| task.tool_call_id.as_deref())
        .collect();
    for key in state.indexes.live_tools.keys() {
        let Some(Item::ToolCall { call, .. }) = state.items.get(key) else {
            continue;
        };
        if call.agent_id != root {
            continue;
        }
        if call.status == "running"
            && matches!(call.detail, ToolDetail::Shell { .. })
            && !background.contains(key.as_str())
        {
            return true;
        }
    }
    false
}

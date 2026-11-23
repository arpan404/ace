// SPDX-License-Identifier: Apache-2.0
//! Implicit turns opened by work after the prompt answered (`lifecycle.ts`).

use crate::translate::state::TranslationState;
use serde_json::Value;

/// Work after the root's prompt answered opens an implicit turn.
pub fn settle_implicit_turn(state: &mut TranslationState, facts: &mut Vec<Value>) {
    if !state.root.implicit_turn {
        return;
    }
    if state.prompt_open || !state.root.active {
        state.root.implicit_turn = false;
        return;
    }
    for tool_key in state.live_tools.iter() {
        if let Some(tool) = state.tools.get(tool_key)
            && tool.owner_key == state.root.key
            && tool.task.is_none()
        {
            return;
        }
    }
    state.root.implicit_turn = false;
    let root_key = state.root.key.clone();
    state.end(&root_key, facts, "completed", None);
}

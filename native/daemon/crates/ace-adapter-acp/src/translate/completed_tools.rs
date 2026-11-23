// SPDX-License-Identifier: Apache-2.0
//! Published payloads belong to canonical storage (`completed-tools.ts`).

use crate::translate::state::TranslationState;

/// Keep only a bounded late-event window.
pub fn retire_tool(state: &mut TranslationState, tool_key: &str) {
    crate::translate::state::retire_tool(state, tool_key);
}

/// A renewed tool leaves the retirement window.
pub fn renew_tool(state: &mut TranslationState, tool_key: &str) {
    crate::translate::state::renew_tool(state, tool_key);
}

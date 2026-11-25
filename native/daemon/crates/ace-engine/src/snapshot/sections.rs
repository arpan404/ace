// SPDX-License-Identifier: Apache-2.0
//! The record section names (E5.3 step 4). Section names are contract: every name here is a
//! row's `section` in `engine_state_records` and `engine_state_appends`, and the TypeScript
//! engine reads the same rows. `persistence.ts:107`-`:141`, `agent metadata` at `:58`.

/// A thread's record sections, in the TypeScript constructor's order.
pub const SECTIONS: [&str; 17] = [
    "agents",
    "items",
    "itemMetadata",
    "runs",
    "interactions",
    "tasks",
    "interactionHistory",
    "taskHistory",
    "itemLinks",
    "liveTools",
    "openText",
    "pendingInteractions",
    "runningTasks",
    "agentKeysById",
    "childrenByParent",
    "pendingSpawnLinks",
    "pendingItemLinks",
];

/// An agent's `nativeRuns` live in their own section, `nativeRuns:<agentKey>` (`:58`).
pub fn native_runs(key: &str) -> String {
    format!("nativeRuns:{key}")
}

/// The `nativeRuns:` prefix.
pub const NATIVE_RUNS_PREFIX: &str = "nativeRuns:";

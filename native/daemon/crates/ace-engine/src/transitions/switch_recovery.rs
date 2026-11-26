// SPDX-License-Identifier: Apache-2.0
//! `switch-recovery.ts` (E5.9): whether a tree is blocked on a usage limit, whether a queued
//! switch may run before the tree is quiet, and the context a limited source leaves behind.
//!
//! Cases ported from `usage-switch-recovery.process.test.ts` and
//! `usage-switch-audit.process.test.ts`; the work-context lines themselves are failures E5.8's
//! `lost-work` reports, so the caller supplies them.

use ace_core::state::ThreadState;
use ace_core::thread_status::ThreadStatus;
use ace_json::Value;

use crate::intents::header::IntentHeader;

/// `usageBlocked`: any agent is limited, by our record or the provider's own status.
pub fn usage_blocked(state: &ThreadState) -> bool {
    state.agents.values().any(|record| {
        record.limited.is_some()
            || matches!(record.external_status, Some(ThreadStatus::Limited { .. }))
    })
}

fn selection(value: Option<&Value>) -> Option<(&str, Option<&str>, Option<&str>)> {
    let value = value?;
    Some((
        value.get("provider").and_then(Value::as_str)?,
        value.get("model").and_then(Value::as_str),
        value.get("instanceId").and_then(Value::as_str),
    ))
}

/// `switchReady` (`switch-recovery.ts:16`): a queued switch may cut a limited tree off early,
/// without letting an unrelated limited child stop healthy foreground work in the root.
pub fn switch_ready(
    state: &ThreadState,
    intent: &IntentHeader,
    tree_quiescent: bool,
    requested: Option<&Value>,
    current: Option<&Value>,
) -> bool {
    if tree_quiescent {
        return true;
    }
    if intent.kind != "thread.switch" || !usage_blocked(state) {
        return false;
    }
    let (Some(requested), Some(current)) = (selection(requested), selection(current)) else {
        return false;
    };
    if requested == current {
        return false;
    }
    let root = state
        .root_key
        .as_deref()
        .and_then(|key| state.agents.get(key));
    // An unrelated limited child must not cut off healthy foreground work in the root.
    match root {
        None => true,
        Some(root) => {
            root.limited.is_some()
                || root.active_run.is_none()
                || matches!(
                    &root.agent.status,
                    ace_core::status::AgentStatus::Blocked { on, .. }
                        if on == "subagents" || on == "background_task"
                )
        }
    }
}

/// `switchWorkContext` (`switch-recovery.ts:44`): the recovered work and the children still
/// running, as one bounded note. `native` is E5.8's `lostWorkLines(state, 0, now)`.
pub fn switch_work_context(state: &ThreadState, native: &[String]) -> Option<String> {
    let children: Vec<String> = state
        .agents
        .values()
        .flat_map(|record| {
            let child = record.agent.child_thread_id.as_deref()?;
            let status = record.external_status.as_ref()?;
            let rendered = match status {
                ThreadStatus::Done | ThreadStatus::Failed => return None,
                other => serde_json::to_string(other).ok()?,
            };
            Some(format!(
                "{child}: {}, {rendered}",
                record.agent.native.provider
            ))
        })
        .collect();
    if native.is_empty() && children.is_empty() {
        return None;
    }
    let shown: Vec<&str> = children.iter().take(64).map(String::as_str).collect();
    let mut lines = vec![
        "Execution recovery after switching providers:".to_owned(),
        "A provider switch was requested. Source native work may have been interrupted and must be checked before restarting; no completion is implied.".to_owned(),
    ];
    lines.extend(native.iter().cloned());
    lines.push("Independent delegated threads retain their task identities and workspace. Working children continue. Eligible limited children are scheduled to switch to the selected replacement. Paused, stopped or uncertain children remain held; inspect their status before creating replacements.".to_owned());
    lines.extend(shown.into_iter().map(str::to_owned));
    if children.len() > 64 {
        lines.push(format!(
            "{} more children: inspect the agent tree.",
            children.len() - 64
        ));
    }
    let joined = lines.join("\n");
    let text = ace_json::JsString::from(joined.as_str());
    let end = 16_384.min(text.len_utf16());
    Some(text.slice_units(0, end).as_str().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ace_core::state::ThreadState;

    fn state() -> ThreadState {
        // The smallest state the status rules accept: a root-less thread with no work.
        serde_json::from_value(serde_json::json!({
            "threadId": "t",
            "config": { "provider": "claude", "silenceMs": 1000 },
            "status": { "state": "done" },
            "agents": {},
            "runs": {},
            "items": {},
            "interactions": {},
            "tasks": {},
            "interactionHistory": {},
            "taskHistory": {},
            "indexes": {
                "liveTools": {}, "pendingInteractions": {}, "runningTasks": {},
                "agentKeysById": {}, "childrenByParent": {}, "pendingSpawnLinks": {},
                "pendingItemLinks": {}
            },
            "outcomeOrder": 0,
            "pendingNotices": [],
            "itemLinks": {},
            "queueCount": 0,
            "queueSources": { "engine": 0, "provider": 0 },
            "hasRun": false
        }))
        .expect("a state")
    }

    fn agent(limited: bool, status: &str) -> serde_json::Value {
        let mut record = serde_json::json!({
            "agent": {
                "id": "a", "threadId": "t", "origin": "root",
                "native": { "provider": "claude" }, "fidelity": "full", "cwd": "/w",
                "status": { "state": "idle" }, "createdAt": 0
            },
            "activity": "idle",
            "lastSignalAt": 0
        });
        if limited {
            record["limited"] = serde_json::json!({});
        }
        if !status.is_empty() {
            record["externalStatus"] = serde_json::json!({ "state": status });
        }
        record
    }

    fn intent(kind: &str) -> IntentHeader {
        IntentHeader {
            id: 1,
            thread_id: "t".into(),
            command_id: "c".into(),
            kind: kind.into(),
            status: "pending".into(),
            attempts: 0,
            awaiting: false,
            ack_target: None,
            delivery: "queue".into(),
            acknowledged: false,
            resolution_id: None,
            resolution_generation: None,
            submitted_generation: None,
            trigger: None,
        }
    }

    // From `usage-switch-audit.process.test.ts`: a limited child does not cut off a root that
    // is working, unless the root itself is limited.
    #[test]
    fn a_queued_switch_passes_a_limited_tree_only_when_the_root_can_be_cut_off() {
        let mut state = state();
        state.agents.insert(
            "child".into(),
            serde_json::from_value(agent(true, "")).expect("a record"),
        );
        state.agents.insert(
            "root".into(),
            serde_json::from_value(agent(false, "")).expect("a record"),
        );
        state.root_key = Some("root".into());
        // Working, with a run the switch would cut off.
        if let Some(root) = state.agents.get_mut("root") {
            root.active_run = Some("run".into());
        }
        let requested = ace_json::json!({ "provider": "claude", "model": "m2" });
        let current = ace_json::json!({ "provider": "claude", "model": "m1" });
        assert!(!switch_ready(
            &state,
            &intent("thread.switch"),
            false,
            Some(&requested),
            Some(&current)
        ));
        // The root is limited itself: its healthy foreground work is over anyway.
        if let Some(root) = state.agents.get_mut("root") {
            root.limited = Some(Default::default());
        }
        assert!(switch_ready(
            &state,
            &intent("thread.switch"),
            false,
            Some(&requested),
            Some(&current)
        ));
        // A quiet tree takes any switch, and a non-switch intent never cuts in.
        assert!(switch_ready(
            &state,
            &intent("thread.switch"),
            true,
            Some(&requested),
            Some(&current)
        ));
        assert!(!switch_ready(
            &state,
            &intent("thread.send"),
            false,
            Some(&requested),
            Some(&current)
        ));
        // A switch to the selection already in force is not a replacement.
        assert!(!switch_ready(
            &state,
            &intent("thread.switch"),
            false,
            Some(&current),
            Some(&current)
        ));
    }

    #[test]
    fn switch_work_context_trims_on_a_utf16_code_unit_boundary_not_a_char_boundary() {
        let base = "\u{1F600}";
        let mut line = String::new();
        while ace_json::JsString::from(line.as_str()).len_utf16() < 20_000 {
            line.push_str(base);
        }
        let cut = switch_work_context(&state(), &[line]).expect("context");
        assert_eq!(ace_json::JsString::from(cut.as_str()).len_utf16(), 16_384);
    }

    // From `usage-switch-recovery.process.test.ts`: the context names recovered native work and
    // each still-running child, and nothing when there is neither.
    #[test]
    fn a_switch_context_names_recovered_work_and_running_children_only_when_there_are_any() {
        let mut state = state();
        assert_eq!(switch_work_context(&state, &[]), None);
        state.agents.insert(
            "root".into(),
            serde_json::from_value(agent(false, "")).expect("a record"),
        );
        let child = serde_json::json!({
            "agent": {
                "id": "child", "threadId": "t", "origin": "root",
                "native": { "provider": "codex" }, "fidelity": "summary", "cwd": "/w",
                "status": { "state": "idle" }, "createdAt": 0,
                "childThreadId": "child-thread"
            },
            "activity": "idle",
            "lastSignalAt": 0,
            "externalStatus": { "state": "working", "agents": 1 }
        });
        state.agents.insert(
            "child".into(),
            serde_json::from_value(child).expect("a record"),
        );
        let context =
            switch_work_context(&state, &["run 1 incomplete".to_owned()]).expect("a context");
        assert!(context.contains("run 1 incomplete"));
        assert!(context.contains("child-thread: codex, {\"state\":\"working\",\"agents\":1}"));
        assert!(context.starts_with("Execution recovery after switching providers:"));
        // A child that finished is not work the switch interrupts.
        if let Some(record) = state.agents.get_mut("child") {
            record.external_status = Some(ThreadStatus::Done);
        }
        assert_eq!(
            switch_work_context(&state, &["run 1 incomplete".to_owned()]),
            Some(
                [
                    "Execution recovery after switching providers:",
                    "A provider switch was requested. Source native work may have been interrupted and must be checked before restarting; no completion is implied.",
                    "run 1 incomplete",
                    "Independent delegated threads retain their task identities and workspace. Working children continue. Eligible limited children are scheduled to switch to the selected replacement. Paused, stopped or uncertain children remain held; inspect their status before creating replacements.",
                ]
                .join("\n")
            )
        );
    }
}

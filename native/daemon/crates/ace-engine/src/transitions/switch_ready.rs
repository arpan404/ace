// SPDX-License-Identifier: Apache-2.0
//! `switch-recovery.ts:6`-`:61` and `transition-history.ts:26` (E5.4f): whether a switch may
//! run now, whether a usage limit blocks the thread, and whether the provider still has work
//! that reopening or switching the session would end.

use ace_core::state::ThreadState;
use ace_core::status::ThreadStatus;
use ace_json::Value;

use crate::intents::header::IntentHeader;
use crate::{Core, EngineError, State};

/// A user-selected replacement may retire blocked native work instead of waiting for it.
pub fn usage_blocked(state: &ThreadState) -> bool {
    state.agents.values().any(|record| {
        record.limited.is_some()
            || matches!(record.external_status, Some(ThreadStatus::Limited { .. }))
    })
}

/// Provider background work still running, or lost track of: work that reopening or switching
/// the session would end. ace's own bookkeeping is not provider work.
pub fn runs_provider_work(state: &ThreadState) -> bool {
    state
        .indexes
        .running_tasks
        .keys()
        .any(|key| state.tasks.get(key).and_then(|task| task.owner.as_deref()) != Some("ace"))
        || !state.uncertain_tasks.is_empty()
}

/// `repo.quiescent(state)`: the tree holds no live work and every agent is ready.
pub fn quiescent(core: &Core, state: &mut State, thread: &str) -> Result<bool, EngineError> {
    let snapshot = state.repo.require_state(&core.store, thread)?;
    let view = snapshot
        .borrow_mut()
        .quiescence_view()
        .map_err(|_| EngineError::Reentrant)?;
    let ready = crate::transitions::readiness::agents_ready(core.store.conn(), thread)?;
    Ok(crate::transitions::readiness::quiescent(&view, ready))
}

/// `switchReady`: a switch waits for the tree, unless a usage limit makes retiring its work the
/// point of the switch.
pub fn switch_ready(
    core: &Core,
    state: &mut State,
    intent: &IntentHeader,
) -> Result<bool, EngineError> {
    if quiescent(core, state, &intent.thread_id)? {
        return Ok(true);
    }
    if intent.kind != "thread.switch" {
        return Ok(false);
    }
    let snapshot = state.repo.require_state(&core.store, &intent.thread_id)?;
    if !usage_blocked(&snapshot.borrow().state) {
        return Ok(false);
    }
    let requested = crate::commands::prelude::thread_row(core, &intent.thread_id)?
        .and_then(|row| row.get("switch").cloned())
        .and_then(|switch| switch.get("selection").cloned());
    let current = state
        .transition_get(&core.store, &intent.thread_id)?
        .selection;
    let same = |a: Option<&Value>, b: Option<&Value>, key: &str| {
        a.and_then(|value| value.get(key)) == b.and_then(|value| value.get(key))
    };
    let Some(requested) = requested else {
        return Ok(false);
    };
    let Some(current) = current else {
        return Ok(false);
    };
    if same(Some(&requested), Some(&current), "provider")
        && same(Some(&requested), Some(&current), "model")
        && same(Some(&requested), Some(&current), "instanceId")
    {
        return Ok(false);
    }
    // An unrelated limited child must not cut off healthy foreground work in the root.
    let borrowed = snapshot.borrow();
    let root = borrowed
        .state
        .root_key
        .as_deref()
        .and_then(|root| borrowed.state.agents.get(root));
    let Some(root) = root else {
        return Ok(false);
    };
    if root.limited.is_some() || root.active_run.is_none() {
        return Ok(true);
    }
    Ok(matches!(
        &root.agent.status,
        ace_core::status::AgentStatus::Blocked { on, .. }
            if on == "subagents" || on == "background_task"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ace_core::state::{AgentRecord, CoreConfig, create_thread_state};
    use ace_json::Value;

    fn value(text: &str) -> Value {
        ace_json::parse(text).expect("json")
    }

    fn thread_state() -> ThreadState {
        create_thread_state(
            "thread-1".to_owned(),
            None,
            CoreConfig {
                provider: "codex".to_owned(),
                silence_ms: 1_000.0,
                liveness: None,
            },
        )
        .expect("state")
    }

    fn agent(extra: &str) -> AgentRecord {
        ace_json::from_value(&value(&format!(
            r#"{{"agent":{{"id":"agent-1","threadId":"thread-1","parentId":null,"origin":"root","native":{{"provider":"codex"}},"status":{{"state":"idle"}},"fidelity":"full","cwd":"/test","background":false,"createdAt":1}},"activity":"idle","lastSignalAt":1{extra}}}"#
        )))
        .expect("record")
    }

    #[test]
    fn a_limited_agent_or_a_limited_external_status_blocks_usage() {
        assert!(!usage_blocked(&thread_state()));
        let mut limited = thread_state();
        limited
            .agents
            .insert("root".to_owned(), agent(r#","limited":{"until":9000}"#));
        assert!(usage_blocked(&limited));
        let mut external = thread_state();
        external.agents.insert(
            "root".to_owned(),
            agent(r#","externalStatus":{"state":"limited","until":9000}"#),
        );
        assert!(usage_blocked(&external));
        // Any other external status does not.
        let mut idle = thread_state();
        idle.agents.insert(
            "root".to_owned(),
            agent(r#","externalStatus":{"state":"idle"}"#),
        );
        assert!(!usage_blocked(&idle));
    }

    #[test]
    fn provider_work_is_a_running_task_aces_own_bookkeeping_is_not_and_an_uncertain_one_is() {
        let mut state = thread_state();
        assert!(!runs_provider_work(&state));
        state
            .indexes
            .running_tasks
            .insert("task-1".to_owned(), true);
        state.tasks.insert(
            "task-1".to_owned(),
            ace_json::from_value(&value(
                r#"{"id":"task-1","agentId":"agent-1","kind":"shell","title":"Run","status":"running","ambient":false,"stoppable":true,"owner":"ace","startedAt":1}"#,
            ))
            .expect("task"),
        );
        assert!(!runs_provider_work(&state));
        state.tasks.get_mut("task-1").expect("task").owner = Some("provider".to_owned());
        assert!(runs_provider_work(&state));
        // An uncertain task counts even with nothing running.
        let mut uncertain = thread_state();
        uncertain.uncertain_tasks.insert("task-2".to_owned(), true);
        assert!(runs_provider_work(&uncertain));
    }
}

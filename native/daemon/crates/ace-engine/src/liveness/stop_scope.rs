// SPDX-License-Identifier: Apache-2.0
//! Ported by E5.4d as a synchronous receipt dependency; owned by E5.10.
//!
//! `stop-scope.ts:10` (`targetsRoot`): whether a Stop is about the thread's root agent. Naming
//! the root agent's own id is the same as naming no agent.

/// The Stop is about the thread's root agent: no agent named, or the root's own id.
pub fn targets_root(agent_id: Option<&str>, root_agent_id: Option<&str>) -> bool {
    match agent_id {
        None => true,
        Some(agent) => Some(agent) == root_agent_id,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stop_targets_the_root_when_it_names_none_or_the_roots_own_id() {
        assert!(targets_root(None, Some("root")));
        assert!(targets_root(None, None));
        assert!(targets_root(Some("root"), Some("root")));
        assert!(!targets_root(Some("child"), Some("root")));
        assert!(!targets_root(Some("child"), None));
    }
}

/// A Stop of the whole thread: it cascades and targets the root, so everything under it stops.
pub fn stops_whole_thread(
    cascade: bool,
    agent_id: Option<&str>,
    root_agent_id: Option<&str>,
) -> bool {
    cascade && targets_root(agent_id, root_agent_id)
}

/// The provider's own background work a whole-thread Stop stops, by task key: running, and never
/// ace's own rows.
pub fn stoppable_tasks(state: &ace_core::ThreadState) -> Vec<String> {
    state
        .tasks
        .iter()
        .filter(|(_, task)| {
            task.status == "running"
                && task.owner.as_deref() != Some("ace")
                && task.internal != Some(true)
        })
        .map(|(key, _)| key.clone())
        .collect()
}

/// Those a whole-thread Stop asks the provider to stop: the ones it said it can stop.
pub fn tasks_to_stop(state: &ace_core::ThreadState) -> Vec<String> {
    stoppable_tasks(state)
        .into_iter()
        .filter(|key| state.tasks.get(key).is_some_and(|task| task.stoppable))
        .collect()
}

/// Those the provider said it can't stop and that take the thread's next prompt away while they
/// run: a Stop gives them a bounded time to end.
pub fn tasks_holding_prompts(state: &ace_core::ThreadState) -> Vec<String> {
    stoppable_tasks(state)
        .into_iter()
        .filter(|key| {
            state
                .tasks
                .get(key)
                .is_some_and(|task| !task.stoppable && task.blocks_prompts == Some(true))
        })
        .collect()
}

/// Those only the provider's session's end can end: a Stop closes the session at once.
pub fn tasks_ending_with_session(state: &ace_core::ThreadState) -> Vec<String> {
    stoppable_tasks(state)
        .into_iter()
        .filter(|key| {
            state
                .tasks
                .get(key)
                .is_some_and(|task| task.ends_with_session == Some(true))
        })
        .collect()
}

#[cfg(test)]
mod scope_tests {
    use super::*;
    use ace_core::state::{CoreConfig, create_thread_state};
    use ace_json::Value;

    fn value(text: &str) -> Value {
        ace_json::parse(text).expect("json")
    }

    fn state(tasks: &str) -> ace_core::ThreadState {
        let mut state = create_thread_state(
            "t".to_owned(),
            None,
            CoreConfig {
                provider: "codex".to_owned(),
                silence_ms: 1_000.0,
                liveness: None,
            },
        )
        .expect("state");
        let tasks: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(tasks).expect("tasks");
        for (key, task) in tasks {
            state.tasks.insert(
                key,
                ace_json::from_value(&value(&serde_json::to_string(&task).unwrap())).expect("task"),
            );
        }
        state
    }

    #[test]
    fn a_whole_thread_stop_cascades_and_targets_the_root() {
        assert!(stops_whole_thread(true, None, Some("root")));
        assert!(stops_whole_thread(true, Some("root"), Some("root")));
        assert!(!stops_whole_thread(true, Some("child"), Some("root")));
        assert!(!stops_whole_thread(false, None, Some("root")));
    }

    #[test]
    fn only_running_provider_work_is_stoppable_and_ace_own_rows_and_internal_ones_are_not() {
        let state = state(
            r#"{
              "shell":{"id":"shell","agentId":"root","kind":"shell","title":"Run","status":"running","ambient":false,"stoppable":true,"startedAt":1},
              "ace":{"id":"ace","agentId":"root","kind":"shell","title":"Bookkeeping","status":"running","ambient":false,"stoppable":true,"startedAt":1,"owner":"ace"},
              "internal":{"id":"internal","agentId":"root","kind":"shell","title":"Internal","status":"running","ambient":false,"stoppable":true,"startedAt":1,"internal":true},
              "ended":{"id":"ended","agentId":"root","kind":"shell","title":"Done","status":"completed","ambient":false,"stoppable":true,"startedAt":1}
            }"#,
        );
        assert_eq!(stoppable_tasks(&state), vec!["shell".to_owned()]);
        assert_eq!(tasks_to_stop(&state), vec!["shell".to_owned()]);
    }

    #[test]
    fn work_the_provider_cannot_stop_is_stopped_only_where_it_holds_prompts_or_ends_with_the_session()
     {
        let state = state(
            r#"{
              "blocks":{"id":"blocks","agentId":"root","kind":"shell","title":"Blocks","status":"running","ambient":false,"stoppable":false,"blocksPrompts":true,"startedAt":1},
              "session":{"id":"session","agentId":"root","kind":"shell","title":"Session","status":"running","ambient":false,"stoppable":false,"endsWithSession":true,"startedAt":1},
              "quiet":{"id":"quiet","agentId":"root","kind":"shell","title":"Quiet","status":"running","ambient":false,"stoppable":false,"startedAt":1}
            }"#,
        );
        assert_eq!(tasks_to_stop(&state), Vec::<String>::new());
        assert_eq!(tasks_holding_prompts(&state), vec!["blocks".to_owned()]);
        assert_eq!(
            tasks_ending_with_session(&state),
            vec!["session".to_owned()]
        );
    }
}

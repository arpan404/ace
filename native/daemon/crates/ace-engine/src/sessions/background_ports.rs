// SPDX-License-Identifier: Apache-2.0
//! `background-ports.ts` (ADR 0109): the running background shells whose TCP ports ace can watch,
//! and the `background.listening` fact a sweep reports. Moved cases: the port sweep of
//! `diagnostics-integration.process` and `background.listening`'s transcript update.

use ace_core::state::ThreadState;
use ace_core::status_inputs::owner_turn_finished;
use ace_json::Value;

/// What the port probe reads from one thread (the host's `PortCandidate`).
#[derive(Debug, Clone, PartialEq)]
pub struct PortCandidate {
    pub task_id: String,
    pub output_path: String,
    /// The agent that owns the task has finished its turn.
    pub turn_finished: bool,
    pub listening: Vec<i64>,
}

/// `candidates`: a provider that never wakes the agent already released it, so only running,
/// non-ambient shells with an output file are probed.
pub fn candidates(state: &ThreadState) -> Vec<PortCandidate> {
    let mut candidates = Vec::new();
    for task in state.tasks.values() {
        if task.status != "running"
            || truthy(&task.ambient)
            || task.kind != "shell"
            || task.wakes_agent == Some(false)
        {
            continue;
        }
        let Some(output_path) = task.output_path.clone() else {
            continue;
        };
        candidates.push(PortCandidate {
            task_id: task.id.clone(),
            output_path,
            turn_finished: owner_turn_finished(state, task),
            listening: task.listening.clone().unwrap_or_default(),
        });
    }
    candidates
}

/// `report`: the `background.listening` fact for a task, or `None` when the state has none.
pub fn report_fact(state: &ThreadState, task_id: &str, ports: &[i64]) -> Option<Value> {
    let task = state.tasks.values().find(|task| task.id == task_id)?;
    let json = ace_json::ser::to_string(task).ok()?;
    let task = ace_json::parse(&json).ok()?;
    Some(ace_json::json!({
        "type": "background.listening",
        "task": task,
        "ports": ports.iter().map(|port| Value::from(*port as f64)).collect::<Vec<Value>>(),
    }))
}

/// JavaScript truthiness for the task's `ambient` value (the schema says bool; a stored one from
/// another build is read as the TypeScript reads it).
fn truthy(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Bool(value) => *value,
        serde_json::Value::Null => false,
        serde_json::Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        serde_json::Value::String(text) => !text.is_empty(),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::{candidates, report_fact};
    use crate::repository::testsupport::header;
    use ace_core::state::ThreadState;
    use ace_json::Value;

    fn state_with(tasks: &str) -> ThreadState {
        let header = header("ports");
        let value = ace_json::parse(&header).expect("fixture");
        let mut state: ThreadState = ace_json::from_value(&value).expect("state");
        let tasks: Value = ace_json::parse(tasks).expect("tasks");
        state.tasks = ace_json::from_value(&tasks).expect("tasks");
        state
    }

    #[test]
    fn only_a_running_shell_with_output_and_a_waiting_agent_is_probed() {
        // diagnostics-integration.process: the port probe looks at a running shell's output file.
        let state = state_with(
            r#"{
              "shell": {"id":"task-1","agentId":"agent","kind":"shell","title":"dev","status":"running",
                        "ambient":false,"stoppable":true,"startedAt":0,"outputPath":"/tmp/out","listening":[3000]},
              "ambient": {"id":"task-2","agentId":"agent","kind":"shell","title":"dev","status":"running",
                        "ambient":true,"stoppable":true,"startedAt":0,"outputPath":"/tmp/out"},
              "done": {"id":"task-3","agentId":"agent","kind":"shell","title":"dev","status":"ended",
                        "ambient":false,"stoppable":true,"startedAt":0,"outputPath":"/tmp/out"},
              "quiet": {"id":"task-4","agentId":"agent","kind":"shell","title":"dev","status":"running",
                        "ambient":false,"stoppable":true,"startedAt":0,"outputPath":"/tmp/out","wakesAgent":false},
              "fileless": {"id":"task-5","agentId":"agent","kind":"shell","title":"dev","status":"running",
                        "ambient":false,"stoppable":true,"startedAt":0},
              "subagent": {"id":"task-6","agentId":"agent","kind":"subagent","title":"child","status":"running",
                        "ambient":false,"stoppable":true,"startedAt":0,"outputPath":"/tmp/out"}
            }"#,
        );
        let found = candidates(&state);
        assert_eq!(found.len(), 1, "one shell is a probe candidate");
        assert_eq!(found[0].task_id, "task-1");
        assert_eq!(found[0].output_path, "/tmp/out");
        assert_eq!(found[0].listening, [3000]);
        assert!(!found[0].turn_finished, "its agent has no completed run");
    }

    #[test]
    fn a_listening_report_names_the_task_the_state_holds() {
        let state = state_with(
            r#"{"shell": {"id":"task-1","agentId":"agent","kind":"shell","title":"dev",
                         "status":"running","ambient":false,"stoppable":true,"startedAt":0,
                         "outputPath":"/tmp/out"}}"#,
        );
        let fact = report_fact(&state, "task-1", &[3000, 3001]).expect("fact");
        assert_eq!(
            fact.get("type").and_then(Value::as_str),
            Some("background.listening")
        );
        assert_eq!(
            fact.get("task")
                .and_then(|task| task.get("id"))
                .and_then(Value::as_str),
            Some("task-1")
        );
        assert_eq!(
            fact.get("ports")
                .and_then(Value::as_array)
                .map(|ports| ports.len()),
            Some(2)
        );
        assert!(report_fact(&state, "gone", &[3000]).is_none());
    }
}

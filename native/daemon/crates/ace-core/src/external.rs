// SPDX-License-Identifier: Apache-2.0
//! The external summary agents of `external.ts`: a delegated child's agent
//! follows its independently owned thread, and result wakes run beside
//! external children only when no local provider work is live.

use crate::emit::get;
use crate::indexes::{live_tool_keys, pending_interaction_keys, running_task_keys};
use crate::state::ThreadState;
use crate::status::{AgentStatus, ThreadStatus};
use crate::status_inputs::task_holds_thread;

/// A summary agent follows its independently owned thread, never its
/// parent's process.
pub fn external_agent_status(status: &ThreadStatus, thread_id: &str) -> AgentStatus {
    match status {
        ThreadStatus::NeedsYou { interactions: _ } => AgentStatus::Blocked {
            on: "human".to_owned(),
            refs: vec![thread_id.to_owned()],
            until: None,
            attempt: None,
            message: None,

            retry_order: false,
        },
        ThreadStatus::Working { .. } => AgentStatus::Working {
            activity: "responding".to_owned(),
            item_id: None,
            detail: None,
        },
        ThreadStatus::Waiting { on, .. } => AgentStatus::Blocked {
            on: on.clone(),
            refs: vec![thread_id.to_owned()],
            until: None,
            attempt: None,
            message: None,

            retry_order: false,
        },
        ThreadStatus::Limited { until } => AgentStatus::Blocked {
            on: "rate_limit".to_owned(),
            refs: vec![thread_id.to_owned()],
            until: *until,
            attempt: None,
            message: None,

            retry_order: false,
        },
        ThreadStatus::Unresponsive => AgentStatus::Unresponsive { last_signal_at: 0 },
        ThreadStatus::New => AgentStatus::Starting,
        ThreadStatus::Failed => AgentStatus::Failed {
            error: crate::status::AgentError {
                kind: "provider".to_owned(),
                message: "Delegated thread failed".to_owned(),
                code: None,
                title: None,
                detail: None,
                details: None,
            },
        },
        ThreadStatus::Done => AgentStatus::Idle,
        // Its work goes on on another machine: still waited on, never read
        // as finished here. A state newer than this build behaves the same.
        ThreadStatus::Moved { .. } | ThreadStatus::Unknown { .. } => AgentStatus::Blocked {
            on: "upstream".to_owned(),
            refs: vec![thread_id.to_owned()],
            until: None,
            attempt: None,
            message: None,

            retry_order: false,
        },
    }
}

/// Result wakes can run beside external children, but never beside local
/// provider work. Commands the agent left running after its final reply
/// (ADR 0116) don't count: they no longer hold it.
pub fn ready_for_child_results(state: &ThreadState) -> bool {
    if state.queue_sources.provider > 0 {
        return false;
    }
    for record in state.agents.values() {
        if record.external_status.is_some() {
            continue;
        }
        if record.active_run.is_some()
            || record.retry.is_some()
            || record.limited.is_some()
            || record.disconnected_at.is_some()
        {
            return false;
        }
    }
    if !pending_interaction_keys(state, None).is_empty() {
        return false;
    }
    for key in running_task_keys(state, None) {
        let holds = match get(&state.tasks, &key) {
            Some(task) => task_holds_thread(state, task),
            None => false,
        };
        if holds {
            return false;
        }
    }
    live_tool_keys(state, None).is_empty()
}

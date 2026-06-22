use crate::provider::ProviderEvent;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionLocation {
    Local,
    Worktree,
    RemoteHost,
    Cloud,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PermissionPolicy {
    pub sandbox_policy: Value,
    pub approval_policy: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approvals_reviewer: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnMode {
    Normal,
    Plan,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Turn {
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub mode: TurnMode,
    pub active: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanSessionStatus {
    Active,
    Completed,
    Rejected,
    Implementing,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlanSession {
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub status: PlanSessionStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalStatus {
    Active,
    Paused,
    Complete,
    Cleared,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GoalState {
    pub thread_id: String,
    pub status: GoalStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub objective: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_budget: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForkPoint {
    pub parent_thread_id: String,
    pub child_thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SideChat {
    pub parent_thread_id: String,
    pub thread_id: String,
    pub ephemeral: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubagentThread {
    pub parent_thread_id: String,
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nickname: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandoffPlan {
    pub source_thread_id: String,
    pub target_location: ExecutionLocation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_thread_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentThread {
    pub thread_id: String,
    pub provider: String,
    pub execution_location: ExecutionLocation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_turn: Option<Turn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_session: Option<PlanSession>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AgentRuntimeState {
    active_turns: HashMap<String, Turn>,
    plan_sessions: HashMap<String, PlanSession>,
}

impl AgentRuntimeState {
    #[must_use]
    pub fn active_turn(&self, thread_id: &str) -> Option<&Turn> {
        self.active_turns.get(thread_id)
    }

    #[must_use]
    pub fn plan_session(&self, thread_id: &str) -> Option<&PlanSession> {
        self.plan_sessions.get(thread_id)
    }

    pub fn begin_turn(
        &mut self,
        thread_id: impl Into<String>,
        turn_id: Option<String>,
        mode: TurnMode,
    ) -> Result<(), RuntimeStateError> {
        let thread_id = thread_id.into();
        if self.active_turns.contains_key(&thread_id) {
            return Err(RuntimeStateError::TurnAlreadyActive { thread_id });
        }
        let turn = Turn {
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone(),
            mode,
            active: true,
        };
        self.active_turns.insert(thread_id.clone(), turn);
        if mode == TurnMode::Plan {
            self.plan_sessions.insert(
                thread_id.clone(),
                PlanSession {
                    thread_id,
                    turn_id,
                    status: PlanSessionStatus::Active,
                },
            );
        }
        Ok(())
    }

    pub fn update_turn_id(&mut self, thread_id: &str, turn_id: Option<String>) {
        if let Some(turn) = self.active_turns.get_mut(thread_id) {
            turn.turn_id = turn_id.clone();
            if turn.mode == TurnMode::Plan
                && let Some(plan) = self.plan_sessions.get_mut(thread_id)
            {
                plan.turn_id = turn_id;
            }
        }
    }

    pub fn clear_active_turn(&mut self, thread_id: &str) {
        self.finish_active_turn(thread_id, PlanSessionStatus::Completed);
    }

    pub fn finish_active_turn(&mut self, thread_id: &str, plan_status: PlanSessionStatus) {
        let was_plan = self
            .active_turns
            .remove(thread_id)
            .is_some_and(|turn| turn.mode == TurnMode::Plan);
        if was_plan && let Some(plan) = self.plan_sessions.get_mut(thread_id) {
            plan.status = plan_status;
        }
    }

    pub fn abandon_active_turn(&mut self, thread_id: &str) {
        let was_plan = self
            .active_turns
            .remove(thread_id)
            .is_some_and(|turn| turn.mode == TurnMode::Plan);
        if was_plan {
            self.plan_sessions.remove(thread_id);
        }
    }

    pub fn mark_plan_implementing(&mut self, thread_id: &str) {
        if let Some(plan) = self.plan_sessions.get_mut(thread_id) {
            plan.status = PlanSessionStatus::Implementing;
        }
    }

    pub fn apply_provider_events(&mut self, events: &[ProviderEvent]) {
        for event in events {
            self.apply_provider_event(event);
        }
    }

    fn apply_provider_event(&mut self, event: &ProviderEvent) {
        match event {
            ProviderEvent::RawNotification { method, params } => {
                if let Some(plan_status) = turn_finished_plan_status(method)
                    && let Some(thread_id) = string_field(params, "threadId")
                {
                    self.finish_active_turn(&thread_id, plan_status);
                }
                if is_turn_started_method(method)
                    && let Some(thread_id) = string_field(params, "threadId")
                {
                    let turn_id = string_field(params, "turnId");
                    let _ = self.begin_turn(thread_id.clone(), turn_id, TurnMode::Normal);
                }
            }
            ProviderEvent::ThreadItem { item } => {
                if item.kind == crate::provider::ThreadItemKind::Plan
                    && let Some(thread_id) = item.thread_id.as_deref()
                {
                    self.plan_sessions
                        .entry(thread_id.to_string())
                        .or_insert_with(|| PlanSession {
                            thread_id: thread_id.to_string(),
                            turn_id: item.turn_id.clone(),
                            status: PlanSessionStatus::Active,
                        });
                }
            }
            ProviderEvent::Exited => {
                self.active_turns.clear();
            }
            ProviderEvent::RawServerRequest { .. }
            | ProviderEvent::SemanticTool { .. }
            | ProviderEvent::StderrLine { .. } => {}
        }
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RuntimeStateError {
    #[error("thread `{thread_id}` already has an active turn")]
    TurnAlreadyActive { thread_id: String },
}

fn is_turn_started_method(method: &str) -> bool {
    matches!(method, "turn/started" | "turn/startedStreaming")
}

fn turn_finished_plan_status(method: &str) -> Option<PlanSessionStatus> {
    match method {
        "turn/completed" => Some(PlanSessionStatus::Completed),
        "turn/failed" | "turn/interrupted" | "turn/cancelled" => Some(PlanSessionStatus::Rejected),
        _ => None,
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{
        NormalizedThreadItem, ProviderMetadata, ThreadItemKind, ThreadItemStatus,
    };
    use serde_json::json;

    #[test]
    fn tracks_active_turns_and_rejects_concurrent_starts() {
        let mut state = AgentRuntimeState::default();
        state
            .begin_turn("thread-1", Some("turn-1".to_string()), TurnMode::Plan)
            .expect("start plan");

        assert_eq!(
            state.begin_turn("thread-1", Some("turn-2".to_string()), TurnMode::Normal),
            Err(RuntimeStateError::TurnAlreadyActive {
                thread_id: "thread-1".to_string()
            })
        );
        assert_eq!(
            state.plan_session("thread-1").map(|plan| plan.status),
            Some(PlanSessionStatus::Active)
        );

        state.apply_provider_events(&[ProviderEvent::RawNotification {
            method: "turn/completed".to_string(),
            params: json!({ "threadId": "thread-1", "turnId": "turn-1" }),
        }]);
        assert!(state.active_turn("thread-1").is_none());
        assert_eq!(
            state.plan_session("thread-1").map(|plan| plan.status),
            Some(PlanSessionStatus::Completed)
        );
    }

    #[test]
    fn creates_plan_session_from_plan_item_events() {
        let mut state = AgentRuntimeState::default();
        state.apply_provider_events(&[ProviderEvent::ThreadItem {
            item: Box::new(NormalizedThreadItem {
                kind: ThreadItemKind::Plan,
                status: ThreadItemStatus::Updated,
                thread_id: Some("thread-1".to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("plan-1".to_string()),
                parent_thread_id: None,
                child_thread_id: None,
                sender: None,
                role: None,
                title: None,
                text: Some("Plan".to_string()),
                metadata: json!({}),
                provider: ProviderMetadata {
                    provider: "codex".to_string(),
                    method: Some("item/plan/delta".to_string()),
                    schema_version: None,
                    raw_payload: json!({}),
                },
            }),
        }]);

        let session = state.plan_session("thread-1").expect("plan session");
        assert_eq!(session.turn_id.as_deref(), Some("turn-1"));
        assert_eq!(session.status, PlanSessionStatus::Active);
    }
}

use crate::provider::{NormalizedRuntimeSignal, ProviderEvent, RuntimeSignalKind};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
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
    Blocked,
    UsageLimited,
    BudgetLimited,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens_used: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_used_seconds: Option<u64>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HandoffStatus {
    Requested,
    Interrupted,
    Transferring,
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HandoffPlan {
    pub source_thread_id: String,
    pub target_location: ExecutionLocation,
    pub status: HandoffStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_point: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transfer_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interrupted_active_turn: Option<bool>,
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub metadata: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApprovalRetryRecord {
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_id: Option<String>,
    pub approved: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default)]
    pub audit: Value,
    #[serde(default)]
    pub provider_response: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanImplementationMode {
    ContinueInThread,
    ForkForImplementation,
    SideImplementation,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlanImplementationRecord {
    pub parent_thread_id: String,
    pub target_thread_id: String,
    pub mode: PlanImplementationMode,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default)]
    pub plan: Value,
    #[serde(default)]
    pub sandbox_policy: Value,
    #[serde(default)]
    pub approval_policy: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approvals_reviewer: Option<String>,
    #[serde(default)]
    pub provider_response: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadLifecycleActionKind {
    Archive,
    Unarchive,
    Delete,
    Unsubscribe,
    SetName,
    UpdateMetadata,
    Compact,
    Rollback,
    InjectItems,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThreadLifecycleRecord {
    pub thread_id: String,
    pub action: ThreadLifecycleActionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_count: Option<usize>,
    #[serde(default)]
    pub request: Value,
    #[serde(default)]
    pub provider_response: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubagentActionKind {
    Steer,
    Stop,
    Close,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubagentActionRecord {
    pub parent_thread_id: String,
    pub subagent_thread_id: String,
    pub action: SubagentActionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default)]
    pub provider_response: Value,
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
    goals: HashMap<String, GoalState>,
    fork_points: HashMap<String, ForkPoint>,
    side_chats: HashMap<String, SideChat>,
    subagents: HashMap<String, SubagentThread>,
    handoffs: Vec<HandoffPlan>,
    approval_retries: Vec<ApprovalRetryRecord>,
    plan_implementations: Vec<PlanImplementationRecord>,
    thread_lifecycle: Vec<ThreadLifecycleRecord>,
    subagent_actions: Vec<SubagentActionRecord>,
    review_threads: HashSet<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AgentRuntimeSnapshot {
    pub active_turns: Vec<Turn>,
    pub plan_sessions: Vec<PlanSession>,
    pub goals: Vec<GoalState>,
    pub fork_points: Vec<ForkPoint>,
    pub side_chats: Vec<SideChat>,
    pub subagents: Vec<SubagentThread>,
    pub handoffs: Vec<HandoffPlan>,
    pub approval_retries: Vec<ApprovalRetryRecord>,
    pub plan_implementations: Vec<PlanImplementationRecord>,
    pub thread_lifecycle: Vec<ThreadLifecycleRecord>,
    pub subagent_actions: Vec<SubagentActionRecord>,
    pub review_threads: Vec<String>,
}

impl AgentRuntimeState {
    #[must_use]
    pub fn snapshot(&self) -> AgentRuntimeSnapshot {
        let mut active_turns = self.active_turns.values().cloned().collect::<Vec<_>>();
        active_turns.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));

        let mut plan_sessions = self.plan_sessions.values().cloned().collect::<Vec<_>>();
        plan_sessions.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));

        let mut goals = self.goals.values().cloned().collect::<Vec<_>>();
        goals.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));

        let mut fork_points = self.fork_points.values().cloned().collect::<Vec<_>>();
        fork_points.sort_by(|left, right| left.child_thread_id.cmp(&right.child_thread_id));

        let mut side_chats = self.side_chats.values().cloned().collect::<Vec<_>>();
        side_chats.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));

        let mut subagents = self.subagents.values().cloned().collect::<Vec<_>>();
        subagents.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));

        let mut review_threads = self.review_threads.iter().cloned().collect::<Vec<_>>();
        review_threads.sort();

        AgentRuntimeSnapshot {
            active_turns,
            plan_sessions,
            goals,
            fork_points,
            side_chats,
            subagents,
            handoffs: self.handoffs.clone(),
            approval_retries: self.approval_retries.clone(),
            plan_implementations: self.plan_implementations.clone(),
            thread_lifecycle: self.thread_lifecycle.clone(),
            subagent_actions: self.subagent_actions.clone(),
            review_threads,
        }
    }

    #[must_use]
    pub fn active_turn(&self, thread_id: &str) -> Option<&Turn> {
        self.active_turns.get(thread_id)
    }

    #[must_use]
    pub fn plan_session(&self, thread_id: &str) -> Option<&PlanSession> {
        self.plan_sessions.get(thread_id)
    }

    #[must_use]
    pub fn goal(&self, thread_id: &str) -> Option<&GoalState> {
        self.goals.get(thread_id)
    }

    #[must_use]
    pub fn subagent(&self, thread_id: &str) -> Option<&SubagentThread> {
        self.subagents.get(thread_id)
    }

    #[must_use]
    pub fn fork_point(&self, child_thread_id: &str) -> Option<&ForkPoint> {
        self.fork_points.get(child_thread_id)
    }

    #[must_use]
    pub fn side_chat(&self, thread_id: &str) -> Option<&SideChat> {
        self.side_chats.get(thread_id)
    }

    #[must_use]
    pub fn is_reviewing(&self, thread_id: &str) -> bool {
        self.review_threads.contains(thread_id)
    }

    #[must_use]
    pub fn handoffs(&self) -> &[HandoffPlan] {
        &self.handoffs
    }

    pub fn record_fork(&mut self, fork: ForkPoint) {
        self.fork_points.insert(fork.child_thread_id.clone(), fork);
    }

    pub fn record_side_chat(&mut self, side_chat: SideChat) {
        self.side_chats
            .insert(side_chat.thread_id.clone(), side_chat);
    }

    pub fn close_side_chat(&mut self, thread_id: &str) {
        self.side_chats.remove(thread_id);
    }

    pub fn record_subagent(&mut self, subagent: SubagentThread) {
        self.subagents.insert(subagent.thread_id.clone(), subagent);
    }

    pub fn close_subagent(&mut self, thread_id: &str) {
        self.subagents.remove(thread_id);
    }

    pub fn record_subagent_action(&mut self, action: SubagentActionRecord) {
        self.subagent_actions.push(action);
    }

    #[must_use]
    pub fn subagent_actions(&self) -> &[SubagentActionRecord] {
        &self.subagent_actions
    }

    pub fn record_handoff(&mut self, handoff: HandoffPlan) {
        self.handoffs.push(handoff);
    }

    pub fn record_approval_retry(&mut self, retry: ApprovalRetryRecord) {
        self.approval_retries.push(retry);
    }

    #[must_use]
    pub fn approval_retries(&self) -> &[ApprovalRetryRecord] {
        &self.approval_retries
    }

    pub fn record_plan_implementation(&mut self, implementation: PlanImplementationRecord) {
        self.plan_implementations.push(implementation);
    }

    #[must_use]
    pub fn plan_implementations(&self) -> &[PlanImplementationRecord] {
        &self.plan_implementations
    }

    pub fn record_thread_lifecycle(&mut self, record: ThreadLifecycleRecord) {
        self.thread_lifecycle.push(record);
    }

    #[must_use]
    pub fn thread_lifecycle(&self) -> &[ThreadLifecycleRecord] {
        &self.thread_lifecycle
    }

    pub fn set_goal(
        &mut self,
        thread_id: impl Into<String>,
        objective: impl Into<String>,
        token_budget: Option<u64>,
    ) {
        let thread_id = thread_id.into();
        self.goals.insert(
            thread_id.clone(),
            GoalState {
                thread_id,
                status: GoalStatus::Active,
                objective: Some(objective.into()),
                token_budget,
                tokens_used: None,
                time_used_seconds: None,
            },
        );
    }

    pub fn upsert_goal(&mut self, goal: GoalState) {
        self.goals.insert(goal.thread_id.clone(), goal);
    }

    pub fn pause_goal(&mut self, thread_id: &str) {
        if let Some(goal) = self.goals.get_mut(thread_id) {
            goal.status = GoalStatus::Paused;
        }
    }

    pub fn resume_goal(&mut self, thread_id: &str) {
        if let Some(goal) = self.goals.get_mut(thread_id) {
            goal.status = GoalStatus::Active;
        }
    }

    pub fn clear_goal(&mut self, thread_id: &str) {
        if let Some(goal) = self.goals.get_mut(thread_id) {
            goal.status = GoalStatus::Cleared;
        } else {
            self.goals.insert(
                thread_id.to_string(),
                GoalState {
                    thread_id: thread_id.to_string(),
                    status: GoalStatus::Cleared,
                    objective: None,
                    token_budget: None,
                    tokens_used: None,
                    time_used_seconds: None,
                },
            );
        }
    }

    pub fn complete_goal(&mut self, thread_id: &str) {
        if let Some(goal) = self.goals.get_mut(thread_id) {
            goal.status = GoalStatus::Complete;
        }
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

    pub fn finish_all_active_turns(&mut self, plan_status: PlanSessionStatus) {
        let active_turns = std::mem::take(&mut self.active_turns);
        for turn in active_turns.into_values() {
            if turn.mode == TurnMode::Plan
                && let Some(plan) = self.plan_sessions.get_mut(&turn.thread_id)
            {
                plan.status = plan_status;
            }
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
                if method == "thread/goal/updated"
                    && let Some(goal) = goal_state_from_notification(params)
                {
                    self.upsert_goal(goal);
                }
                if method == "thread/goal/cleared"
                    && let Some(thread_id) = string_field(params, "threadId")
                {
                    self.clear_goal(&thread_id);
                }
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
                if matches!(
                    item.kind,
                    crate::provider::ThreadItemKind::SubAgentActivity
                        | crate::provider::ThreadItemKind::CollabAgentToolCall
                ) && let (Some(parent_thread_id), Some(child_thread_id)) = (
                    item.parent_thread_id
                        .as_deref()
                        .or(item.thread_id.as_deref()),
                    item.child_thread_id.as_deref(),
                ) {
                    self.record_subagent(SubagentThread {
                        parent_thread_id: parent_thread_id.to_string(),
                        thread_id: child_thread_id.to_string(),
                        role: item.role.clone(),
                        nickname: item.sender.clone(),
                    });
                }
                if item.kind == crate::provider::ThreadItemKind::EnteredReviewMode
                    && let Some(thread_id) = item.thread_id.as_deref()
                {
                    self.review_threads.insert(thread_id.to_string());
                }
                if item.kind == crate::provider::ThreadItemKind::ExitedReviewMode
                    && let Some(thread_id) = item.thread_id.as_deref()
                {
                    self.review_threads.remove(thread_id);
                }
            }
            ProviderEvent::Exited { .. } => {
                self.finish_all_active_turns(PlanSessionStatus::Rejected);
            }
            ProviderEvent::RuntimeSignal { signal } => {
                if let Some(action) = subagent_action_from_signal(signal) {
                    self.record_subagent_action(action);
                }
                if let Some(record) = thread_lifecycle_from_signal(signal) {
                    self.record_thread_lifecycle(record);
                }
                if let Some(handoff) = handoff_from_signal(signal) {
                    self.record_handoff(handoff);
                }
                if let Some(implementation) = plan_implementation_from_signal(signal) {
                    self.record_plan_implementation(implementation);
                }
            }
            ProviderEvent::RawServerRequest { .. }
            | ProviderEvent::ServerRequest { .. }
            | ProviderEvent::ServerRequestResolved { .. }
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

fn goal_state_from_notification(value: &Value) -> Option<GoalState> {
    let goal = value.get("goal")?;
    let thread_id = string_field(goal, "threadId").or_else(|| string_field(value, "threadId"))?;
    Some(GoalState {
        thread_id,
        status: goal_status(goal.get("status")?.as_str()?),
        objective: string_field(goal, "objective"),
        token_budget: u64_field(goal, "tokenBudget"),
        tokens_used: u64_field(goal, "tokensUsed"),
        time_used_seconds: u64_field(goal, "timeUsedSeconds"),
    })
}

fn goal_status(status: &str) -> GoalStatus {
    match status {
        "paused" => GoalStatus::Paused,
        "blocked" => GoalStatus::Blocked,
        "usageLimited" | "usage_limited" => GoalStatus::UsageLimited,
        "budgetLimited" | "budget_limited" => GoalStatus::BudgetLimited,
        "complete" => GoalStatus::Complete,
        _ => GoalStatus::Active,
    }
}

fn u64_field(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(Value::as_u64)
}

fn thread_lifecycle_from_signal(signal: &NormalizedRuntimeSignal) -> Option<ThreadLifecycleRecord> {
    if signal.kind != RuntimeSignalKind::ThreadLifecycleChanged {
        return None;
    }
    let thread_id = signal.thread_id.clone()?;
    let action = string_field(&signal.metadata, "action")
        .as_deref()
        .and_then(thread_lifecycle_action_kind)
        .or_else(|| {
            signal
                .status
                .as_deref()
                .and_then(thread_lifecycle_action_kind)
        })?;
    Some(ThreadLifecycleRecord {
        thread_id,
        action,
        turn_id: string_field(&signal.metadata, "turn_id")
            .or_else(|| string_field(&signal.metadata, "turnId")),
        name: signal.name.clone(),
        item_count: u64_field(&signal.metadata, "item_count")
            .or_else(|| u64_field(&signal.metadata, "itemCount"))
            .and_then(|count| usize::try_from(count).ok()),
        request: thread_lifecycle_request_from_signal(signal),
        provider_response: signal
            .metadata
            .get("provider_response")
            .cloned()
            .unwrap_or(Value::Null),
    })
}

fn thread_lifecycle_action_kind(action: &str) -> Option<ThreadLifecycleActionKind> {
    match action {
        "archive" | "archived" => Some(ThreadLifecycleActionKind::Archive),
        "unarchive" | "unarchived" => Some(ThreadLifecycleActionKind::Unarchive),
        "delete" | "deleted" => Some(ThreadLifecycleActionKind::Delete),
        "unsubscribe" | "unsubscribed" => Some(ThreadLifecycleActionKind::Unsubscribe),
        "set_name" | "renamed" => Some(ThreadLifecycleActionKind::SetName),
        "update_metadata" | "metadata_updated" => Some(ThreadLifecycleActionKind::UpdateMetadata),
        "compact" | "compacted" => Some(ThreadLifecycleActionKind::Compact),
        "rollback" | "rolled_back" => Some(ThreadLifecycleActionKind::Rollback),
        "inject_items" | "items_injected" => Some(ThreadLifecycleActionKind::InjectItems),
        _ => None,
    }
}

fn thread_lifecycle_request_from_signal(signal: &NormalizedRuntimeSignal) -> Value {
    if let Some(request) = signal.metadata.get("request") {
        return request.clone();
    }
    let mut request = serde_json::Map::new();
    if let Some(name) = signal.name.clone() {
        request.insert("name".to_string(), Value::String(name));
    }
    for key in [
        "turn_id",
        "turnId",
        "item_count",
        "itemCount",
        "items",
        "thread_metadata",
        "metadata",
    ] {
        if key == "metadata" && signal.metadata.get("provider_response").is_some() {
            continue;
        }
        if let Some(value) = signal.metadata.get(key) {
            request.insert(key.to_string(), value.clone());
        }
    }
    Value::Object(request)
}

fn subagent_action_from_signal(signal: &NormalizedRuntimeSignal) -> Option<SubagentActionRecord> {
    if signal.kind != RuntimeSignalKind::SubagentAction {
        return None;
    }
    let parent_thread_id = signal.thread_id.clone()?;
    let subagent_thread_id = string_field(&signal.metadata, "subagent_thread_id")
        .or_else(|| string_field(&signal.metadata, "subagentThreadId"))?;
    let action = subagent_action_kind(signal.status.as_deref()?)?;
    Some(SubagentActionRecord {
        parent_thread_id,
        subagent_thread_id,
        action,
        prompt: signal.text.clone(),
        provider_response: signal
            .metadata
            .get("provider_response")
            .cloned()
            .unwrap_or(Value::Null),
    })
}

fn subagent_action_kind(action: &str) -> Option<SubagentActionKind> {
    match action {
        "steer" => Some(SubagentActionKind::Steer),
        "stop" => Some(SubagentActionKind::Stop),
        "close" => Some(SubagentActionKind::Close),
        _ => None,
    }
}

fn handoff_from_signal(signal: &NormalizedRuntimeSignal) -> Option<HandoffPlan> {
    if signal.kind != RuntimeSignalKind::HandoffUpdated {
        return None;
    }
    let value = signal
        .metadata
        .get("handoff")
        .cloned()
        .unwrap_or_else(|| signal.metadata.clone());
    serde_json::from_value(value).ok()
}

fn plan_implementation_from_signal(
    signal: &NormalizedRuntimeSignal,
) -> Option<PlanImplementationRecord> {
    if signal.kind != RuntimeSignalKind::PlanImplementationUpdated {
        return None;
    }
    let value = signal
        .metadata
        .get("plan_implementation")
        .cloned()
        .unwrap_or_else(|| signal.metadata.clone());
    serde_json::from_value(value).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{
        NormalizedRuntimeSignal, NormalizedThreadItem, ProviderMetadata, ThreadItemKind,
        ThreadItemStatus,
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
    fn provider_exit_finishes_all_active_turns_and_rejects_active_plans() {
        let mut state = AgentRuntimeState::default();
        state
            .begin_turn("plan-thread", Some("turn-1".to_string()), TurnMode::Plan)
            .expect("plan turn");
        state
            .begin_turn(
                "normal-thread",
                Some("turn-2".to_string()),
                TurnMode::Normal,
            )
            .expect("normal turn");

        state.apply_provider_events(&[ProviderEvent::Exited { code: Some(1) }]);

        assert!(state.active_turn("plan-thread").is_none());
        assert!(state.active_turn("normal-thread").is_none());
        assert_eq!(
            state.plan_session("plan-thread").map(|plan| plan.status),
            Some(PlanSessionStatus::Rejected)
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

    #[test]
    fn tracks_goal_lifecycle_independent_of_turn_state() {
        let mut state = AgentRuntimeState::default();
        state.set_goal("thread-1", "finish adapter", Some(42));

        let goal = state.goal("thread-1").expect("goal");
        assert_eq!(goal.status, GoalStatus::Active);
        assert_eq!(goal.objective.as_deref(), Some("finish adapter"));
        assert_eq!(goal.token_budget, Some(42));

        state
            .begin_turn("thread-1", Some("turn-1".to_string()), TurnMode::Plan)
            .expect("turn");
        state.pause_goal("thread-1");
        assert_eq!(
            state.goal("thread-1").map(|goal| goal.status),
            Some(GoalStatus::Paused)
        );
        assert!(state.active_turn("thread-1").is_some());

        state.resume_goal("thread-1");
        assert_eq!(
            state.goal("thread-1").map(|goal| goal.status),
            Some(GoalStatus::Active)
        );
        state.clear_goal("thread-1");
        assert_eq!(
            state.goal("thread-1").map(|goal| goal.status),
            Some(GoalStatus::Cleared)
        );
    }

    #[test]
    fn applies_goal_update_and_clear_notifications() {
        let mut state = AgentRuntimeState::default();
        state.apply_provider_events(&[ProviderEvent::RawNotification {
            method: "thread/goal/updated".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "goal": {
                    "threadId": "thread-1",
                    "objective": "finish adapter parity",
                    "status": "budgetLimited",
                    "tokenBudget": 5000,
                    "tokensUsed": 5000,
                    "timeUsedSeconds": 12
                }
            }),
        }]);

        let goal = state.goal("thread-1").expect("goal");
        assert_eq!(goal.status, GoalStatus::BudgetLimited);
        assert_eq!(goal.objective.as_deref(), Some("finish adapter parity"));
        assert_eq!(goal.token_budget, Some(5000));
        assert_eq!(goal.tokens_used, Some(5000));
        assert_eq!(goal.time_used_seconds, Some(12));

        state.apply_provider_events(&[ProviderEvent::RawNotification {
            method: "thread/goal/cleared".to_string(),
            params: json!({ "threadId": "thread-1" }),
        }]);
        assert_eq!(
            state.goal("thread-1").map(|goal| goal.status),
            Some(GoalStatus::Cleared)
        );
    }

    #[test]
    fn records_subagent_threads_and_handoffs() {
        let mut state = AgentRuntimeState::default();
        state.apply_provider_events(&[ProviderEvent::ThreadItem {
            item: Box::new(NormalizedThreadItem {
                kind: ThreadItemKind::SubAgentActivity,
                status: ThreadItemStatus::Started,
                thread_id: Some("parent-1".to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("item-1".to_string()),
                parent_thread_id: Some("parent-1".to_string()),
                child_thread_id: Some("subagent-1".to_string()),
                sender: Some("reviewer".to_string()),
                role: Some("reviewer".to_string()),
                title: None,
                text: None,
                metadata: json!({}),
                provider: ProviderMetadata {
                    provider: "codex".to_string(),
                    method: Some("item/started".to_string()),
                    schema_version: None,
                    raw_payload: json!({}),
                },
            }),
        }]);
        let subagent = state.subagent("subagent-1").expect("subagent");
        assert_eq!(subagent.parent_thread_id, "parent-1");
        assert_eq!(subagent.role.as_deref(), Some("reviewer"));
        state.record_subagent_action(SubagentActionRecord {
            parent_thread_id: "parent-1".to_string(),
            subagent_thread_id: "subagent-1".to_string(),
            action: SubagentActionKind::Steer,
            prompt: Some("focus on tests".to_string()),
            provider_response: json!({ "steered": true }),
        });
        let action = &state.subagent_actions()[0];
        assert_eq!(action.action, SubagentActionKind::Steer);
        assert_eq!(action.prompt.as_deref(), Some("focus on tests"));
        assert_eq!(action.provider_response["steered"], true);

        state.record_handoff(HandoffPlan {
            source_thread_id: "parent-1".to_string(),
            target_location: ExecutionLocation::Worktree,
            status: HandoffStatus::Completed,
            target_thread_id: Some("subagent-1".to_string()),
            repo_root: Some("/repo".to_string()),
            worktree_path: Some("/worktrees/repo-feature".to_string()),
            branch: Some("feature/task".to_string()),
            start_point: Some("main".to_string()),
            checkpoint_ref: Some("checkpoint-1".to_string()),
            remote_host: None,
            transfer_status: Some("metadata_updated".to_string()),
            interrupted_active_turn: Some(true),
            metadata: json!({ "handoff": { "worktree_branch": "feature/task" } }),
        });
        assert_eq!(state.handoffs().len(), 1);
        let handoff = &state.handoffs()[0];
        assert_eq!(handoff.status, HandoffStatus::Completed);
        assert_eq!(handoff.branch.as_deref(), Some("feature/task"));
        assert_eq!(handoff.start_point.as_deref(), Some("main"));
        assert_eq!(handoff.interrupted_active_turn, Some(true));
        assert_eq!(
            handoff.metadata["handoff"]["worktree_branch"],
            "feature/task"
        );
        state.record_approval_retry(ApprovalRetryRecord {
            thread_id: "parent-1".to_string(),
            item_id: Some("item-1".to_string()),
            action_id: Some("action-1".to_string()),
            approved: true,
            reason: Some("retry after user approval".to_string()),
            audit: json!({ "selected_policy": "on-request" }),
            provider_response: json!({ "approved": true }),
        });
        let retry = &state.approval_retries()[0];
        assert_eq!(retry.thread_id, "parent-1");
        assert_eq!(retry.item_id.as_deref(), Some("item-1"));
        assert_eq!(retry.action_id.as_deref(), Some("action-1"));
        assert!(retry.approved);
        assert_eq!(retry.audit["selected_policy"], "on-request");
        state.close_subagent("subagent-1");
        assert!(state.subagent("subagent-1").is_none());
    }

    #[test]
    fn applies_subagent_action_runtime_signals() {
        let mut state = AgentRuntimeState::default();
        state.apply_provider_events(&[ProviderEvent::RuntimeSignal {
            signal: Box::new(NormalizedRuntimeSignal {
                kind: RuntimeSignalKind::SubagentAction,
                thread_id: Some("parent-1".to_string()),
                turn_id: None,
                item_id: None,
                message: None,
                from_model: None,
                to_model: None,
                reason: None,
                text: Some("focus on tests".to_string()),
                audio: None,
                status: Some("steer".to_string()),
                name: None,
                active: None,
                archived: None,
                diff: None,
                files: None,
                process_id: None,
                exit_code: None,
                request_id: None,
                metadata: json!({
                    "subagent_thread_id": "subagent-1",
                    "provider_response": { "steered": true }
                }),
                provider: ProviderMetadata {
                    provider: "codex".to_string(),
                    method: Some("ace/subagent/steer".to_string()),
                    schema_version: None,
                    raw_payload: json!({}),
                },
            }),
        }]);

        let actions = state.subagent_actions();
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].parent_thread_id, "parent-1");
        assert_eq!(actions[0].subagent_thread_id, "subagent-1");
        assert_eq!(actions[0].action, SubagentActionKind::Steer);
        assert_eq!(actions[0].prompt.as_deref(), Some("focus on tests"));
        assert_eq!(actions[0].provider_response["steered"], true);
    }

    #[test]
    fn applies_thread_lifecycle_runtime_signals() {
        let mut state = AgentRuntimeState::default();
        state.apply_provider_events(&[
            ProviderEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::ThreadLifecycleChanged,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: None,
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: Some("renamed".to_string()),
                    name: Some("Adapter parity".to_string()),
                    active: None,
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({
                        "action": "set_name",
                        "provider_response": { "name": "Adapter parity" }
                    }),
                    provider: ProviderMetadata {
                        provider: "codex".to_string(),
                        method: Some("ace/thread_lifecycle".to_string()),
                        schema_version: None,
                        raw_payload: json!({}),
                    },
                }),
            },
            ProviderEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::ThreadLifecycleChanged,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: None,
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: Some("rolled_back".to_string()),
                    name: None,
                    active: None,
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({
                        "action": "rollback",
                        "turn_id": "turn-2",
                        "provider_response": { "rolled_back": true }
                    }),
                    provider: ProviderMetadata {
                        provider: "codex".to_string(),
                        method: Some("ace/thread_lifecycle".to_string()),
                        schema_version: None,
                        raw_payload: json!({}),
                    },
                }),
            },
            ProviderEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::ThreadLifecycleChanged,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: None,
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: Some("items_injected".to_string()),
                    name: None,
                    active: None,
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({
                        "action": "inject_items",
                        "item_count": 2,
                        "items": [{ "type": "userMessage" }, { "type": "agentMessage" }],
                        "provider_response": { "injected": true }
                    }),
                    provider: ProviderMetadata {
                        provider: "codex".to_string(),
                        method: Some("ace/thread_lifecycle".to_string()),
                        schema_version: None,
                        raw_payload: json!({}),
                    },
                }),
            },
        ]);

        let lifecycle = state.thread_lifecycle();
        assert_eq!(lifecycle.len(), 3);
        assert_eq!(lifecycle[0].action, ThreadLifecycleActionKind::SetName);
        assert_eq!(lifecycle[0].name.as_deref(), Some("Adapter parity"));
        assert_eq!(lifecycle[0].request["name"], "Adapter parity");
        assert_eq!(lifecycle[0].provider_response["name"], "Adapter parity");
        assert_eq!(lifecycle[1].action, ThreadLifecycleActionKind::Rollback);
        assert_eq!(lifecycle[1].turn_id.as_deref(), Some("turn-2"));
        assert_eq!(lifecycle[1].request["turn_id"], "turn-2");
        assert_eq!(lifecycle[1].provider_response["rolled_back"], true);
        assert_eq!(lifecycle[2].action, ThreadLifecycleActionKind::InjectItems);
        assert_eq!(lifecycle[2].item_count, Some(2));
        assert_eq!(lifecycle[2].request["items"][1]["type"], "agentMessage");
        assert_eq!(lifecycle[2].provider_response["injected"], true);
    }

    #[test]
    fn applies_handoff_runtime_signals() {
        let mut state = AgentRuntimeState::default();
        state.apply_provider_events(&[ProviderEvent::RuntimeSignal {
            signal: Box::new(NormalizedRuntimeSignal {
                kind: RuntimeSignalKind::HandoffUpdated,
                thread_id: Some("thread-1".to_string()),
                turn_id: None,
                item_id: None,
                message: None,
                from_model: None,
                to_model: None,
                reason: None,
                text: None,
                audio: None,
                status: Some("completed".to_string()),
                name: None,
                active: None,
                archived: None,
                diff: None,
                files: None,
                process_id: None,
                exit_code: None,
                request_id: None,
                metadata: json!({
                    "handoff": {
                        "source_thread_id": "thread-1",
                        "target_location": "worktree",
                        "status": "completed",
                        "target_thread_id": "thread-1",
                        "repo_root": "/repo",
                        "worktree_path": "/worktrees/repo-feature",
                        "branch": "feature/task",
                        "start_point": "main",
                        "transfer_status": "metadata_updated",
                        "interrupted_active_turn": true,
                        "metadata": { "handoff": { "worktree_branch": "feature/task" } }
                    }
                }),
                provider: ProviderMetadata {
                    provider: "codex".to_string(),
                    method: Some("ace/handoff".to_string()),
                    schema_version: None,
                    raw_payload: json!({}),
                },
            }),
        }]);

        let handoffs = state.handoffs();
        assert_eq!(handoffs.len(), 1);
        assert_eq!(handoffs[0].source_thread_id, "thread-1");
        assert_eq!(handoffs[0].target_location, ExecutionLocation::Worktree);
        assert_eq!(handoffs[0].status, HandoffStatus::Completed);
        assert_eq!(handoffs[0].branch.as_deref(), Some("feature/task"));
        assert_eq!(handoffs[0].interrupted_active_turn, Some(true));
    }

    #[test]
    fn applies_plan_implementation_runtime_signals() {
        let mut state = AgentRuntimeState::default();
        state.apply_provider_events(&[ProviderEvent::RuntimeSignal {
            signal: Box::new(NormalizedRuntimeSignal {
                kind: RuntimeSignalKind::PlanImplementationUpdated,
                thread_id: Some("thread-1".to_string()),
                turn_id: None,
                item_id: None,
                message: None,
                from_model: None,
                to_model: None,
                reason: None,
                text: None,
                audio: None,
                status: Some("fork_for_implementation".to_string()),
                name: None,
                active: None,
                archived: None,
                diff: None,
                files: None,
                process_id: None,
                exit_code: None,
                request_id: None,
                metadata: json!({
                    "plan_implementation": {
                        "parent_thread_id": "thread-1",
                        "target_thread_id": "fork-1",
                        "mode": "fork_for_implementation",
                        "prompt": "implement this plan",
                        "model": "gpt-5.5",
                        "cwd": "/repo",
                        "plan": { "markdown": "1. Edit\n2. Test" },
                        "sandbox_policy": { "mode": "workspace-write" },
                        "approval_policy": { "mode": "on-request" },
                        "approvals_reviewer": "user",
                        "provider_response": { "forked": true }
                    }
                }),
                provider: ProviderMetadata {
                    provider: "codex".to_string(),
                    method: Some("ace/plan_implementation".to_string()),
                    schema_version: None,
                    raw_payload: json!({}),
                },
            }),
        }]);

        let implementations = state.plan_implementations();
        assert_eq!(implementations.len(), 1);
        assert_eq!(implementations[0].parent_thread_id, "thread-1");
        assert_eq!(implementations[0].target_thread_id, "fork-1");
        assert_eq!(
            implementations[0].mode,
            PlanImplementationMode::ForkForImplementation
        );
        assert_eq!(implementations[0].prompt, "implement this plan");
        assert_eq!(implementations[0].plan["markdown"], "1. Edit\n2. Test");
        assert_eq!(implementations[0].provider_response["forked"], true);
    }

    #[test]
    fn records_thread_lifecycle_actions_with_raw_payloads() {
        let mut state = AgentRuntimeState::default();
        state.record_thread_lifecycle(ThreadLifecycleRecord {
            thread_id: "thread-1".to_string(),
            action: ThreadLifecycleActionKind::SetName,
            turn_id: None,
            name: Some("Adapter work".to_string()),
            item_count: None,
            request: json!({ "name": "Adapter work" }),
            provider_response: json!({ "name": "Adapter work" }),
        });
        state.record_thread_lifecycle(ThreadLifecycleRecord {
            thread_id: "thread-1".to_string(),
            action: ThreadLifecycleActionKind::Rollback,
            turn_id: Some("turn-2".to_string()),
            name: None,
            item_count: None,
            request: json!({ "turn_id": "turn-2" }),
            provider_response: json!({ "rolled_back": true }),
        });

        let lifecycle = state.thread_lifecycle();
        assert_eq!(lifecycle.len(), 2);
        assert_eq!(lifecycle[0].action, ThreadLifecycleActionKind::SetName);
        assert_eq!(lifecycle[0].name.as_deref(), Some("Adapter work"));
        assert_eq!(lifecycle[0].provider_response["name"], "Adapter work");
        assert_eq!(lifecycle[1].action, ThreadLifecycleActionKind::Rollback);
        assert_eq!(lifecycle[1].turn_id.as_deref(), Some("turn-2"));
        assert_eq!(lifecycle[1].request["turn_id"], "turn-2");
    }

    #[test]
    fn snapshots_runtime_state_with_stable_ordering() {
        let mut state = AgentRuntimeState::default();
        state
            .begin_turn("thread-b", Some("turn-b".to_string()), TurnMode::Normal)
            .expect("begin b");
        state
            .begin_turn("thread-a", Some("turn-a".to_string()), TurnMode::Plan)
            .expect("begin a");
        state.set_goal("thread-b", "Ship adapter", Some(100));
        state.record_fork(ForkPoint {
            parent_thread_id: "thread-a".to_string(),
            child_thread_id: "child-b".to_string(),
            turn_id: Some("turn-a".to_string()),
        });
        state.record_fork(ForkPoint {
            parent_thread_id: "thread-a".to_string(),
            child_thread_id: "child-a".to_string(),
            turn_id: None,
        });
        state.record_side_chat(SideChat {
            parent_thread_id: "thread-a".to_string(),
            thread_id: "side-b".to_string(),
            ephemeral: true,
        });
        state.record_side_chat(SideChat {
            parent_thread_id: "thread-a".to_string(),
            thread_id: "side-a".to_string(),
            ephemeral: true,
        });
        state.record_subagent(SubagentThread {
            parent_thread_id: "thread-a".to_string(),
            thread_id: "sub-b".to_string(),
            role: Some("reviewer".to_string()),
            nickname: None,
        });
        state.record_subagent(SubagentThread {
            parent_thread_id: "thread-a".to_string(),
            thread_id: "sub-a".to_string(),
            role: Some("planner".to_string()),
            nickname: None,
        });
        state.apply_provider_events(&[ProviderEvent::ThreadItem {
            item: Box::new(NormalizedThreadItem {
                kind: ThreadItemKind::EnteredReviewMode,
                status: ThreadItemStatus::Completed,
                thread_id: Some("thread-c".to_string()),
                turn_id: None,
                item_id: Some("review-1".to_string()),
                parent_thread_id: None,
                child_thread_id: None,
                sender: None,
                role: None,
                title: None,
                text: None,
                metadata: json!({}),
                provider: ProviderMetadata {
                    provider: "codex".to_string(),
                    method: Some("item/completed".to_string()),
                    schema_version: None,
                    raw_payload: json!({}),
                },
            }),
        }]);

        let snapshot = state.snapshot();
        assert_eq!(
            snapshot
                .active_turns
                .iter()
                .map(|turn| turn.thread_id.as_str())
                .collect::<Vec<_>>(),
            ["thread-a", "thread-b"]
        );
        assert_eq!(snapshot.plan_sessions[0].thread_id, "thread-a");
        assert_eq!(snapshot.goals[0].thread_id, "thread-b");
        assert_eq!(
            snapshot
                .fork_points
                .iter()
                .map(|fork| fork.child_thread_id.as_str())
                .collect::<Vec<_>>(),
            ["child-a", "child-b"]
        );
        assert_eq!(
            snapshot
                .side_chats
                .iter()
                .map(|side_chat| side_chat.thread_id.as_str())
                .collect::<Vec<_>>(),
            ["side-a", "side-b"]
        );
        assert_eq!(
            snapshot
                .subagents
                .iter()
                .map(|subagent| subagent.thread_id.as_str())
                .collect::<Vec<_>>(),
            ["sub-a", "sub-b"]
        );
        assert_eq!(snapshot.review_threads, ["thread-c"]);
    }

    #[test]
    fn records_forks_side_chats_and_review_state() {
        let mut state = AgentRuntimeState::default();
        state.record_fork(ForkPoint {
            parent_thread_id: "parent-1".to_string(),
            child_thread_id: "child-1".to_string(),
            turn_id: Some("turn-2".to_string()),
        });
        state.record_side_chat(SideChat {
            parent_thread_id: "parent-1".to_string(),
            thread_id: "child-1".to_string(),
            ephemeral: true,
        });

        assert_eq!(
            state
                .fork_point("child-1")
                .and_then(|fork| fork.turn_id.as_deref()),
            Some("turn-2")
        );
        assert_eq!(
            state
                .side_chat("child-1")
                .map(|side_chat| side_chat.parent_thread_id.as_str()),
            Some("parent-1")
        );

        state.apply_provider_events(&[ProviderEvent::ThreadItem {
            item: Box::new(NormalizedThreadItem {
                kind: ThreadItemKind::EnteredReviewMode,
                status: ThreadItemStatus::Started,
                thread_id: Some("parent-1".to_string()),
                turn_id: None,
                item_id: Some("review-1".to_string()),
                parent_thread_id: None,
                child_thread_id: None,
                sender: None,
                role: None,
                title: None,
                text: None,
                metadata: json!({}),
                provider: ProviderMetadata {
                    provider: "codex".to_string(),
                    method: Some("item/started".to_string()),
                    schema_version: None,
                    raw_payload: json!({}),
                },
            }),
        }]);
        assert!(state.is_reviewing("parent-1"));

        state.close_side_chat("child-1");
        assert!(state.side_chat("child-1").is_none());
    }
}

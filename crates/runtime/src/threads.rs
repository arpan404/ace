use crate::provider::{
    NormalizedRuntimeSignal, NormalizedServerRequest, NormalizedServerRequestDecision,
    NormalizedThreadItem, ProviderEvent, RuntimeSignalKind, ThreadItemKind, ThreadItemStatus,
};
use crate::tools::SemanticToolCall;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use thiserror::Error;

const MAX_THREAD_ITEM_RECORDS: usize = 4096;
const MAX_TOOL_TIMELINE_RECORDS: usize = 2048;
const MAX_TERMINAL_OUTPUT_RECORDS: usize = 256;
const MAX_TERMINAL_OUTPUT_BYTES_PER_RECORD: usize = 64 * 1024;
const MAX_REALTIME_STREAM_RECORDS: usize = 128;
const MAX_REALTIME_TRANSCRIPT_BYTES_PER_RECORD: usize = 64 * 1024;
const MAX_REALTIME_AUDIO_CHUNKS_PER_RECORD: usize = 64;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    pub status: PlanSessionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub questions: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion: Option<String>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChildThreadRelationship {
    Fork,
    SideChat,
    Subagent,
    Handoff,
    Review,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChildThreadRecord {
    pub provider: String,
    pub parent_thread_id: String,
    pub thread_id: String,
    pub relationship: ChildThreadRelationship,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nickname: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_location: Option<ExecutionLocation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ephemeral: Option<bool>,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub metadata: Value,
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
    pub reasoning_effort: Option<String>,
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
    Start,
    Resume,
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
pub struct TurnDiffRecord {
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub files: Value,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProcessExitRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalOutputRecord {
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_id: Option<String>,
    pub text: String,
    pub truncated_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeWarningRecord {
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub message: String,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelRerouteRecord {
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderStateRecord {
    pub provider: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RemoteConnectionRecord {
    pub provider: String,
    pub host_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub execution_location: ExecutionLocation,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub projects: Value,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RealtimeSessionRecord {
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TurnModerationRecord {
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub status: String,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RealtimeTranscriptRecord {
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub text: String,
    pub truncated_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RealtimeAudioRecord {
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub chunks: Vec<String>,
    pub truncated_chunks: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AutoApprovalReviewRecord {
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApprovalRecord {
    pub provider: String,
    pub request_id: String,
    pub request: NormalizedServerRequest,
    pub status: ApprovalStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<NormalizedServerRequestDecision>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    Pending,
    Resolved,
}

type RuntimeThreadTurnKey = (Option<String>, Option<String>);
type AutoApprovalReviewKey = (Option<String>, Option<String>, Option<String>);
type ApprovalKey = (String, String);
type ChildThreadKey = (String, String, String, ChildThreadRelationship);
type RemoteConnectionKey = (String, String);
type RealtimeStreamKey = (String, Option<String>, Option<String>);
type TerminalOutputKey = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ThreadItemKey {
    provider: String,
    thread_id: Option<String>,
    turn_id: Option<String>,
    identity: ThreadItemIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum ThreadItemIdentity {
    ProviderItem(String),
    Generated(u64),
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ToolTimelineKey {
    provider: String,
    thread_id: Option<String>,
    turn_id: Option<String>,
    identity: ToolTimelineIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum ToolTimelineIdentity {
    ProviderItem(String),
    Descriptor {
        method: Option<String>,
        server_name: Option<String>,
        tool_name: Option<String>,
        operation: Option<String>,
        action: String,
    },
    Generated(u64),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentThread {
    pub thread_id: String,
    pub provider: String,
    pub execution_location: ExecutionLocation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_turn: Option<Turn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_session: Option<PlanSession>,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub settings: Value,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub token_usage: Value,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AgentRuntimeState {
    threads: HashMap<String, AgentThread>,
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
    turn_diffs: HashMap<(String, Option<String>), TurnDiffRecord>,
    terminal_outputs: HashMap<TerminalOutputKey, TerminalOutputRecord>,
    terminal_output_order: VecDeque<TerminalOutputKey>,
    process_exits: Vec<ProcessExitRecord>,
    warnings: Vec<RuntimeWarningRecord>,
    model_reroutes: Vec<ModelRerouteRecord>,
    provider_states: HashMap<String, ProviderStateRecord>,
    remote_connections: HashMap<RemoteConnectionKey, RemoteConnectionRecord>,
    realtime_sessions: HashMap<RuntimeThreadTurnKey, RealtimeSessionRecord>,
    realtime_transcripts: HashMap<RealtimeStreamKey, RealtimeTranscriptRecord>,
    realtime_transcript_order: VecDeque<RealtimeStreamKey>,
    realtime_audio: HashMap<RealtimeStreamKey, RealtimeAudioRecord>,
    realtime_audio_order: VecDeque<RealtimeStreamKey>,
    turn_moderation: HashMap<RuntimeThreadTurnKey, TurnModerationRecord>,
    auto_approval_reviews: HashMap<AutoApprovalReviewKey, AutoApprovalReviewRecord>,
    approvals: HashMap<ApprovalKey, ApprovalRecord>,
    review_threads: HashSet<String>,
    #[serde(skip)]
    thread_items: HashMap<ThreadItemKey, NormalizedThreadItem>,
    #[serde(skip)]
    thread_item_order: VecDeque<ThreadItemKey>,
    #[serde(skip)]
    next_thread_item_sequence: u64,
    #[serde(skip)]
    tool_timeline: HashMap<ToolTimelineKey, SemanticToolCall>,
    #[serde(skip)]
    tool_timeline_order: VecDeque<ToolTimelineKey>,
    #[serde(skip)]
    next_tool_timeline_sequence: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AgentRuntimeSnapshot {
    pub threads: Vec<AgentThread>,
    pub child_threads: Vec<ChildThreadRecord>,
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
    pub turn_diffs: Vec<TurnDiffRecord>,
    pub terminal_outputs: Vec<TerminalOutputRecord>,
    pub process_exits: Vec<ProcessExitRecord>,
    pub warnings: Vec<RuntimeWarningRecord>,
    pub model_reroutes: Vec<ModelRerouteRecord>,
    pub provider_states: Vec<ProviderStateRecord>,
    pub remote_connections: Vec<RemoteConnectionRecord>,
    pub realtime_sessions: Vec<RealtimeSessionRecord>,
    pub realtime_transcripts: Vec<RealtimeTranscriptRecord>,
    pub realtime_audio: Vec<RealtimeAudioRecord>,
    pub turn_moderation: Vec<TurnModerationRecord>,
    pub auto_approval_reviews: Vec<AutoApprovalReviewRecord>,
    pub approvals: Vec<ApprovalRecord>,
    pub review_threads: Vec<String>,
    #[serde(default)]
    pub tool_timeline: Vec<SemanticToolCall>,
    #[serde(default)]
    pub thread_items: Vec<NormalizedThreadItem>,
}

impl AgentRuntimeState {
    #[must_use]
    pub fn snapshot(&self) -> AgentRuntimeSnapshot {
        let mut threads = self.threads.values().cloned().collect::<Vec<_>>();
        for thread in &mut threads {
            thread.active_turn = self.active_turns.get(&thread.thread_id).cloned();
            thread.plan_session = self.plan_sessions.get(&thread.thread_id).cloned();
        }
        threads.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));

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

        let mut turn_diffs = self.turn_diffs.values().cloned().collect::<Vec<_>>();
        turn_diffs.sort_by(|left, right| {
            left.thread_id
                .cmp(&right.thread_id)
                .then_with(|| left.turn_id.cmp(&right.turn_id))
        });

        let terminal_outputs = self.terminal_outputs_in_order();

        let mut provider_states = self.provider_states.values().cloned().collect::<Vec<_>>();
        provider_states.sort_by(|left, right| left.provider.cmp(&right.provider));

        let mut remote_connections = self
            .remote_connections
            .values()
            .cloned()
            .collect::<Vec<_>>();
        remote_connections.sort_by(|left, right| {
            left.provider
                .cmp(&right.provider)
                .then_with(|| left.host_id.cmp(&right.host_id))
        });

        let mut realtime_sessions = self.realtime_sessions.values().cloned().collect::<Vec<_>>();
        realtime_sessions.sort_by(|left, right| {
            left.thread_id
                .cmp(&right.thread_id)
                .then_with(|| left.turn_id.cmp(&right.turn_id))
        });

        let realtime_transcripts = self.realtime_transcripts_in_order();
        let realtime_audio = self.realtime_audio_in_order();

        let mut turn_moderation = self.turn_moderation.values().cloned().collect::<Vec<_>>();
        turn_moderation.sort_by(|left, right| {
            left.thread_id
                .cmp(&right.thread_id)
                .then_with(|| left.turn_id.cmp(&right.turn_id))
        });

        let mut auto_approval_reviews = self
            .auto_approval_reviews
            .values()
            .cloned()
            .collect::<Vec<_>>();
        auto_approval_reviews.sort_by(|left, right| {
            left.thread_id
                .cmp(&right.thread_id)
                .then_with(|| left.turn_id.cmp(&right.turn_id))
                .then_with(|| left.item_id.cmp(&right.item_id))
        });

        let mut approvals = self.approvals.values().cloned().collect::<Vec<_>>();
        approvals.sort_by(|left, right| {
            left.provider
                .cmp(&right.provider)
                .then_with(|| left.request_id.cmp(&right.request_id))
        });

        let mut review_threads = self.review_threads.iter().cloned().collect::<Vec<_>>();
        review_threads.sort();

        let thread_items = self.thread_items_in_order();
        let child_threads = self.child_threads_from_items(&thread_items);
        let tool_timeline = self.tool_timeline_in_order();

        AgentRuntimeSnapshot {
            threads,
            child_threads,
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
            turn_diffs,
            terminal_outputs,
            process_exits: self.process_exits.clone(),
            warnings: self.warnings.clone(),
            model_reroutes: self.model_reroutes.clone(),
            provider_states,
            remote_connections,
            realtime_sessions,
            realtime_transcripts,
            realtime_audio,
            turn_moderation,
            auto_approval_reviews,
            approvals,
            review_threads,
            tool_timeline,
            thread_items,
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

    pub fn upsert_thread(&mut self, thread: AgentThread) {
        if let Some(existing) = self.threads.get_mut(&thread.thread_id) {
            let settings = if thread.settings.is_null() {
                existing.settings.clone()
            } else {
                thread.settings.clone()
            };
            let token_usage = if thread.token_usage.is_null() {
                existing.token_usage.clone()
            } else {
                thread.token_usage.clone()
            };
            let name = thread.name.clone().or_else(|| existing.name.clone());
            let active = thread.active.or(existing.active);
            let archived = thread.archived.or(existing.archived);
            *existing = AgentThread {
                name,
                active,
                archived,
                settings,
                token_usage,
                ..thread
            };
        } else {
            self.threads.insert(thread.thread_id.clone(), thread);
        }
    }

    pub fn upsert_threads(&mut self, threads: impl IntoIterator<Item = AgentThread>) {
        for thread in threads {
            self.upsert_thread(thread);
        }
    }

    pub fn update_thread_settings(
        &mut self,
        thread_id: impl Into<String>,
        provider: impl Into<String>,
        settings: Value,
    ) {
        let thread = self.ensure_thread(thread_id.into(), provider.into());
        thread.settings = settings;
    }

    pub fn update_thread_token_usage(
        &mut self,
        thread_id: impl Into<String>,
        provider: impl Into<String>,
        token_usage: Value,
    ) {
        let thread = self.ensure_thread(thread_id.into(), provider.into());
        thread.token_usage = token_usage;
    }

    #[must_use]
    pub fn thread(&self, thread_id: &str) -> Option<&AgentThread> {
        self.threads.get(thread_id)
    }

    #[must_use]
    pub fn threads(&self) -> Vec<AgentThread> {
        let mut threads = self.threads.values().cloned().collect::<Vec<_>>();
        threads.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));
        threads
    }

    #[must_use]
    pub fn thread_items(&self) -> Vec<NormalizedThreadItem> {
        self.thread_items_in_order()
    }

    #[must_use]
    pub fn tool_timeline(&self) -> Vec<SemanticToolCall> {
        self.tool_timeline_in_order()
    }

    #[must_use]
    pub fn child_threads(&self) -> Vec<ChildThreadRecord> {
        let thread_items = self.thread_items_in_order();
        self.child_threads_from_items(&thread_items)
    }

    fn thread_items_in_order(&self) -> Vec<NormalizedThreadItem> {
        self.thread_item_order
            .iter()
            .filter_map(|key| self.thread_items.get(key).cloned())
            .collect()
    }

    fn tool_timeline_in_order(&self) -> Vec<SemanticToolCall> {
        self.tool_timeline_order
            .iter()
            .filter_map(|key| self.tool_timeline.get(key).cloned())
            .collect()
    }

    fn child_threads_from_items(
        &self,
        thread_items: &[NormalizedThreadItem],
    ) -> Vec<ChildThreadRecord> {
        let mut records: HashMap<ChildThreadKey, ChildThreadRecord> = HashMap::new();

        for fork in self.fork_points.values() {
            insert_child_thread(
                &mut records,
                ChildThreadRecord {
                    provider: provider_for_thread(
                        self,
                        &fork.parent_thread_id,
                        &fork.child_thread_id,
                    ),
                    parent_thread_id: fork.parent_thread_id.clone(),
                    thread_id: fork.child_thread_id.clone(),
                    relationship: ChildThreadRelationship::Fork,
                    turn_id: fork.turn_id.clone(),
                    item_id: None,
                    role: None,
                    nickname: None,
                    status: Some("created".to_string()),
                    execution_location: self
                        .threads
                        .get(&fork.child_thread_id)
                        .map(|thread| thread.execution_location),
                    ephemeral: None,
                    metadata: Value::Null,
                },
            );
        }

        for side_chat in self.side_chats.values() {
            insert_child_thread(
                &mut records,
                ChildThreadRecord {
                    provider: provider_for_thread(
                        self,
                        &side_chat.parent_thread_id,
                        &side_chat.thread_id,
                    ),
                    parent_thread_id: side_chat.parent_thread_id.clone(),
                    thread_id: side_chat.thread_id.clone(),
                    relationship: ChildThreadRelationship::SideChat,
                    turn_id: self
                        .fork_points
                        .get(&side_chat.thread_id)
                        .and_then(|fork| fork.turn_id.clone()),
                    item_id: None,
                    role: Some("side_chat".to_string()),
                    nickname: None,
                    status: Some(
                        if side_chat.ephemeral {
                            "ephemeral"
                        } else {
                            "active"
                        }
                        .to_string(),
                    ),
                    execution_location: self
                        .threads
                        .get(&side_chat.thread_id)
                        .map(|thread| thread.execution_location),
                    ephemeral: Some(side_chat.ephemeral),
                    metadata: Value::Null,
                },
            );
        }

        for subagent in self.subagents.values() {
            insert_child_thread(
                &mut records,
                ChildThreadRecord {
                    provider: provider_for_thread(
                        self,
                        &subagent.parent_thread_id,
                        &subagent.thread_id,
                    ),
                    parent_thread_id: subagent.parent_thread_id.clone(),
                    thread_id: subagent.thread_id.clone(),
                    relationship: ChildThreadRelationship::Subagent,
                    turn_id: None,
                    item_id: None,
                    role: subagent.role.clone(),
                    nickname: subagent.nickname.clone(),
                    status: Some("active".to_string()),
                    execution_location: self
                        .threads
                        .get(&subagent.thread_id)
                        .map(|thread| thread.execution_location),
                    ephemeral: None,
                    metadata: Value::Null,
                },
            );
        }

        for handoff in &self.handoffs {
            let Some(target_thread_id) = handoff.target_thread_id.as_deref() else {
                continue;
            };
            if target_thread_id == handoff.source_thread_id {
                continue;
            }
            insert_child_thread(
                &mut records,
                ChildThreadRecord {
                    provider: provider_for_thread(
                        self,
                        &handoff.source_thread_id,
                        target_thread_id,
                    ),
                    parent_thread_id: handoff.source_thread_id.clone(),
                    thread_id: target_thread_id.to_string(),
                    relationship: ChildThreadRelationship::Handoff,
                    turn_id: None,
                    item_id: None,
                    role: None,
                    nickname: None,
                    status: Some(handoff_status_key(handoff.status).to_string()),
                    execution_location: Some(handoff.target_location),
                    ephemeral: None,
                    metadata: handoff.metadata.clone(),
                },
            );
        }

        for item in thread_items {
            if matches!(
                item.kind,
                ThreadItemKind::SubAgentActivity
                    | ThreadItemKind::CollabAgentToolCall
                    | ThreadItemKind::EnteredReviewMode
                    | ThreadItemKind::ExitedReviewMode
            ) && let (Some(parent_thread_id), Some(child_thread_id)) = (
                item.parent_thread_id
                    .as_deref()
                    .or(item.thread_id.as_deref()),
                item.child_thread_id.as_deref(),
            ) {
                let relationship = match item.kind {
                    ThreadItemKind::EnteredReviewMode | ThreadItemKind::ExitedReviewMode => {
                        ChildThreadRelationship::Review
                    }
                    _ => ChildThreadRelationship::Subagent,
                };
                if parent_thread_id == child_thread_id
                    && relationship == ChildThreadRelationship::Review
                {
                    continue;
                }
                insert_child_thread(
                    &mut records,
                    ChildThreadRecord {
                        provider: item.provider.provider.clone(),
                        parent_thread_id: parent_thread_id.to_string(),
                        thread_id: child_thread_id.to_string(),
                        relationship,
                        turn_id: item.turn_id.clone(),
                        item_id: item.item_id.clone(),
                        role: item.role.clone(),
                        nickname: item.sender.clone(),
                        status: Some(thread_item_status_key(item.status).to_string()),
                        execution_location: self
                            .threads
                            .get(child_thread_id)
                            .map(|thread| thread.execution_location),
                        ephemeral: None,
                        metadata: item.metadata.clone(),
                    },
                );
            }
        }

        let mut records = records.into_values().collect::<Vec<_>>();
        records.sort_by(|left, right| {
            left.parent_thread_id
                .cmp(&right.parent_thread_id)
                .then_with(|| left.thread_id.cmp(&right.thread_id))
                .then_with(|| {
                    relationship_key(left.relationship).cmp(relationship_key(right.relationship))
                })
        });
        records
    }

    pub fn upsert_thread_item(&mut self, item: NormalizedThreadItem) {
        let key = self.thread_item_key(&item);
        let is_new = !self.thread_items.contains_key(&key);
        self.thread_items.insert(key.clone(), item);
        if is_new {
            self.thread_item_order.push_back(key);
            while self.thread_item_order.len() > MAX_THREAD_ITEM_RECORDS {
                if let Some(oldest) = self.thread_item_order.pop_front() {
                    self.thread_items.remove(&oldest);
                }
            }
        }
    }

    pub fn upsert_tool_timeline(&mut self, tool: SemanticToolCall) {
        let key = self.tool_timeline_key(&tool);
        let is_new = !self.tool_timeline.contains_key(&key);
        self.tool_timeline.insert(key.clone(), tool);
        if is_new {
            self.tool_timeline_order.push_back(key);
            while self.tool_timeline_order.len() > MAX_TOOL_TIMELINE_RECORDS {
                if let Some(oldest) = self.tool_timeline_order.pop_front() {
                    self.tool_timeline.remove(&oldest);
                }
            }
        }
    }

    fn thread_item_key(&mut self, item: &NormalizedThreadItem) -> ThreadItemKey {
        let identity = item.item_id.as_ref().map_or_else(
            || {
                let sequence = self.next_thread_item_sequence;
                self.next_thread_item_sequence = self.next_thread_item_sequence.saturating_add(1);
                ThreadItemIdentity::Generated(sequence)
            },
            |item_id| ThreadItemIdentity::ProviderItem(item_id.clone()),
        );
        ThreadItemKey {
            provider: item.provider.provider.clone(),
            thread_id: item.thread_id.clone(),
            turn_id: item.turn_id.clone(),
            identity,
        }
    }

    fn tool_timeline_key(&mut self, tool: &SemanticToolCall) -> ToolTimelineKey {
        let provider = tool
            .provider
            .provider
            .clone()
            .unwrap_or_else(|| "unknown".to_string());
        let identity = tool.provider.item_id.as_ref().map_or_else(
            || {
                if tool.provider.method.is_some()
                    || tool.provider.server_name.is_some()
                    || tool.provider.tool_name.is_some()
                    || tool.provider.operation.is_some()
                {
                    ToolTimelineIdentity::Descriptor {
                        method: tool.provider.method.clone(),
                        server_name: tool.provider.server_name.clone(),
                        tool_name: tool.provider.tool_name.clone(),
                        operation: tool.provider.operation.clone(),
                        action: tool_action_key(tool),
                    }
                } else {
                    let sequence = self.next_tool_timeline_sequence;
                    self.next_tool_timeline_sequence =
                        self.next_tool_timeline_sequence.saturating_add(1);
                    ToolTimelineIdentity::Generated(sequence)
                }
            },
            |item_id| ToolTimelineIdentity::ProviderItem(item_id.clone()),
        );
        ToolTimelineKey {
            provider,
            thread_id: tool.provider.thread_id.clone(),
            turn_id: tool.provider.turn_id.clone(),
            identity,
        }
    }

    fn ensure_thread(&mut self, thread_id: String, provider: String) -> &mut AgentThread {
        self.threads
            .entry(thread_id.clone())
            .or_insert_with(|| AgentThread {
                thread_id,
                provider,
                execution_location: ExecutionLocation::Local,
                name: None,
                active: None,
                archived: None,
                active_turn: None,
                plan_session: None,
                settings: Value::Null,
                token_usage: Value::Null,
                metadata: Value::Null,
            })
    }

    pub fn record_side_chat(&mut self, side_chat: SideChat) {
        self.side_chats
            .insert(side_chat.thread_id.clone(), side_chat);
    }

    pub fn close_side_chat(&mut self, thread_id: &str) {
        self.side_chats.remove(thread_id);
    }

    pub fn set_review_mode(&mut self, thread_id: &str, active: bool) {
        if active {
            self.review_threads.insert(thread_id.to_string());
        } else {
            self.review_threads.remove(thread_id);
        }
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

    pub fn upsert_turn_diff(&mut self, diff: TurnDiffRecord) {
        self.turn_diffs
            .insert((diff.thread_id.clone(), diff.turn_id.clone()), diff);
    }

    pub fn record_process_exit(&mut self, process: ProcessExitRecord) {
        self.process_exits.push(process);
    }

    pub fn record_warning(&mut self, warning: RuntimeWarningRecord) {
        self.warnings.push(warning);
    }

    pub fn record_model_reroute(&mut self, reroute: ModelRerouteRecord) {
        self.model_reroutes.push(reroute);
    }

    pub fn upsert_provider_state(&mut self, state: ProviderStateRecord) {
        self.provider_states.insert(state.provider.clone(), state);
    }

    pub fn upsert_remote_connection(&mut self, connection: RemoteConnectionRecord) {
        self.remote_connections.insert(
            (connection.provider.clone(), connection.host_id.clone()),
            connection,
        );
    }

    pub fn replace_remote_connections(
        &mut self,
        provider: &str,
        connections: impl IntoIterator<Item = RemoteConnectionRecord>,
    ) {
        self.remote_connections
            .retain(|(existing_provider, _), _| existing_provider != provider);
        for connection in connections {
            self.upsert_remote_connection(connection);
        }
    }

    #[must_use]
    pub fn remote_connections(&self) -> Vec<RemoteConnectionRecord> {
        let mut connections = self
            .remote_connections
            .values()
            .cloned()
            .collect::<Vec<_>>();
        connections.sort_by(|left, right| {
            left.provider
                .cmp(&right.provider)
                .then_with(|| left.host_id.cmp(&right.host_id))
        });
        connections
    }

    pub fn upsert_realtime_session(&mut self, session: RealtimeSessionRecord) {
        self.realtime_sessions.insert(
            (session.thread_id.clone(), session.turn_id.clone()),
            session,
        );
    }

    pub fn append_realtime_transcript(&mut self, signal: &NormalizedRuntimeSignal) {
        let Some(delta) = signal.text.as_deref().filter(|text| !text.is_empty()) else {
            return;
        };
        let key = (
            signal.provider.provider.clone(),
            signal.thread_id.clone(),
            signal.turn_id.clone(),
        );
        let is_new = !self.realtime_transcripts.contains_key(&key);
        let record = self
            .realtime_transcripts
            .entry(key.clone())
            .or_insert_with(|| RealtimeTranscriptRecord {
                provider: signal.provider.provider.clone(),
                thread_id: signal.thread_id.clone(),
                turn_id: signal.turn_id.clone(),
                text: String::new(),
                truncated_bytes: 0,
            });
        append_bounded_text(
            &mut record.text,
            &mut record.truncated_bytes,
            delta,
            MAX_REALTIME_TRANSCRIPT_BYTES_PER_RECORD,
        );
        if is_new {
            self.realtime_transcript_order.push_back(key);
            while self.realtime_transcript_order.len() > MAX_REALTIME_STREAM_RECORDS {
                if let Some(oldest) = self.realtime_transcript_order.pop_front() {
                    self.realtime_transcripts.remove(&oldest);
                }
            }
        }
    }

    pub fn append_realtime_audio(&mut self, signal: &NormalizedRuntimeSignal) {
        let Some(chunk) = signal.audio.as_ref().filter(|audio| !audio.is_empty()) else {
            return;
        };
        let key = (
            signal.provider.provider.clone(),
            signal.thread_id.clone(),
            signal.turn_id.clone(),
        );
        let is_new = !self.realtime_audio.contains_key(&key);
        let record =
            self.realtime_audio
                .entry(key.clone())
                .or_insert_with(|| RealtimeAudioRecord {
                    provider: signal.provider.provider.clone(),
                    thread_id: signal.thread_id.clone(),
                    turn_id: signal.turn_id.clone(),
                    chunks: Vec::new(),
                    truncated_chunks: 0,
                });
        record.chunks.push(chunk.clone());
        while record.chunks.len() > MAX_REALTIME_AUDIO_CHUNKS_PER_RECORD {
            record.chunks.remove(0);
            record.truncated_chunks = record.truncated_chunks.saturating_add(1);
        }
        if is_new {
            self.realtime_audio_order.push_back(key);
            while self.realtime_audio_order.len() > MAX_REALTIME_STREAM_RECORDS {
                if let Some(oldest) = self.realtime_audio_order.pop_front() {
                    self.realtime_audio.remove(&oldest);
                }
            }
        }
    }

    #[must_use]
    pub fn realtime_transcripts(&self) -> Vec<RealtimeTranscriptRecord> {
        self.realtime_transcripts_in_order()
    }

    fn realtime_transcripts_in_order(&self) -> Vec<RealtimeTranscriptRecord> {
        self.realtime_transcript_order
            .iter()
            .filter_map(|key| self.realtime_transcripts.get(key).cloned())
            .collect()
    }

    #[must_use]
    pub fn realtime_audio(&self) -> Vec<RealtimeAudioRecord> {
        self.realtime_audio_in_order()
    }

    fn realtime_audio_in_order(&self) -> Vec<RealtimeAudioRecord> {
        self.realtime_audio_order
            .iter()
            .filter_map(|key| self.realtime_audio.get(key).cloned())
            .collect()
    }

    pub fn upsert_turn_moderation(&mut self, moderation: TurnModerationRecord) {
        self.turn_moderation.insert(
            (moderation.thread_id.clone(), moderation.turn_id.clone()),
            moderation,
        );
    }

    pub fn upsert_auto_approval_review(&mut self, review: AutoApprovalReviewRecord) {
        self.auto_approval_reviews.insert(
            (
                review.thread_id.clone(),
                review.turn_id.clone(),
                review.item_id.clone(),
            ),
            review,
        );
    }

    pub fn upsert_approval_request(&mut self, request: NormalizedServerRequest) {
        let provider = request.provider.provider.clone();
        self.approvals.insert(
            (provider.clone(), request.request_id.clone()),
            ApprovalRecord {
                provider,
                request_id: request.request_id.clone(),
                request,
                status: ApprovalStatus::Pending,
                decision: None,
            },
        );
    }

    pub fn resolve_approval_request(
        &mut self,
        request_id: &str,
        decision: NormalizedServerRequestDecision,
        request: Option<NormalizedServerRequest>,
    ) {
        let key = request
            .as_ref()
            .map(|request| (request.provider.provider.clone(), request_id.to_string()))
            .or_else(|| {
                self.approvals
                    .keys()
                    .find(|(_, existing_request_id)| existing_request_id == request_id)
                    .cloned()
            });
        let Some(key) = key else {
            return;
        };
        if let Some(existing) = self.approvals.get_mut(&key) {
            existing.status = ApprovalStatus::Resolved;
            existing.decision = Some(decision);
            if let Some(request) = request {
                existing.request = request;
            }
        } else if let Some(request) = request {
            let provider = request.provider.provider.clone();
            self.approvals.insert(
                key,
                ApprovalRecord {
                    provider,
                    request_id: request_id.to_string(),
                    request,
                    status: ApprovalStatus::Resolved,
                    decision: Some(decision),
                },
            );
        }
    }

    #[must_use]
    pub fn approvals(&self) -> Vec<ApprovalRecord> {
        let mut approvals = self.approvals.values().cloned().collect::<Vec<_>>();
        approvals.sort_by(|left, right| {
            left.provider
                .cmp(&right.provider)
                .then_with(|| left.request_id.cmp(&right.request_id))
        });
        approvals
    }

    #[must_use]
    pub fn subagent_actions(&self) -> &[SubagentActionRecord] {
        &self.subagent_actions
    }

    #[must_use]
    pub fn turn_diffs(&self) -> Vec<TurnDiffRecord> {
        let mut diffs = self.turn_diffs.values().cloned().collect::<Vec<_>>();
        diffs.sort_by(|left, right| {
            left.thread_id
                .cmp(&right.thread_id)
                .then_with(|| left.turn_id.cmp(&right.turn_id))
        });
        diffs
    }

    #[must_use]
    pub fn terminal_outputs(&self) -> Vec<TerminalOutputRecord> {
        self.terminal_outputs_in_order()
    }

    fn terminal_outputs_in_order(&self) -> Vec<TerminalOutputRecord> {
        self.terminal_output_order
            .iter()
            .filter_map(|key| self.terminal_outputs.get(key).cloned())
            .collect()
    }

    pub fn append_terminal_output_from_tool(&mut self, tool: &SemanticToolCall) {
        let Some(delta) = terminal_output_delta_text(tool) else {
            return;
        };
        let provider = tool
            .provider
            .provider
            .clone()
            .unwrap_or_else(|| "unknown".to_string());
        let process_id = terminal_process_id(tool);
        let key = (
            provider.clone(),
            tool.provider.thread_id.clone(),
            tool.provider.turn_id.clone(),
            tool.provider.item_id.clone(),
            process_id.clone(),
        );
        let is_new = !self.terminal_outputs.contains_key(&key);
        let record =
            self.terminal_outputs
                .entry(key.clone())
                .or_insert_with(|| TerminalOutputRecord {
                    provider,
                    thread_id: tool.provider.thread_id.clone(),
                    turn_id: tool.provider.turn_id.clone(),
                    item_id: tool.provider.item_id.clone(),
                    process_id,
                    text: String::new(),
                    truncated_bytes: 0,
                });
        append_bounded_text(
            &mut record.text,
            &mut record.truncated_bytes,
            &delta,
            MAX_TERMINAL_OUTPUT_BYTES_PER_RECORD,
        );
        if is_new {
            self.terminal_output_order.push_back(key);
            while self.terminal_output_order.len() > MAX_TERMINAL_OUTPUT_RECORDS {
                if let Some(oldest) = self.terminal_output_order.pop_front() {
                    self.terminal_outputs.remove(&oldest);
                }
            }
        }
    }

    #[must_use]
    pub fn process_exits(&self) -> &[ProcessExitRecord] {
        &self.process_exits
    }

    #[must_use]
    pub fn warnings(&self) -> &[RuntimeWarningRecord] {
        &self.warnings
    }

    #[must_use]
    pub fn model_reroutes(&self) -> &[ModelRerouteRecord] {
        &self.model_reroutes
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

    pub fn apply_goal_update(&mut self, goal: GoalState) {
        match goal.status {
            GoalStatus::Paused if goal.objective.is_none() => self.pause_goal(&goal.thread_id),
            GoalStatus::Active if goal.objective.is_none() => self.resume_goal(&goal.thread_id),
            GoalStatus::Cleared => self.clear_goal(&goal.thread_id),
            _ => self.upsert_goal(goal),
        }
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
                    item_id: None,
                    status: PlanSessionStatus::Active,
                    text: None,
                    questions: None,
                    completion: None,
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

    fn upsert_plan_session_from_item(
        &mut self,
        thread_id: &str,
        item: &crate::provider::NormalizedThreadItem,
    ) {
        let plan = self
            .plan_sessions
            .entry(thread_id.to_string())
            .or_insert_with(|| PlanSession {
                thread_id: thread_id.to_string(),
                turn_id: item.turn_id.clone(),
                item_id: item.item_id.clone(),
                status: PlanSessionStatus::Active,
                text: None,
                questions: None,
                completion: None,
            });
        if plan.turn_id.is_none() {
            plan.turn_id = item.turn_id.clone();
        }
        if item.item_id.is_some() {
            plan.item_id = item.item_id.clone();
        }
        if item.text.is_some() {
            plan.text = item.text.clone();
        }
        if item.plan_questions.is_some() {
            plan.questions = item.plan_questions.clone();
        }
        if item.plan_completion.is_some() {
            plan.completion = item.plan_completion.clone();
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
                self.upsert_thread_item((**item).clone());
                if item.kind == crate::provider::ThreadItemKind::Plan
                    && let Some(thread_id) = item.thread_id.as_deref()
                {
                    self.upsert_plan_session_from_item(thread_id, item);
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
                    self.set_review_mode(thread_id, true);
                }
                if item.kind == crate::provider::ThreadItemKind::ExitedReviewMode
                    && let Some(thread_id) = item.thread_id.as_deref()
                {
                    self.set_review_mode(thread_id, false);
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
                self.apply_thread_lifecycle_signal(signal);
                if let Some(handoff) = handoff_from_signal(signal) {
                    self.record_handoff(handoff);
                }
                if let Some(implementation) = plan_implementation_from_signal(signal) {
                    self.record_plan_implementation(implementation);
                }
                if let Some(retry) = approval_retry_from_signal(signal) {
                    self.record_approval_retry(retry);
                }
                if let Some(goal) = goal_update_from_signal(signal) {
                    self.apply_goal_update(goal);
                }
                if let Some(fork) = fork_from_signal(signal) {
                    self.record_fork(fork);
                }
                if let Some(side_chat) = side_chat_from_signal(signal) {
                    self.record_side_chat(side_chat);
                }
                if let Some(diff) = turn_diff_from_signal(signal) {
                    self.upsert_turn_diff(diff);
                }
                if let Some(process) = process_exit_from_signal(signal) {
                    self.record_process_exit(process);
                }
                if let Some(warning) = warning_from_signal(signal) {
                    self.record_warning(warning);
                }
                if let Some(reroute) = model_reroute_from_signal(signal) {
                    self.record_model_reroute(reroute);
                }
                if let Some(provider_state) = provider_state_from_signal(signal) {
                    self.upsert_provider_state(provider_state);
                }
                if let Some(connection) = remote_connection_from_signal(signal) {
                    self.upsert_remote_connection(connection);
                }
                if let Some(session) = realtime_session_from_signal(signal) {
                    self.upsert_realtime_session(session);
                }
                if signal.kind == RuntimeSignalKind::RealtimeTranscriptDelta {
                    self.append_realtime_transcript(signal);
                }
                if signal.kind == RuntimeSignalKind::RealtimeAudioDelta {
                    self.append_realtime_audio(signal);
                }
                if let Some(moderation) = turn_moderation_from_signal(signal) {
                    self.upsert_turn_moderation(moderation);
                }
                if let Some(review) = auto_approval_review_from_signal(signal) {
                    self.upsert_auto_approval_review(review);
                }
                self.apply_thread_details_signal(signal);
                self.apply_turn_lifecycle_signal(signal);
                self.apply_review_mode_signal(signal);
            }
            ProviderEvent::ServerRequest { request } => {
                self.upsert_approval_request((**request).clone());
            }
            ProviderEvent::ServerRequestResolved {
                request_id,
                decision,
                request,
            } => {
                self.resolve_approval_request(
                    request_id,
                    decision.clone(),
                    request.as_deref().cloned(),
                );
            }
            ProviderEvent::SemanticTool { tool } => {
                self.append_terminal_output_from_tool(tool);
                self.upsert_tool_timeline((**tool).clone());
            }
            ProviderEvent::RawServerRequest { .. } | ProviderEvent::StderrLine { .. } => {}
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
        "start" | "started" => Some(ThreadLifecycleActionKind::Start),
        "resume" | "resumed" => Some(ThreadLifecycleActionKind::Resume),
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

fn thread_lifecycle_metadata(signal: &NormalizedRuntimeSignal) -> Value {
    let mut metadata = serde_json::Map::new();
    if let Some(status) = signal.status.clone() {
        metadata.insert("status".to_string(), Value::String(status));
    }
    if let Some(name) = signal.name.clone() {
        metadata.insert("name".to_string(), Value::String(name));
    }
    if let Some(active) = signal.active {
        metadata.insert("active".to_string(), Value::Bool(active));
    }
    if let Some(archived) = signal.archived {
        metadata.insert("archived".to_string(), Value::Bool(archived));
    }
    metadata.insert("lifecycle".to_string(), signal.metadata.clone());
    Value::Object(metadata)
}

fn thread_active_from_lifecycle_status(status: Option<&str>) -> Option<bool> {
    match status? {
        "started" | "resumed" => Some(true),
        "deleted" | "unsubscribed" => Some(false),
        _ => None,
    }
}

fn thread_archived_from_lifecycle_status(status: Option<&str>) -> Option<bool> {
    match status? {
        "archived" => Some(true),
        "unarchived" => Some(false),
        _ => None,
    }
}

fn merge_thread_metadata(target: &mut Value, update: Value) {
    if update.is_null() {
        return;
    }
    match (target, update) {
        (Value::Object(target), Value::Object(update)) => {
            for (key, value) in update {
                if !value.is_null() {
                    target.insert(key, value);
                }
            }
        }
        (target, update) => *target = update,
    }
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

fn approval_retry_from_signal(signal: &NormalizedRuntimeSignal) -> Option<ApprovalRetryRecord> {
    if signal.kind != RuntimeSignalKind::ApprovalRetryRecorded {
        return None;
    }
    let value = signal
        .metadata
        .get("approval_retry")
        .cloned()
        .unwrap_or_else(|| signal.metadata.clone());
    serde_json::from_value(value).ok()
}

fn goal_update_from_signal(signal: &NormalizedRuntimeSignal) -> Option<GoalState> {
    if signal.kind != RuntimeSignalKind::GoalUpdated {
        return None;
    }
    let value = signal
        .metadata
        .get("goal")
        .cloned()
        .unwrap_or_else(|| signal.metadata.clone());
    serde_json::from_value(value).ok()
}

fn fork_from_signal(signal: &NormalizedRuntimeSignal) -> Option<ForkPoint> {
    if signal.kind != RuntimeSignalKind::ForkUpdated {
        return None;
    }
    let value = signal
        .metadata
        .get("fork")
        .cloned()
        .unwrap_or_else(|| signal.metadata.clone());
    serde_json::from_value(value).ok()
}

fn side_chat_from_signal(signal: &NormalizedRuntimeSignal) -> Option<SideChat> {
    if signal.kind != RuntimeSignalKind::SideChatUpdated {
        return None;
    }
    let value = signal
        .metadata
        .get("side_chat")
        .cloned()
        .or_else(|| signal.metadata.get("sideChat").cloned())
        .unwrap_or_else(|| signal.metadata.clone());
    serde_json::from_value(value).ok()
}

fn turn_diff_from_signal(signal: &NormalizedRuntimeSignal) -> Option<TurnDiffRecord> {
    if signal.kind != RuntimeSignalKind::TurnDiffUpdated {
        return None;
    }
    Some(TurnDiffRecord {
        thread_id: signal.thread_id.clone()?,
        turn_id: signal.turn_id.clone(),
        diff: signal.diff.clone(),
        files: signal.files.clone().unwrap_or(Value::Null),
        metadata: signal.metadata.clone(),
    })
}

fn process_exit_from_signal(signal: &NormalizedRuntimeSignal) -> Option<ProcessExitRecord> {
    if signal.kind != RuntimeSignalKind::ProcessExited {
        return None;
    }
    Some(ProcessExitRecord {
        thread_id: signal.thread_id.clone(),
        turn_id: signal.turn_id.clone(),
        process_id: signal.process_id.clone(),
        exit_code: signal.exit_code,
        metadata: signal.metadata.clone(),
    })
}

fn warning_from_signal(signal: &NormalizedRuntimeSignal) -> Option<RuntimeWarningRecord> {
    if signal.kind != RuntimeSignalKind::Warning {
        return None;
    }
    Some(RuntimeWarningRecord {
        provider: signal.provider.provider.clone(),
        thread_id: signal.thread_id.clone(),
        turn_id: signal.turn_id.clone(),
        message: signal.message.clone()?,
        metadata: signal.metadata.clone(),
    })
}

fn model_reroute_from_signal(signal: &NormalizedRuntimeSignal) -> Option<ModelRerouteRecord> {
    if signal.kind != RuntimeSignalKind::ModelRerouted {
        return None;
    }
    Some(ModelRerouteRecord {
        provider: signal.provider.provider.clone(),
        thread_id: signal.thread_id.clone(),
        turn_id: signal.turn_id.clone(),
        from_model: signal.from_model.clone(),
        to_model: signal.to_model.clone(),
        reason: signal.reason.clone(),
    })
}

fn provider_state_from_signal(signal: &NormalizedRuntimeSignal) -> Option<ProviderStateRecord> {
    if signal.kind != RuntimeSignalKind::ProviderStateUpdated {
        return None;
    }
    Some(ProviderStateRecord {
        provider: signal.provider.provider.clone(),
        status: signal
            .status
            .clone()
            .unwrap_or_else(|| "provider_state_updated".to_string()),
        message: signal.message.clone(),
        name: signal.name.clone(),
        metadata: signal.metadata.clone(),
    })
}

fn remote_connection_from_signal(
    signal: &NormalizedRuntimeSignal,
) -> Option<RemoteConnectionRecord> {
    if signal.kind != RuntimeSignalKind::ProviderStateUpdated
        || signal.provider.method.as_deref() != Some("remoteControl/status/changed")
    {
        return None;
    }

    let payload = &signal.provider.raw_payload;
    let host = string_field_any(
        payload,
        &["host", "hostname", "hostName", "sshHost", "alias"],
    );
    let display_name = signal
        .name
        .clone()
        .or_else(|| string_field_any(payload, &["displayName", "display_name", "name", "title"]));
    let host_id = string_field_any(
        payload,
        &["id", "hostId", "host_id", "connectionId", "deviceId"],
    )
    .or_else(|| host.clone())
    .or_else(|| display_name.clone())
    .unwrap_or_else(|| "remote_control".to_string());

    Some(RemoteConnectionRecord {
        provider: signal.provider.provider.clone(),
        host_id,
        host,
        display_name,
        status: signal.status.clone(),
        execution_location: execution_location_from_remote_signal(payload),
        projects: payload
            .get("projects")
            .or_else(|| payload.get("savedProjects"))
            .or_else(|| payload.get("saved_projects"))
            .or_else(|| payload.get("repositories"))
            .cloned()
            .unwrap_or(Value::Null),
        metadata: signal.metadata.clone(),
    })
}

fn execution_location_from_remote_signal(value: &Value) -> ExecutionLocation {
    match string_field_any(
        value,
        &[
            "executionLocation",
            "execution_location",
            "location",
            "kind",
            "type",
        ],
    )
    .as_deref()
    {
        Some("local") | Some("this_computer") | Some("this-computer") => ExecutionLocation::Local,
        Some("cloud") => ExecutionLocation::Cloud,
        _ => ExecutionLocation::RemoteHost,
    }
}

fn string_field_any(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| string_field(value, key))
}

fn realtime_session_from_signal(signal: &NormalizedRuntimeSignal) -> Option<RealtimeSessionRecord> {
    if signal.kind != RuntimeSignalKind::RealtimeSessionUpdated {
        return None;
    }
    Some(RealtimeSessionRecord {
        provider: signal.provider.provider.clone(),
        thread_id: signal.thread_id.clone(),
        turn_id: signal.turn_id.clone(),
        status: signal
            .status
            .clone()
            .unwrap_or_else(|| "realtime_session_updated".to_string()),
        message: signal.message.clone(),
        metadata: signal.metadata.clone(),
    })
}

fn turn_moderation_from_signal(signal: &NormalizedRuntimeSignal) -> Option<TurnModerationRecord> {
    if signal.kind != RuntimeSignalKind::TurnModerationUpdated {
        return None;
    }
    Some(TurnModerationRecord {
        provider: signal.provider.provider.clone(),
        thread_id: signal.thread_id.clone(),
        turn_id: signal.turn_id.clone(),
        status: signal
            .status
            .clone()
            .unwrap_or_else(|| "moderation_metadata_updated".to_string()),
        metadata: signal.metadata.clone(),
    })
}

fn auto_approval_review_from_signal(
    signal: &NormalizedRuntimeSignal,
) -> Option<AutoApprovalReviewRecord> {
    if signal.kind != RuntimeSignalKind::AutoApprovalReviewUpdated {
        return None;
    }
    Some(AutoApprovalReviewRecord {
        provider: signal.provider.provider.clone(),
        thread_id: signal.thread_id.clone(),
        turn_id: signal.turn_id.clone(),
        item_id: signal.item_id.clone(),
        status: signal
            .status
            .clone()
            .unwrap_or_else(|| "auto_approval_review_updated".to_string()),
        message: signal.message.clone(),
        metadata: signal.metadata.clone(),
    })
}

impl AgentRuntimeState {
    fn apply_thread_lifecycle_signal(&mut self, signal: &NormalizedRuntimeSignal) {
        if signal.kind != RuntimeSignalKind::ThreadLifecycleChanged {
            return;
        }
        let Some(thread_id) = signal.thread_id.as_deref() else {
            return;
        };
        let provider = signal.provider.provider.clone();
        let metadata = thread_lifecycle_metadata(signal);
        let thread = self.ensure_thread(thread_id.to_string(), provider);
        if let Some(name) = signal
            .name
            .clone()
            .or_else(|| string_field(&metadata, "name"))
        {
            thread.name = Some(name);
        }
        if signal.active.is_some() {
            thread.active = signal.active;
        } else if let Some(active) = thread_active_from_lifecycle_status(signal.status.as_deref()) {
            thread.active = Some(active);
        }
        if signal.archived.is_some() {
            thread.archived = signal.archived;
        } else if let Some(archived) =
            thread_archived_from_lifecycle_status(signal.status.as_deref())
        {
            thread.archived = Some(archived);
        }
        merge_thread_metadata(&mut thread.metadata, metadata);
    }

    fn apply_thread_details_signal(&mut self, signal: &NormalizedRuntimeSignal) {
        let Some(thread_id) = signal.thread_id.as_deref() else {
            return;
        };
        match signal.kind {
            RuntimeSignalKind::ThreadSettingsUpdated => {
                self.update_thread_settings(
                    thread_id,
                    signal.provider.provider.clone(),
                    thread_settings_from_signal(signal),
                );
            }
            RuntimeSignalKind::ThreadTokenUsageUpdated => {
                self.update_thread_token_usage(
                    thread_id,
                    signal.provider.provider.clone(),
                    thread_token_usage_from_signal(signal),
                );
            }
            _ => {}
        }
    }

    fn apply_turn_lifecycle_signal(&mut self, signal: &NormalizedRuntimeSignal) {
        if signal.kind != RuntimeSignalKind::TurnLifecycleChanged {
            return;
        }
        let Some(thread_id) = signal.thread_id.as_deref() else {
            return;
        };
        let action = signal.status.as_deref().unwrap_or("updated");
        match action {
            "started" | "started_streaming" => {
                let mode = signal
                    .metadata
                    .get("mode")
                    .and_then(Value::as_str)
                    .map(turn_mode_from_key)
                    .unwrap_or(TurnMode::Normal);
                let _ = self.begin_turn(thread_id.to_string(), signal.turn_id.clone(), mode);
            }
            "completed" => self.finish_active_turn(thread_id, PlanSessionStatus::Completed),
            "failed" | "interrupted" | "cancelled" => {
                self.finish_active_turn(thread_id, PlanSessionStatus::Rejected);
            }
            _ => {}
        }
    }
}

fn thread_settings_from_signal(signal: &NormalizedRuntimeSignal) -> Value {
    signal
        .metadata
        .get("settings")
        .cloned()
        .unwrap_or_else(|| signal.metadata.clone())
}

fn thread_token_usage_from_signal(signal: &NormalizedRuntimeSignal) -> Value {
    signal
        .metadata
        .get("tokenUsage")
        .or_else(|| signal.metadata.get("token_usage"))
        .cloned()
        .unwrap_or_else(|| signal.metadata.clone())
}

fn turn_mode_from_key(mode: &str) -> TurnMode {
    match mode {
        "plan" => TurnMode::Plan,
        _ => TurnMode::Normal,
    }
}

impl AgentRuntimeState {
    fn apply_review_mode_signal(&mut self, signal: &NormalizedRuntimeSignal) {
        if signal.kind != RuntimeSignalKind::ReviewModeUpdated {
            return;
        }
        let Some(thread_id) = signal.thread_id.as_deref() else {
            return;
        };
        let active = signal
            .active
            .or_else(|| signal.status.as_deref().and_then(review_active_from_status));
        if let Some(active) = active {
            self.set_review_mode(thread_id, active);
        }
    }
}

fn review_active_from_status(status: &str) -> Option<bool> {
    match status {
        "entered" | "started" | "active" => Some(true),
        "exited" | "completed" | "inactive" => Some(false),
        _ => None,
    }
}

fn insert_child_thread(
    records: &mut HashMap<ChildThreadKey, ChildThreadRecord>,
    record: ChildThreadRecord,
) {
    records.insert(
        (
            record.provider.clone(),
            record.parent_thread_id.clone(),
            record.thread_id.clone(),
            record.relationship,
        ),
        record,
    );
}

fn provider_for_thread(
    state: &AgentRuntimeState,
    parent_thread_id: &str,
    thread_id: &str,
) -> String {
    state
        .threads
        .get(thread_id)
        .or_else(|| state.threads.get(parent_thread_id))
        .map(|thread| thread.provider.clone())
        .unwrap_or_else(|| "codex".to_string())
}

fn relationship_key(relationship: ChildThreadRelationship) -> &'static str {
    match relationship {
        ChildThreadRelationship::Fork => "fork",
        ChildThreadRelationship::SideChat => "side_chat",
        ChildThreadRelationship::Subagent => "subagent",
        ChildThreadRelationship::Handoff => "handoff",
        ChildThreadRelationship::Review => "review",
    }
}

fn handoff_status_key(status: HandoffStatus) -> &'static str {
    match status {
        HandoffStatus::Requested => "requested",
        HandoffStatus::Interrupted => "interrupted",
        HandoffStatus::Transferring => "transferring",
        HandoffStatus::Completed => "completed",
        HandoffStatus::Failed => "failed",
    }
}

fn thread_item_status_key(status: ThreadItemStatus) -> &'static str {
    match status {
        ThreadItemStatus::Started => "started",
        ThreadItemStatus::Updated => "updated",
        ThreadItemStatus::Completed => "completed",
        ThreadItemStatus::Failed => "failed",
    }
}

fn tool_action_key(tool: &SemanticToolCall) -> String {
    format!("{:?}", tool.action)
}

fn terminal_output_delta_text(tool: &SemanticToolCall) -> Option<String> {
    if tool.surface != crate::tools::ToolSurface::Terminal
        || tool.action != crate::tools::ToolActionKind::TerminalOutput
    {
        return None;
    }
    string_value_at_any(
        &tool.provider.raw_args,
        &["delta", "text", "output", "stdout", "stderr", "chunk"],
    )
    .or_else(|| {
        string_value_at_any(
            &tool.provider.raw_payload,
            &["delta", "text", "output", "stdout", "stderr", "chunk"],
        )
    })
    .or_else(|| {
        tool.provider.raw_payload.get("item").and_then(|item| {
            string_value_at_any(
                item,
                &["delta", "text", "output", "stdout", "stderr", "chunk"],
            )
        })
    })
    .filter(|text| !text.is_empty())
}

fn terminal_process_id(tool: &SemanticToolCall) -> Option<String> {
    string_value_at_any(
        &tool.provider.raw_args,
        &["processId", "process_id", "terminalId", "terminal_id"],
    )
    .or_else(|| {
        string_value_at_any(
            &tool.provider.raw_payload,
            &["processId", "process_id", "terminalId", "terminal_id"],
        )
    })
    .or_else(|| {
        tool.provider.raw_payload.get("item").and_then(|item| {
            string_value_at_any(
                item,
                &["processId", "process_id", "terminalId", "terminal_id"],
            )
        })
    })
}

fn string_value_at_any(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value.get(*key).and_then(|value| match value {
            Value::String(text) => Some(text.clone()),
            Value::Number(number) => Some(number.to_string()),
            _ => None,
        })
    })
}

fn append_bounded_text(
    current: &mut String,
    truncated_bytes: &mut usize,
    delta: &str,
    max_bytes: usize,
) {
    current.push_str(delta);
    while current.len() > max_bytes {
        let Some(first_char) = current.chars().next() else {
            break;
        };
        let removed = first_char.len_utf8();
        current.drain(..removed);
        *truncated_bytes = truncated_bytes.saturating_add(removed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{
        NormalizedRuntimeSignal, NormalizedServerRequest, NormalizedServerRequestDecision,
        NormalizedThreadItem, ProviderMetadata, ServerRequestKind, ThreadItemKind,
        ThreadItemStatus,
    };
    use crate::tools::{
        ProviderToolMetadata, ToolActionKind, ToolDisplay, ToolRunStatus, ToolSurface, ToolTarget,
        ToolTargetKind, ToolTransport,
    };
    use serde_json::json;

    fn runtime_signal(kind: RuntimeSignalKind, method: &str) -> NormalizedRuntimeSignal {
        NormalizedRuntimeSignal {
            kind,
            thread_id: None,
            turn_id: None,
            item_id: None,
            message: None,
            from_model: None,
            to_model: None,
            reason: None,
            text: None,
            audio: None,
            status: None,
            name: None,
            active: None,
            archived: None,
            diff: None,
            files: None,
            process_id: None,
            exit_code: None,
            request_id: None,
            metadata: json!({}),
            provider: ProviderMetadata {
                provider: "codex".to_string(),
                method: Some(method.to_string()),
                schema_version: None,
                raw_payload: json!({}),
            },
        }
    }

    fn thread_item(
        kind: ThreadItemKind,
        thread_id: &str,
        turn_id: Option<&str>,
        item_id: Option<&str>,
        text: Option<&str>,
    ) -> NormalizedThreadItem {
        NormalizedThreadItem {
            kind,
            status: ThreadItemStatus::Updated,
            thread_id: Some(thread_id.to_string()),
            turn_id: turn_id.map(ToString::to_string),
            item_id: item_id.map(ToString::to_string),
            parent_thread_id: None,
            child_thread_id: None,
            sender: None,
            role: None,
            title: None,
            text: text.map(ToString::to_string),
            status_text: None,
            model: None,
            target: None,
            url: None,
            files: None,
            attachments: None,
            diff: None,
            token_usage: None,
            plan_questions: None,
            plan_completion: None,
            metadata: json!({}),
            provider: ProviderMetadata {
                provider: "codex".to_string(),
                method: Some("item/agentMessage/delta".to_string()),
                schema_version: Some("test-v1".to_string()),
                raw_payload: json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "itemId": item_id,
                    "text": text
                }),
            },
        }
    }

    fn server_request(request_id: &str) -> NormalizedServerRequest {
        NormalizedServerRequest {
            kind: ServerRequestKind::CommandApproval,
            request_id: request_id.to_string(),
            method: "command/approvalRequest".to_string(),
            thread_id: Some("thread-1".to_string()),
            turn_id: Some("turn-1".to_string()),
            item_id: Some("cmd-1".to_string()),
            scope: Some("command".to_string()),
            title: Some("Approve command".to_string()),
            prompt: Some("Run cargo test?".to_string()),
            selected_policy: Some("on-request".to_string()),
            metadata: json!({ "command": "cargo test" }),
            provider: ProviderMetadata {
                provider: "codex".to_string(),
                method: Some("command/approvalRequest".to_string()),
                schema_version: Some("test-v1".to_string()),
                raw_payload: json!({ "command": "cargo test" }),
            },
        }
    }

    fn semantic_tool(
        item_id: Option<&str>,
        status: ToolRunStatus,
        title: &str,
    ) -> SemanticToolCall {
        SemanticToolCall {
            transport: ToolTransport::Shell,
            surface: ToolSurface::Terminal,
            action: ToolActionKind::TerminalRun,
            display: ToolDisplay {
                title: title.to_string(),
                summary: Some("cargo test".to_string()),
                target: Some(ToolTarget {
                    kind: ToolTargetKind::Command,
                    label: "cargo test".to_string(),
                }),
                status,
                icon_key: "terminal".to_string(),
                technical_metadata: json!({ "bounded": true }),
            },
            provider: ProviderToolMetadata {
                provider: Some("codex".to_string()),
                method: Some("command/exec".to_string()),
                item_id: item_id.map(ToString::to_string),
                turn_id: Some("turn-1".to_string()),
                thread_id: Some("thread-1".to_string()),
                server_name: None,
                tool_name: Some("shell".to_string()),
                operation: Some("exec".to_string()),
                raw_args: json!({ "command": "cargo test" }),
                raw_result: Value::Null,
                raw_payload: json!({ "itemId": item_id, "command": "cargo test" }),
            },
        }
    }

    fn terminal_output_tool(
        item_id: Option<&str>,
        process_id: &str,
        delta: &str,
    ) -> SemanticToolCall {
        let mut tool = semantic_tool(item_id, ToolRunStatus::Updated, "Read terminal output");
        tool.action = ToolActionKind::TerminalOutput;
        tool.display.status = ToolRunStatus::Updated;
        tool.provider.operation = Some("process/outputDelta".to_string());
        tool.provider.raw_args = json!({ "processId": process_id, "delta": delta });
        tool.provider.raw_payload = json!({
            "item": {
                "id": item_id,
                "processId": process_id,
                "delta": delta
            }
        });
        tool
    }

    fn realtime_signal(kind: RuntimeSignalKind, turn_id: &str, payload: &str) -> ProviderEvent {
        let mut signal = runtime_signal(
            kind,
            match kind {
                RuntimeSignalKind::RealtimeTranscriptDelta => "realtime/transcriptDelta",
                RuntimeSignalKind::RealtimeAudioDelta => "realtime/audioDelta",
                _ => "realtime/unknown",
            },
        );
        signal.thread_id = Some("thread-1".to_string());
        signal.turn_id = Some(turn_id.to_string());
        match kind {
            RuntimeSignalKind::RealtimeTranscriptDelta => {
                signal.text = Some(payload.to_string());
            }
            RuntimeSignalKind::RealtimeAudioDelta => {
                signal.audio = Some(payload.to_string());
            }
            _ => {}
        }
        ProviderEvent::RuntimeSignal {
            signal: Box::new(signal),
        }
    }

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
                status_text: None,
                model: None,
                target: None,
                url: None,
                files: None,
                attachments: None,
                diff: None,
                token_usage: None,
                plan_questions: Some(json!([
                    {
                        "id": "repo",
                        "question": "Which repository?"
                    }
                ])),
                plan_completion: Some("complete".to_string()),
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
        assert_eq!(session.item_id.as_deref(), Some("plan-1"));
        assert_eq!(session.status, PlanSessionStatus::Active);
        assert_eq!(session.text.as_deref(), Some("Plan"));
        assert_eq!(
            session.questions.as_ref().expect("questions")[0]["question"],
            "Which repository?"
        );
        assert_eq!(session.completion.as_deref(), Some("complete"));

        let snapshot = state.snapshot();
        assert_eq!(snapshot.plan_sessions[0].item_id.as_deref(), Some("plan-1"));
        assert_eq!(
            snapshot.plan_sessions[0]
                .questions
                .as_ref()
                .expect("questions")[0]["id"],
            "repo"
        );
    }

    #[test]
    fn records_normalized_thread_items_with_bounded_upserts() {
        let mut state = AgentRuntimeState::default();
        state.apply_provider_events(&[
            ProviderEvent::ThreadItem {
                item: Box::new(thread_item(
                    ThreadItemKind::AgentMessage,
                    "thread-1",
                    Some("turn-1"),
                    Some("item-1"),
                    Some("draft"),
                )),
            },
            ProviderEvent::ThreadItem {
                item: Box::new(thread_item(
                    ThreadItemKind::AgentMessage,
                    "thread-1",
                    Some("turn-1"),
                    Some("item-1"),
                    Some("final"),
                )),
            },
            ProviderEvent::ThreadItem {
                item: Box::new(thread_item(
                    ThreadItemKind::Reasoning,
                    "thread-1",
                    Some("turn-1"),
                    Some("item-2"),
                    Some("reasoning"),
                )),
            },
        ]);

        let items = state.thread_items();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].item_id.as_deref(), Some("item-1"));
        assert_eq!(items[0].text.as_deref(), Some("final"));
        assert_eq!(items[0].provider.schema_version.as_deref(), Some("test-v1"));
        assert_eq!(items[0].provider.raw_payload["text"], "final");
        assert_eq!(items[1].item_id.as_deref(), Some("item-2"));
        assert!(state.thread("thread-1").is_none());

        let snapshot = state.snapshot();
        assert_eq!(snapshot.thread_items, items);

        for index in 0..=MAX_THREAD_ITEM_RECORDS {
            state.apply_provider_events(&[ProviderEvent::ThreadItem {
                item: Box::new(thread_item(
                    ThreadItemKind::Reasoning,
                    "thread-1",
                    Some("turn-1"),
                    None,
                    Some(&format!("generated-{index}")),
                )),
            }]);
        }

        let snapshot = state.snapshot();
        assert_eq!(snapshot.thread_items.len(), MAX_THREAD_ITEM_RECORDS);
        assert!(
            snapshot
                .thread_items
                .iter()
                .all(|item| item.item_id.as_deref() != Some("item-1"))
        );
        assert!(
            snapshot
                .thread_items
                .iter()
                .all(|item| item.text.as_deref() != Some("generated-0"))
        );
        let newest_generated = format!("generated-{MAX_THREAD_ITEM_RECORDS}");
        assert!(
            snapshot
                .thread_items
                .iter()
                .any(|item| item.text.as_deref() == Some(newest_generated.as_str()))
        );
    }

    #[test]
    fn records_pending_and_resolved_approval_requests() {
        let mut state = AgentRuntimeState::default();
        let request = server_request("approval-1");
        state.apply_provider_events(&[ProviderEvent::ServerRequest {
            request: Box::new(request.clone()),
        }]);

        let approvals = state.approvals();
        assert_eq!(approvals.len(), 1);
        assert_eq!(approvals[0].provider, "codex");
        assert_eq!(approvals[0].request_id, "approval-1");
        assert_eq!(
            approvals[0].request.prompt.as_deref(),
            Some("Run cargo test?")
        );
        assert_eq!(approvals[0].status, ApprovalStatus::Pending);
        assert!(approvals[0].decision.is_none());

        state.apply_provider_events(&[ProviderEvent::ServerRequestResolved {
            request_id: "approval-1".to_string(),
            decision: NormalizedServerRequestDecision {
                outcome: "result".to_string(),
                payload: json!({ "approved": true }),
                audit: json!({
                    "source_thread_id": "thread-1",
                    "selected_policy": "on-request"
                }),
            },
            request: None,
        }]);

        let snapshot = state.snapshot();
        assert_eq!(snapshot.approvals.len(), 1);
        assert_eq!(snapshot.approvals[0].status, ApprovalStatus::Resolved);
        let decision = snapshot.approvals[0].decision.as_ref().expect("decision");
        assert_eq!(decision.outcome, "result");
        assert_eq!(decision.payload["approved"], true);
        assert_eq!(decision.audit["source_thread_id"], "thread-1");
        assert_eq!(decision.audit["selected_policy"], "on-request");
    }

    #[test]
    fn records_semantic_tool_timeline_with_bounded_upserts() {
        let mut state = AgentRuntimeState::default();
        state.apply_provider_events(&[
            ProviderEvent::SemanticTool {
                tool: Box::new(semantic_tool(
                    Some("tool-1"),
                    ToolRunStatus::Started,
                    "Ran cargo test",
                )),
            },
            ProviderEvent::SemanticTool {
                tool: Box::new(semantic_tool(
                    Some("tool-1"),
                    ToolRunStatus::Completed,
                    "Completed cargo test",
                )),
            },
        ]);

        let timeline = state.tool_timeline();
        assert_eq!(timeline.len(), 1);
        assert_eq!(timeline[0].provider.item_id.as_deref(), Some("tool-1"));
        assert_eq!(timeline[0].display.status, ToolRunStatus::Completed);
        assert_eq!(timeline[0].display.title, "Completed cargo test");
        assert_eq!(timeline[0].provider.raw_args["command"], "cargo test");

        let snapshot = state.snapshot();
        assert_eq!(snapshot.tool_timeline, timeline);

        for index in 0..=MAX_TOOL_TIMELINE_RECORDS {
            let mut tool = semantic_tool(None, ToolRunStatus::Started, &format!("Tool {index}"));
            tool.provider.method = None;
            tool.provider.tool_name = None;
            tool.provider.operation = None;
            tool.provider.raw_payload = json!({ "index": index });
            state.apply_provider_events(&[ProviderEvent::SemanticTool {
                tool: Box::new(tool),
            }]);
        }

        let snapshot = state.snapshot();
        assert_eq!(snapshot.tool_timeline.len(), MAX_TOOL_TIMELINE_RECORDS);
        assert!(
            snapshot
                .tool_timeline
                .iter()
                .all(|tool| tool.provider.item_id.as_deref() != Some("tool-1"))
        );
        assert!(
            snapshot
                .tool_timeline
                .iter()
                .all(|tool| tool.display.title != "Tool 0")
        );
        assert!(
            snapshot
                .tool_timeline
                .iter()
                .any(|tool| tool.display.title == format!("Tool {MAX_TOOL_TIMELINE_RECORDS}"))
        );
    }

    #[test]
    fn records_bounded_terminal_output_from_semantic_tool_deltas() {
        let mut state = AgentRuntimeState::default();
        state.apply_provider_events(&[
            ProviderEvent::SemanticTool {
                tool: Box::new(terminal_output_tool(
                    Some("cmd-1"),
                    "proc-1",
                    "running tests\n",
                )),
            },
            ProviderEvent::SemanticTool {
                tool: Box::new(terminal_output_tool(Some("cmd-1"), "proc-1", "ok\n")),
            },
        ]);

        let outputs = state.terminal_outputs();
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0].provider, "codex");
        assert_eq!(outputs[0].thread_id.as_deref(), Some("thread-1"));
        assert_eq!(outputs[0].turn_id.as_deref(), Some("turn-1"));
        assert_eq!(outputs[0].item_id.as_deref(), Some("cmd-1"));
        assert_eq!(outputs[0].process_id.as_deref(), Some("proc-1"));
        assert_eq!(outputs[0].text, "running tests\nok\n");
        assert_eq!(outputs[0].truncated_bytes, 0);

        let long_delta = "x".repeat(MAX_TERMINAL_OUTPUT_BYTES_PER_RECORD + 8);
        state.apply_provider_events(&[ProviderEvent::SemanticTool {
            tool: Box::new(terminal_output_tool(Some("cmd-1"), "proc-1", &long_delta)),
        }]);
        let outputs = state.terminal_outputs();
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0].text.len(), MAX_TERMINAL_OUTPUT_BYTES_PER_RECORD);
        assert!(outputs[0].truncated_bytes >= 8);
        assert!(outputs[0].text.chars().all(|ch| ch == 'x'));

        for index in 0..=MAX_TERMINAL_OUTPUT_RECORDS {
            state.apply_provider_events(&[ProviderEvent::SemanticTool {
                tool: Box::new(terminal_output_tool(
                    Some(&format!("cmd-{index}")),
                    &format!("proc-{index}"),
                    "line\n",
                )),
            }]);
        }
        let snapshot = state.snapshot();
        assert_eq!(snapshot.terminal_outputs.len(), MAX_TERMINAL_OUTPUT_RECORDS);
        assert!(
            snapshot
                .terminal_outputs
                .iter()
                .all(|output| output.item_id.as_deref() != Some("cmd-1"))
        );
        let newest_item_id = format!("cmd-{MAX_TERMINAL_OUTPUT_RECORDS}");
        assert!(
            snapshot
                .terminal_outputs
                .iter()
                .any(|output| output.item_id.as_deref() == Some(newest_item_id.as_str()))
        );
    }

    #[test]
    fn records_bounded_realtime_transcript_and_audio() {
        let mut state = AgentRuntimeState::default();
        state.apply_provider_events(&[
            realtime_signal(
                RuntimeSignalKind::RealtimeTranscriptDelta,
                "turn-1",
                "hello ",
            ),
            realtime_signal(
                RuntimeSignalKind::RealtimeTranscriptDelta,
                "turn-1",
                "world",
            ),
            realtime_signal(RuntimeSignalKind::RealtimeAudioDelta, "turn-1", "audio-1"),
            realtime_signal(RuntimeSignalKind::RealtimeAudioDelta, "turn-1", "audio-2"),
        ]);

        let transcripts = state.realtime_transcripts();
        assert_eq!(transcripts.len(), 1);
        assert_eq!(transcripts[0].provider, "codex");
        assert_eq!(transcripts[0].thread_id.as_deref(), Some("thread-1"));
        assert_eq!(transcripts[0].turn_id.as_deref(), Some("turn-1"));
        assert_eq!(transcripts[0].text, "hello world");
        assert_eq!(transcripts[0].truncated_bytes, 0);

        let audio = state.realtime_audio();
        assert_eq!(audio.len(), 1);
        assert_eq!(
            audio[0].chunks,
            vec!["audio-1".to_string(), "audio-2".to_string()]
        );
        assert_eq!(audio[0].truncated_chunks, 0);

        let long_delta = "x".repeat(MAX_REALTIME_TRANSCRIPT_BYTES_PER_RECORD + 16);
        state.apply_provider_events(&[realtime_signal(
            RuntimeSignalKind::RealtimeTranscriptDelta,
            "turn-1",
            &long_delta,
        )]);
        let transcripts = state.realtime_transcripts();
        assert_eq!(
            transcripts[0].text.len(),
            MAX_REALTIME_TRANSCRIPT_BYTES_PER_RECORD
        );
        assert!(transcripts[0].truncated_bytes >= 16);

        for index in 0..=MAX_REALTIME_AUDIO_CHUNKS_PER_RECORD {
            state.apply_provider_events(&[realtime_signal(
                RuntimeSignalKind::RealtimeAudioDelta,
                "turn-1",
                &format!("audio-{index}"),
            )]);
        }
        let audio = state.realtime_audio();
        assert_eq!(audio[0].chunks.len(), MAX_REALTIME_AUDIO_CHUNKS_PER_RECORD);
        assert!(audio[0].truncated_chunks > 0);
        let newest_audio = format!("audio-{MAX_REALTIME_AUDIO_CHUNKS_PER_RECORD}");
        assert!(audio[0].chunks.contains(&newest_audio));

        for index in 0..=MAX_REALTIME_STREAM_RECORDS {
            state.apply_provider_events(&[realtime_signal(
                RuntimeSignalKind::RealtimeTranscriptDelta,
                &format!("turn-stream-{index}"),
                "delta",
            )]);
        }
        let snapshot = state.snapshot();
        assert_eq!(
            snapshot.realtime_transcripts.len(),
            MAX_REALTIME_STREAM_RECORDS
        );
        assert!(
            snapshot
                .realtime_transcripts
                .iter()
                .all(|record| record.turn_id.as_deref() != Some("turn-1"))
        );
        let newest_turn = format!("turn-stream-{MAX_REALTIME_STREAM_RECORDS}");
        assert!(
            snapshot
                .realtime_transcripts
                .iter()
                .any(|record| record.turn_id.as_deref() == Some(newest_turn.as_str()))
        );
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
    fn applies_goal_update_runtime_signals() {
        let mut state = AgentRuntimeState::default();
        state.apply_provider_events(&[
            ProviderEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::GoalUpdated,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: None,
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: Some("finish adapter".to_string()),
                    audio: None,
                    status: Some("active".to_string()),
                    name: None,
                    active: None,
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({
                        "goal": {
                            "thread_id": "thread-1",
                            "status": "active",
                            "objective": "finish adapter",
                            "token_budget": 12000
                        }
                    }),
                    provider: ProviderMetadata {
                        provider: "codex".to_string(),
                        method: Some("ace/goal/set".to_string()),
                        schema_version: None,
                        raw_payload: json!({}),
                    },
                }),
            },
            ProviderEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::GoalUpdated,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: None,
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: Some("paused".to_string()),
                    name: None,
                    active: None,
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({
                        "goal": {
                            "thread_id": "thread-1",
                            "status": "paused"
                        }
                    }),
                    provider: ProviderMetadata {
                        provider: "codex".to_string(),
                        method: Some("ace/goal/pause".to_string()),
                        schema_version: None,
                        raw_payload: json!({}),
                    },
                }),
            },
            ProviderEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::GoalUpdated,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: None,
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: Some("cleared".to_string()),
                    name: None,
                    active: None,
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({
                        "goal": {
                            "thread_id": "thread-1",
                            "status": "cleared"
                        }
                    }),
                    provider: ProviderMetadata {
                        provider: "codex".to_string(),
                        method: Some("ace/goal/clear".to_string()),
                        schema_version: None,
                        raw_payload: json!({}),
                    },
                }),
            },
        ]);

        let goal = state.goal("thread-1").expect("goal");
        assert_eq!(goal.status, GoalStatus::Cleared);
        assert_eq!(goal.objective.as_deref(), Some("finish adapter"));
        assert_eq!(goal.token_budget, Some(12000));
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
                status_text: None,
                model: None,
                target: None,
                url: None,
                files: None,
                attachments: None,
                diff: None,
                token_usage: None,
                plan_questions: None,
                plan_completion: None,
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
                    status: Some("started".to_string()),
                    name: None,
                    active: Some(true),
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({
                        "action": "start",
                        "request": { "cwd": "/repo" },
                        "provider_response": { "thread": { "id": "thread-1" } }
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
                    status: Some("resumed".to_string()),
                    name: None,
                    active: Some(true),
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({
                        "action": "resume",
                        "provider_response": { "thread": { "id": "thread-1" } }
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
                    status: Some("archived".to_string()),
                    name: None,
                    active: None,
                    archived: Some(true),
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({
                        "action": "archive",
                        "provider_response": { "archived": true }
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
                    status: Some("unarchived".to_string()),
                    name: None,
                    active: None,
                    archived: Some(false),
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({
                        "action": "unarchive",
                        "provider_response": { "archived": false }
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
                    status: Some("deleted".to_string()),
                    name: None,
                    active: Some(false),
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({
                        "action": "delete",
                        "provider_response": { "deleted": true }
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
        assert_eq!(lifecycle.len(), 8);
        assert_eq!(lifecycle[0].action, ThreadLifecycleActionKind::Start);
        assert_eq!(lifecycle[0].request["cwd"], "/repo");
        assert_eq!(lifecycle[0].provider_response["thread"]["id"], "thread-1");
        assert_eq!(lifecycle[1].action, ThreadLifecycleActionKind::Resume);
        assert_eq!(lifecycle[1].provider_response["thread"]["id"], "thread-1");
        assert_eq!(lifecycle[2].action, ThreadLifecycleActionKind::SetName);
        assert_eq!(lifecycle[2].name.as_deref(), Some("Adapter parity"));
        assert_eq!(lifecycle[2].request["name"], "Adapter parity");
        assert_eq!(lifecycle[2].provider_response["name"], "Adapter parity");
        assert_eq!(lifecycle[3].action, ThreadLifecycleActionKind::Rollback);
        assert_eq!(lifecycle[3].turn_id.as_deref(), Some("turn-2"));
        assert_eq!(lifecycle[3].request["turn_id"], "turn-2");
        assert_eq!(lifecycle[3].provider_response["rolled_back"], true);
        assert_eq!(lifecycle[4].action, ThreadLifecycleActionKind::InjectItems);
        assert_eq!(lifecycle[4].item_count, Some(2));
        assert_eq!(lifecycle[4].request["items"][1]["type"], "agentMessage");
        assert_eq!(lifecycle[4].provider_response["injected"], true);
        assert_eq!(lifecycle[5].action, ThreadLifecycleActionKind::Archive);
        assert_eq!(lifecycle[6].action, ThreadLifecycleActionKind::Unarchive);
        assert_eq!(lifecycle[7].action, ThreadLifecycleActionKind::Delete);

        let thread = state.thread("thread-1").expect("thread");
        assert_eq!(thread.provider, "codex");
        assert_eq!(thread.name.as_deref(), Some("Adapter parity"));
        assert_eq!(thread.active, Some(false));
        assert_eq!(thread.archived, Some(false));
        assert_eq!(thread.metadata["status"], "deleted");
        assert_eq!(thread.metadata["name"], "Adapter parity");
        assert_eq!(thread.metadata["archived"], false);
        assert_eq!(
            thread.metadata["lifecycle"]["provider_response"]["deleted"],
            true
        );
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
    fn applies_approval_retry_runtime_signals() {
        let mut state = AgentRuntimeState::default();
        state.apply_provider_events(&[ProviderEvent::RuntimeSignal {
            signal: Box::new(NormalizedRuntimeSignal {
                kind: RuntimeSignalKind::ApprovalRetryRecorded,
                thread_id: Some("thread-1".to_string()),
                turn_id: None,
                item_id: Some("item-1".to_string()),
                message: Some("retry after user approval".to_string()),
                from_model: None,
                to_model: None,
                reason: Some("retry after user approval".to_string()),
                text: None,
                audio: None,
                status: Some("approved".to_string()),
                name: None,
                active: None,
                archived: None,
                diff: None,
                files: None,
                process_id: None,
                exit_code: None,
                request_id: None,
                metadata: json!({
                    "approval_retry": {
                        "thread_id": "thread-1",
                        "item_id": "item-1",
                        "action_id": "action-1",
                        "approved": true,
                        "reason": "retry after user approval",
                        "audit": { "selected_policy": "on-request" },
                        "provider_response": { "approved": true }
                    }
                }),
                provider: ProviderMetadata {
                    provider: "codex".to_string(),
                    method: Some("ace/approval_retry".to_string()),
                    schema_version: None,
                    raw_payload: json!({}),
                },
            }),
        }]);

        let retries = state.approval_retries();
        assert_eq!(retries.len(), 1);
        assert_eq!(retries[0].thread_id, "thread-1");
        assert_eq!(retries[0].item_id.as_deref(), Some("item-1"));
        assert_eq!(retries[0].action_id.as_deref(), Some("action-1"));
        assert!(retries[0].approved);
        assert_eq!(
            retries[0].reason.as_deref(),
            Some("retry after user approval")
        );
        assert_eq!(retries[0].audit["selected_policy"], "on-request");
        assert_eq!(retries[0].provider_response["approved"], true);
    }

    #[test]
    fn applies_thread_settings_and_token_usage_runtime_signals() {
        let mut state = AgentRuntimeState::default();
        state.apply_provider_events(&[
            ProviderEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::ThreadSettingsUpdated,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: None,
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: Some("settings_updated".to_string()),
                    name: None,
                    active: None,
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({
                        "settings": {
                            "model": "gpt-5.5",
                            "sandbox": "workspace-write"
                        }
                    }),
                    provider: ProviderMetadata {
                        provider: "codex".to_string(),
                        method: Some("thread/settings/updated".to_string()),
                        schema_version: None,
                        raw_payload: json!({}),
                    },
                }),
            },
            ProviderEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::ThreadTokenUsageUpdated,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: None,
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: Some("token_usage_updated".to_string()),
                    name: None,
                    active: None,
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({
                        "tokenUsage": {
                            "input": 64,
                            "output": 32,
                            "total": 96
                        }
                    }),
                    provider: ProviderMetadata {
                        provider: "codex".to_string(),
                        method: Some("thread/tokenUsage/updated".to_string()),
                        schema_version: None,
                        raw_payload: json!({}),
                    },
                }),
            },
        ]);

        let thread = state.thread("thread-1").expect("thread details");
        assert_eq!(thread.provider, "codex");
        assert_eq!(thread.settings["model"], "gpt-5.5");
        assert_eq!(thread.settings["sandbox"], "workspace-write");
        assert_eq!(thread.token_usage["total"], 96);

        state.upsert_thread(AgentThread {
            thread_id: "thread-1".to_string(),
            provider: "codex".to_string(),
            execution_location: ExecutionLocation::Worktree,
            name: Some("Adapter parity".to_string()),
            active: None,
            archived: None,
            active_turn: None,
            plan_session: None,
            settings: Value::Null,
            token_usage: Value::Null,
            metadata: json!({ "name": "Adapter parity" }),
        });

        let snapshot = state.snapshot();
        assert_eq!(snapshot.threads.len(), 1);
        assert_eq!(
            snapshot.threads[0].execution_location,
            ExecutionLocation::Worktree
        );
        assert_eq!(snapshot.threads[0].name.as_deref(), Some("Adapter parity"));
        assert_eq!(snapshot.threads[0].metadata["name"], "Adapter parity");
        assert_eq!(snapshot.threads[0].settings["model"], "gpt-5.5");
        assert_eq!(snapshot.threads[0].token_usage["total"], 96);
    }

    #[test]
    fn applies_turn_diff_and_process_exit_runtime_signals() {
        let mut state = AgentRuntimeState::default();
        state.apply_provider_events(&[
            ProviderEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::TurnDiffUpdated,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: None,
                    name: None,
                    active: None,
                    archived: None,
                    diff: Some("@@ -1 +1 @@".to_string()),
                    files: Some(json!([{ "path": "src/lib.rs" }])),
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({ "source": "initial" }),
                    provider: ProviderMetadata {
                        provider: "codex".to_string(),
                        method: Some("turn/diff/updated".to_string()),
                        schema_version: None,
                        raw_payload: json!({}),
                    },
                }),
            },
            ProviderEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::TurnDiffUpdated,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: None,
                    name: None,
                    active: None,
                    archived: None,
                    diff: Some("@@ -2 +2 @@".to_string()),
                    files: Some(json!([{ "path": "src/main.rs" }])),
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({ "source": "updated" }),
                    provider: ProviderMetadata {
                        provider: "codex".to_string(),
                        method: Some("turn/diff/updated".to_string()),
                        schema_version: None,
                        raw_payload: json!({}),
                    },
                }),
            },
            ProviderEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::ProcessExited,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: None,
                    name: None,
                    active: None,
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: Some("proc-1".to_string()),
                    exit_code: Some(2),
                    request_id: None,
                    metadata: json!({ "processId": "proc-1", "exitCode": 2 }),
                    provider: ProviderMetadata {
                        provider: "codex".to_string(),
                        method: Some("process/exited".to_string()),
                        schema_version: None,
                        raw_payload: json!({}),
                    },
                }),
            },
        ]);

        let diffs = state.turn_diffs();
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].thread_id, "thread-1");
        assert_eq!(diffs[0].turn_id.as_deref(), Some("turn-1"));
        assert_eq!(diffs[0].diff.as_deref(), Some("@@ -2 +2 @@"));
        assert_eq!(diffs[0].files[0]["path"], "src/main.rs");
        assert_eq!(diffs[0].metadata["source"], "updated");

        let exits = state.process_exits();
        assert_eq!(exits.len(), 1);
        assert_eq!(exits[0].thread_id.as_deref(), Some("thread-1"));
        assert_eq!(exits[0].turn_id.as_deref(), Some("turn-1"));
        assert_eq!(exits[0].process_id.as_deref(), Some("proc-1"));
        assert_eq!(exits[0].exit_code, Some(2));

        let snapshot = state.snapshot();
        assert_eq!(snapshot.turn_diffs[0].diff.as_deref(), Some("@@ -2 +2 @@"));
        assert_eq!(snapshot.process_exits[0].metadata["exitCode"], 2);
    }

    #[test]
    fn applies_runtime_status_and_review_runtime_signals() {
        let mut warning = runtime_signal(RuntimeSignalKind::Warning, "warning");
        warning.thread_id = Some("thread-1".to_string());
        warning.turn_id = Some("turn-1".to_string());
        warning.message = Some("sandbox warning".to_string());
        warning.metadata = json!({ "severity": "warning" });

        let mut reroute = runtime_signal(RuntimeSignalKind::ModelRerouted, "model/rerouted");
        reroute.thread_id = Some("thread-1".to_string());
        reroute.turn_id = Some("turn-1".to_string());
        reroute.from_model = Some("gpt-5".to_string());
        reroute.to_model = Some("gpt-5.5".to_string());
        reroute.reason = Some("capacity".to_string());

        let mut provider_state =
            runtime_signal(RuntimeSignalKind::ProviderStateUpdated, "account/updated");
        provider_state.status = Some("account_updated".to_string());
        provider_state.message = Some("Signed in".to_string());
        provider_state.name = Some("work".to_string());
        provider_state.metadata = json!({ "email": "user@example.com" });

        let mut realtime_initial = runtime_signal(
            RuntimeSignalKind::RealtimeSessionUpdated,
            "thread/realtime/started",
        );
        realtime_initial.thread_id = Some("thread-1".to_string());
        realtime_initial.turn_id = Some("turn-1".to_string());
        realtime_initial.status = Some("started".to_string());

        let mut realtime_error = runtime_signal(
            RuntimeSignalKind::RealtimeSessionUpdated,
            "thread/realtime/error",
        );
        realtime_error.thread_id = Some("thread-1".to_string());
        realtime_error.turn_id = Some("turn-1".to_string());
        realtime_error.status = Some("error".to_string());
        realtime_error.message = Some("Realtime failed".to_string());
        realtime_error.metadata = json!({ "error": "Realtime failed" });

        let mut moderation_initial = runtime_signal(
            RuntimeSignalKind::TurnModerationUpdated,
            "turn/moderationMetadata",
        );
        moderation_initial.thread_id = Some("thread-1".to_string());
        moderation_initial.turn_id = Some("turn-1".to_string());
        moderation_initial.status = Some("checking".to_string());
        moderation_initial.metadata = json!({ "blocked": false });

        let mut moderation_done = runtime_signal(
            RuntimeSignalKind::TurnModerationUpdated,
            "turn/moderationMetadata",
        );
        moderation_done.thread_id = Some("thread-1".to_string());
        moderation_done.turn_id = Some("turn-1".to_string());
        moderation_done.status = Some("passed".to_string());
        moderation_done.metadata = json!({ "blocked": false, "result": "ok" });

        let mut auto_review_started = runtime_signal(
            RuntimeSignalKind::AutoApprovalReviewUpdated,
            "item/autoApprovalReview/started",
        );
        auto_review_started.thread_id = Some("thread-1".to_string());
        auto_review_started.turn_id = Some("turn-1".to_string());
        auto_review_started.item_id = Some("review-1".to_string());
        auto_review_started.status = Some("started".to_string());
        auto_review_started.message = Some("reviewing command".to_string());

        let mut auto_review_completed = runtime_signal(
            RuntimeSignalKind::AutoApprovalReviewUpdated,
            "item/autoApprovalReview/completed",
        );
        auto_review_completed.thread_id = Some("thread-1".to_string());
        auto_review_completed.turn_id = Some("turn-1".to_string());
        auto_review_completed.item_id = Some("review-1".to_string());
        auto_review_completed.status = Some("completed".to_string());
        auto_review_completed.message = Some("approved command".to_string());
        auto_review_completed.metadata = json!({ "approved": true });

        let mut state = AgentRuntimeState::default();
        state.apply_provider_events(&[
            ProviderEvent::RuntimeSignal {
                signal: Box::new(warning),
            },
            ProviderEvent::RuntimeSignal {
                signal: Box::new(reroute),
            },
            ProviderEvent::RuntimeSignal {
                signal: Box::new(provider_state),
            },
            ProviderEvent::RuntimeSignal {
                signal: Box::new(realtime_initial),
            },
            ProviderEvent::RuntimeSignal {
                signal: Box::new(realtime_error),
            },
            ProviderEvent::RuntimeSignal {
                signal: Box::new(moderation_initial),
            },
            ProviderEvent::RuntimeSignal {
                signal: Box::new(moderation_done),
            },
            ProviderEvent::RuntimeSignal {
                signal: Box::new(auto_review_started),
            },
            ProviderEvent::RuntimeSignal {
                signal: Box::new(auto_review_completed),
            },
        ]);

        assert_eq!(state.warnings().len(), 1);
        assert_eq!(state.warnings()[0].message, "sandbox warning");
        assert_eq!(state.warnings()[0].metadata["severity"], "warning");
        assert_eq!(state.model_reroutes().len(), 1);
        assert_eq!(
            state.model_reroutes()[0].from_model.as_deref(),
            Some("gpt-5")
        );
        assert_eq!(
            state.model_reroutes()[0].to_model.as_deref(),
            Some("gpt-5.5")
        );

        let snapshot = state.snapshot();
        assert_eq!(snapshot.provider_states.len(), 1);
        assert_eq!(snapshot.provider_states[0].status, "account_updated");
        assert_eq!(
            snapshot.provider_states[0].metadata["email"],
            "user@example.com"
        );
        assert_eq!(snapshot.realtime_sessions.len(), 1);
        assert_eq!(snapshot.realtime_sessions[0].status, "error");
        assert_eq!(
            snapshot.realtime_sessions[0].message.as_deref(),
            Some("Realtime failed")
        );
        assert_eq!(snapshot.turn_moderation.len(), 1);
        assert_eq!(snapshot.turn_moderation[0].status, "passed");
        assert_eq!(snapshot.turn_moderation[0].metadata["result"], "ok");
        assert_eq!(snapshot.auto_approval_reviews.len(), 1);
        assert_eq!(snapshot.auto_approval_reviews[0].status, "completed");
        assert_eq!(
            snapshot.auto_approval_reviews[0].message.as_deref(),
            Some("approved command")
        );
        assert_eq!(snapshot.auto_approval_reviews[0].metadata["approved"], true);
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
    fn records_remote_connections_with_stable_replacement() {
        let mut state = AgentRuntimeState::default();
        state.replace_remote_connections(
            "codex",
            [
                RemoteConnectionRecord {
                    provider: "codex".to_string(),
                    host_id: "devbox-b".to_string(),
                    host: Some("devbox-b".to_string()),
                    display_name: Some("Devbox B".to_string()),
                    status: Some("online".to_string()),
                    execution_location: ExecutionLocation::RemoteHost,
                    projects: json!([{ "path": "/repo-b" }]),
                    metadata: json!({ "platform": "linux" }),
                },
                RemoteConnectionRecord {
                    provider: "codex".to_string(),
                    host_id: "devbox-a".to_string(),
                    host: Some("devbox-a".to_string()),
                    display_name: Some("Devbox A".to_string()),
                    status: Some("offline".to_string()),
                    execution_location: ExecutionLocation::RemoteHost,
                    projects: Value::Null,
                    metadata: json!({ "platform": "macos" }),
                },
            ],
        );
        state.upsert_remote_connection(RemoteConnectionRecord {
            provider: "ace".to_string(),
            host_id: "native-local".to_string(),
            host: Some("localhost".to_string()),
            display_name: Some("This computer".to_string()),
            status: Some("ready".to_string()),
            execution_location: ExecutionLocation::Local,
            projects: Value::Null,
            metadata: Value::Null,
        });
        state.replace_remote_connections(
            "codex",
            [RemoteConnectionRecord {
                provider: "codex".to_string(),
                host_id: "devbox-c".to_string(),
                host: Some("devbox-c".to_string()),
                display_name: Some("Devbox C".to_string()),
                status: Some("online".to_string()),
                execution_location: ExecutionLocation::RemoteHost,
                projects: json!([{ "path": "/repo-c" }]),
                metadata: json!({ "platform": "linux" }),
            }],
        );

        let connections = state.remote_connections();
        assert_eq!(
            connections
                .iter()
                .map(|connection| connection.host_id.as_str())
                .collect::<Vec<_>>(),
            ["native-local", "devbox-c"]
        );
        assert_eq!(connections[1].display_name.as_deref(), Some("Devbox C"));
        assert_eq!(connections[1].projects[0]["path"], "/repo-c");
        assert_eq!(state.snapshot().remote_connections, connections);
    }

    #[test]
    fn records_remote_connection_status_updates_from_provider_events() {
        let mut state = AgentRuntimeState::default();
        let mut signal = runtime_signal(
            RuntimeSignalKind::ProviderStateUpdated,
            "remoteControl/status/changed",
        );
        signal.status = Some("connected".to_string());
        signal.name = Some("Devbox".to_string());
        signal.metadata = json!({
            "hostId": "devbox",
            "host": "devbox.example.com",
            "displayName": "Devbox",
            "status": "connected",
            "projects": [{ "path": "/srv/ace" }],
        });
        signal.provider.raw_payload = signal.metadata.clone();

        state.apply_provider_events(&[ProviderEvent::RuntimeSignal {
            signal: Box::new(signal),
        }]);

        let connections = state.remote_connections();
        assert_eq!(connections.len(), 1);
        assert_eq!(connections[0].provider, "codex");
        assert_eq!(connections[0].host_id, "devbox");
        assert_eq!(connections[0].host.as_deref(), Some("devbox.example.com"));
        assert_eq!(connections[0].display_name.as_deref(), Some("Devbox"));
        assert_eq!(connections[0].status.as_deref(), Some("connected"));
        assert_eq!(
            connections[0].execution_location,
            ExecutionLocation::RemoteHost
        );
        assert_eq!(connections[0].projects[0]["path"], "/srv/ace");
    }

    #[test]
    fn records_coarse_remote_control_status_without_host_identity() {
        let mut state = AgentRuntimeState::default();
        let mut signal = runtime_signal(
            RuntimeSignalKind::ProviderStateUpdated,
            "remoteControl/status/changed",
        );
        signal.status = Some("disconnected".to_string());
        signal.metadata = json!({ "status": "disconnected" });
        signal.provider.raw_payload = signal.metadata.clone();

        state.apply_provider_events(&[ProviderEvent::RuntimeSignal {
            signal: Box::new(signal),
        }]);

        let connections = state.remote_connections();
        assert_eq!(connections.len(), 1);
        assert_eq!(connections[0].host_id, "remote_control");
        assert_eq!(connections[0].status.as_deref(), Some("disconnected"));
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
        state.record_handoff(HandoffPlan {
            source_thread_id: "thread-a".to_string(),
            target_location: ExecutionLocation::Worktree,
            status: HandoffStatus::Completed,
            target_thread_id: Some("child-c".to_string()),
            repo_root: Some("/repo".to_string()),
            worktree_path: Some("/worktrees/repo-child-c".to_string()),
            branch: Some("feature/child-c".to_string()),
            start_point: Some("main".to_string()),
            checkpoint_ref: Some("checkpoint-1".to_string()),
            remote_host: None,
            transfer_status: Some("metadata_updated".to_string()),
            interrupted_active_turn: Some(true),
            metadata: json!({ "transfer": "complete" }),
        });
        state.upsert_thread(AgentThread {
            thread_id: "thread-b".to_string(),
            provider: "codex".to_string(),
            execution_location: ExecutionLocation::Worktree,
            name: Some("B".to_string()),
            active: None,
            archived: None,
            active_turn: None,
            plan_session: None,
            settings: Value::Null,
            token_usage: Value::Null,
            metadata: json!({ "name": "B" }),
        });
        state.upsert_thread(AgentThread {
            thread_id: "thread-a".to_string(),
            provider: "codex".to_string(),
            execution_location: ExecutionLocation::Local,
            name: Some("A".to_string()),
            active: None,
            archived: None,
            active_turn: None,
            plan_session: None,
            settings: Value::Null,
            token_usage: Value::Null,
            metadata: json!({ "name": "A" }),
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
                status_text: None,
                model: None,
                target: None,
                url: None,
                files: None,
                attachments: None,
                diff: None,
                token_usage: None,
                plan_questions: None,
                plan_completion: None,
                metadata: json!({}),
                provider: ProviderMetadata {
                    provider: "codex".to_string(),
                    method: Some("item/completed".to_string()),
                    schema_version: None,
                    raw_payload: json!({}),
                },
            }),
        }]);
        state.apply_provider_events(&[ProviderEvent::ThreadItem {
            item: Box::new(NormalizedThreadItem {
                kind: ThreadItemKind::EnteredReviewMode,
                status: ThreadItemStatus::Started,
                thread_id: Some("thread-a".to_string()),
                turn_id: Some("turn-a".to_string()),
                item_id: Some("review-child-1".to_string()),
                parent_thread_id: Some("thread-a".to_string()),
                child_thread_id: Some("review-a".to_string()),
                sender: None,
                role: Some("reviewer".to_string()),
                title: Some("Detached review".to_string()),
                text: None,
                status_text: Some("started".to_string()),
                model: None,
                target: None,
                url: None,
                files: None,
                attachments: None,
                diff: None,
                token_usage: None,
                plan_questions: None,
                plan_completion: None,
                metadata: json!({ "detached": true }),
                provider: ProviderMetadata {
                    provider: "codex".to_string(),
                    method: Some("item/started".to_string()),
                    schema_version: None,
                    raw_payload: json!({}),
                },
            }),
        }]);

        let snapshot = state.snapshot();
        assert_eq!(
            snapshot
                .threads
                .iter()
                .map(|thread| thread.thread_id.as_str())
                .collect::<Vec<_>>(),
            ["thread-a", "thread-b"]
        );
        assert_eq!(
            snapshot.threads[0]
                .active_turn
                .as_ref()
                .map(|turn| turn.turn_id.as_deref()),
            Some(Some("turn-a"))
        );
        assert_eq!(
            snapshot.threads[0]
                .plan_session
                .as_ref()
                .map(|plan| plan.status),
            Some(PlanSessionStatus::Active)
        );
        assert_eq!(snapshot.threads[1].metadata["name"], "B");
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
        assert_eq!(snapshot.review_threads, ["thread-a", "thread-c"]);
        assert_eq!(
            snapshot
                .child_threads
                .iter()
                .map(|child| (
                    child.parent_thread_id.as_str(),
                    child.thread_id.as_str(),
                    child.relationship
                ))
                .collect::<Vec<_>>(),
            [
                ("thread-a", "child-a", ChildThreadRelationship::Fork),
                ("thread-a", "child-b", ChildThreadRelationship::Fork),
                ("thread-a", "child-c", ChildThreadRelationship::Handoff),
                ("thread-a", "review-a", ChildThreadRelationship::Review),
                ("thread-a", "side-a", ChildThreadRelationship::SideChat),
                ("thread-a", "side-b", ChildThreadRelationship::SideChat),
                ("thread-a", "sub-a", ChildThreadRelationship::Subagent),
                ("thread-a", "sub-b", ChildThreadRelationship::Subagent),
            ]
        );
        let handoff_child = snapshot
            .child_threads
            .iter()
            .find(|child| child.relationship == ChildThreadRelationship::Handoff)
            .expect("handoff child");
        assert_eq!(handoff_child.status.as_deref(), Some("completed"));
        assert_eq!(
            handoff_child.execution_location,
            Some(ExecutionLocation::Worktree)
        );
        assert_eq!(handoff_child.metadata["transfer"], "complete");
        let review_child = snapshot
            .child_threads
            .iter()
            .find(|child| child.relationship == ChildThreadRelationship::Review)
            .expect("review child");
        assert_eq!(review_child.item_id.as_deref(), Some("review-child-1"));
        assert_eq!(review_child.status.as_deref(), Some("started"));
        assert_eq!(review_child.metadata["detached"], true);
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
                status_text: None,
                model: None,
                target: None,
                url: None,
                files: None,
                attachments: None,
                diff: None,
                token_usage: None,
                plan_questions: None,
                plan_completion: None,
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

    #[test]
    fn applies_fork_and_side_chat_runtime_signals() {
        let mut state = AgentRuntimeState::default();
        state.apply_provider_events(&[
            ProviderEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::ForkUpdated,
                    thread_id: Some("parent-1".to_string()),
                    turn_id: Some("turn-2".to_string()),
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: Some("created".to_string()),
                    name: None,
                    active: None,
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({
                        "fork": {
                            "parent_thread_id": "parent-1",
                            "child_thread_id": "child-1",
                            "turn_id": "turn-2"
                        }
                    }),
                    provider: ProviderMetadata {
                        provider: "codex".to_string(),
                        method: Some("ace/thread/fork".to_string()),
                        schema_version: None,
                        raw_payload: json!({}),
                    },
                }),
            },
            ProviderEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::SideChatUpdated,
                    thread_id: Some("child-1".to_string()),
                    turn_id: Some("turn-2".to_string()),
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: Some("created".to_string()),
                    name: None,
                    active: None,
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({
                        "side_chat": {
                            "parent_thread_id": "parent-1",
                            "thread_id": "child-1",
                            "ephemeral": true
                        }
                    }),
                    provider: ProviderMetadata {
                        provider: "codex".to_string(),
                        method: Some("ace/side_chat/start".to_string()),
                        schema_version: None,
                        raw_payload: json!({}),
                    },
                }),
            },
        ]);

        let fork = state.fork_point("child-1").expect("fork");
        assert_eq!(fork.parent_thread_id, "parent-1");
        assert_eq!(fork.turn_id.as_deref(), Some("turn-2"));
        let side_chat = state.side_chat("child-1").expect("side chat");
        assert_eq!(side_chat.parent_thread_id, "parent-1");
        assert!(side_chat.ephemeral);
    }

    #[test]
    fn applies_turn_lifecycle_runtime_signals() {
        let mut state = AgentRuntimeState::default();
        state.apply_provider_events(&[
            ProviderEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::TurnLifecycleChanged,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: Some("started".to_string()),
                    name: None,
                    active: Some(true),
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({ "mode": "normal" }),
                    provider: ProviderMetadata {
                        provider: "codex".to_string(),
                        method: Some("ace/turn/start".to_string()),
                        schema_version: None,
                        raw_payload: json!({}),
                    },
                }),
            },
            ProviderEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::TurnLifecycleChanged,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: Some("completed".to_string()),
                    name: None,
                    active: Some(false),
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({ "mode": "normal" }),
                    provider: ProviderMetadata {
                        provider: "codex".to_string(),
                        method: Some("ace/turn/completed".to_string()),
                        schema_version: None,
                        raw_payload: json!({}),
                    },
                }),
            },
            ProviderEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::TurnLifecycleChanged,
                    thread_id: Some("plan-thread".to_string()),
                    turn_id: Some("plan-turn".to_string()),
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: Some("started".to_string()),
                    name: None,
                    active: Some(true),
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({ "mode": "plan" }),
                    provider: ProviderMetadata {
                        provider: "codex".to_string(),
                        method: Some("ace/turn/start".to_string()),
                        schema_version: None,
                        raw_payload: json!({}),
                    },
                }),
            },
            ProviderEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::TurnLifecycleChanged,
                    thread_id: Some("plan-thread".to_string()),
                    turn_id: Some("plan-turn".to_string()),
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: Some("interrupted".to_string()),
                    name: None,
                    active: Some(false),
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({ "mode": "plan" }),
                    provider: ProviderMetadata {
                        provider: "codex".to_string(),
                        method: Some("ace/turn/interrupted".to_string()),
                        schema_version: None,
                        raw_payload: json!({}),
                    },
                }),
            },
        ]);

        assert!(state.active_turn("thread-1").is_none());
        assert!(state.active_turn("plan-thread").is_none());
        assert_eq!(
            state.plan_session("plan-thread").map(|plan| plan.status),
            Some(PlanSessionStatus::Rejected)
        );
    }

    #[test]
    fn applies_review_mode_runtime_signals() {
        let mut state = AgentRuntimeState::default();
        state.apply_provider_events(&[
            ProviderEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::ReviewModeUpdated,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: None,
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: Some("entered".to_string()),
                    name: None,
                    active: Some(true),
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({ "detached": true }),
                    provider: ProviderMetadata {
                        provider: "codex".to_string(),
                        method: Some("ace/review/start".to_string()),
                        schema_version: None,
                        raw_payload: json!({}),
                    },
                }),
            },
            ProviderEvent::RuntimeSignal {
                signal: Box::new(NormalizedRuntimeSignal {
                    kind: RuntimeSignalKind::ReviewModeUpdated,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: None,
                    item_id: None,
                    message: None,
                    from_model: None,
                    to_model: None,
                    reason: None,
                    text: None,
                    audio: None,
                    status: Some("exited".to_string()),
                    name: None,
                    active: Some(false),
                    archived: None,
                    diff: None,
                    files: None,
                    process_id: None,
                    exit_code: None,
                    request_id: None,
                    metadata: json!({}),
                    provider: ProviderMetadata {
                        provider: "codex".to_string(),
                        method: Some("ace/review/exit".to_string()),
                        schema_version: None,
                        raw_payload: json!({}),
                    },
                }),
            },
        ]);

        assert!(!state.is_reviewing("thread-1"));

        state.apply_provider_events(&[ProviderEvent::RuntimeSignal {
            signal: Box::new(NormalizedRuntimeSignal {
                kind: RuntimeSignalKind::ReviewModeUpdated,
                thread_id: Some("thread-1".to_string()),
                turn_id: None,
                item_id: None,
                message: None,
                from_model: None,
                to_model: None,
                reason: None,
                text: None,
                audio: None,
                status: Some("entered".to_string()),
                name: None,
                active: Some(true),
                archived: None,
                diff: None,
                files: None,
                process_id: None,
                exit_code: None,
                request_id: None,
                metadata: json!({}),
                provider: ProviderMetadata {
                    provider: "codex".to_string(),
                    method: Some("ace/review/start".to_string()),
                    schema_version: None,
                    raw_payload: json!({}),
                },
            }),
        }]);
        assert!(state.is_reviewing("thread-1"));
    }
}

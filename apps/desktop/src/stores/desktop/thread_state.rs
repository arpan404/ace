use ace_runtime::{
    chat::{ChatMessageProjection, ChatMessageRole, ThreadStatus, ThreadSummary},
    provider::{ProviderMetadata, ThreadItemKind, ThreadItemStatus},
    threads::{
        GoalState, GoalStatus, HandoffStatus, PlanSessionStatus, SubagentActionKind,
        ThreadLifecycleActionKind, TurnMode,
    },
};

pub(super) fn extract_thread_id(value: &serde_json::Value) -> Option<String> {
    value
        .pointer("/thread/id")
        .or_else(|| value.pointer("/thread/threadId"))
        .or_else(|| value.get("threadId"))
        .or_else(|| value.get("id"))
        .and_then(serde_json::Value::as_str)
        .map(ToString::to_string)
}

pub(super) fn chat_role_from_thread_item(kind: ThreadItemKind) -> ChatMessageRole {
    match kind {
        ThreadItemKind::UserMessage => ChatMessageRole::User,
        ThreadItemKind::AgentMessage | ThreadItemKind::Reasoning => ChatMessageRole::Assistant,
        ThreadItemKind::Plan => ChatMessageRole::Plan,
        ThreadItemKind::CommandExecution
        | ThreadItemKind::FileChange
        | ThreadItemKind::McpToolCall
        | ThreadItemKind::DynamicToolCall
        | ThreadItemKind::CollabAgentToolCall
        | ThreadItemKind::WebSearch
        | ThreadItemKind::ImageView
        | ThreadItemKind::ImageGeneration => ChatMessageRole::Tool,
        ThreadItemKind::HookPrompt
        | ThreadItemKind::SubAgentActivity
        | ThreadItemKind::EnteredReviewMode
        | ThreadItemKind::ExitedReviewMode
        | ThreadItemKind::ContextCompaction
        | ThreadItemKind::Unknown => ChatMessageRole::Activity,
    }
}

pub(super) fn thread_item_fallback_id(kind: ThreadItemKind) -> String {
    format!("thread-item:{kind:?}")
}

#[cfg(test)]
pub(super) fn chat_message(
    id: String,
    role: ChatMessageRole,
    text: String,
) -> ChatMessageProjection {
    chat_message_with_settings(id, role, text, None)
}

pub(super) fn chat_message_with_settings(
    id: String,
    role: ChatMessageRole,
    text: String,
    turn_settings_summary: Option<String>,
) -> ChatMessageProjection {
    ChatMessageProjection {
        id,
        role,
        status: ThreadItemStatus::Completed,
        title: None,
        text: Some(text),
        turn_settings_summary,
    }
}

pub(super) fn thread_status_is_terminal(status: ThreadStatus) -> bool {
    matches!(
        status,
        ThreadStatus::Error | ThreadStatus::Completed | ThreadStatus::Idle | ThreadStatus::Archived
    )
}

pub(super) fn turn_mode_label(mode: TurnMode) -> &'static str {
    match mode {
        TurnMode::Normal => "Run",
        TurnMode::Plan => "Plan",
    }
}

pub(super) fn plan_session_status_label(status: PlanSessionStatus) -> &'static str {
    match status {
        PlanSessionStatus::Active => "active",
        PlanSessionStatus::Completed => "completed",
        PlanSessionStatus::Rejected => "rejected",
        PlanSessionStatus::Implementing => "implementing",
    }
}

pub(super) fn handoff_status_label(status: HandoffStatus) -> &'static str {
    match status {
        HandoffStatus::Requested => "requested",
        HandoffStatus::Interrupted => "interrupted",
        HandoffStatus::Transferring => "transferring",
        HandoffStatus::Completed => "completed",
        HandoffStatus::Failed => "failed",
    }
}

pub(super) fn subagent_action_label(action: SubagentActionKind) -> &'static str {
    match action {
        SubagentActionKind::Steer => "steer",
        SubagentActionKind::Stop => "stop",
        SubagentActionKind::Close => "close",
    }
}

pub(super) fn subagent_action_from_value(action: &str) -> SubagentActionKind {
    match action.trim().to_ascii_lowercase().as_str() {
        "stop" => SubagentActionKind::Stop,
        "close" => SubagentActionKind::Close,
        _ => SubagentActionKind::Steer,
    }
}

pub(super) fn thread_item_status_key(status: ThreadItemStatus) -> &'static str {
    match status {
        ThreadItemStatus::Started => "started",
        ThreadItemStatus::Updated => "updated",
        ThreadItemStatus::Completed => "completed",
        ThreadItemStatus::Failed => "failed",
    }
}

pub(super) fn plan_session_status_from_thread_item_status(
    status: ThreadItemStatus,
) -> PlanSessionStatus {
    match status {
        ThreadItemStatus::Started | ThreadItemStatus::Updated => PlanSessionStatus::Active,
        ThreadItemStatus::Completed => PlanSessionStatus::Completed,
        ThreadItemStatus::Failed => PlanSessionStatus::Rejected,
    }
}

pub(super) fn provider_metadata_from_name(provider: String) -> ProviderMetadata {
    ProviderMetadata {
        provider,
        method: None,
        schema_version: None,
        raw_payload: serde_json::Value::Null,
    }
}

pub(super) fn child_thread_metadata_with_status_text(
    mut metadata: serde_json::Value,
    status_text: Option<String>,
) -> serde_json::Value {
    let Some(status_text) = status_text else {
        return metadata;
    };
    if let serde_json::Value::Object(object) = &mut metadata {
        object.insert(
            "status_text".to_string(),
            serde_json::Value::String(status_text),
        );
        return metadata;
    }
    serde_json::json!({ "status_text": status_text, "metadata": metadata })
}

pub(super) fn thread_status_from_provider(status: &str) -> Option<ThreadStatus> {
    match status
        .trim()
        .to_ascii_lowercase()
        .replace(['-', ' '], "_")
        .as_str()
    {
        "error" | "failed" | "failure" => Some(ThreadStatus::Error),
        "working" | "running" | "active" | "started" | "resumed" => Some(ThreadStatus::Working),
        "connecting" | "starting" => Some(ThreadStatus::Connecting),
        "pending_approval" | "approval_required" | "needs_approval" => {
            Some(ThreadStatus::PendingApproval)
        }
        "awaiting_input" | "input_required" | "needs_input" => Some(ThreadStatus::AwaitingInput),
        "plan_ready" | "plan" => Some(ThreadStatus::PlanReady),
        "completed" | "complete" | "done" => Some(ThreadStatus::Completed),
        "draft" => Some(ThreadStatus::Draft),
        "idle" | "inactive" | "stopped" => Some(ThreadStatus::Idle),
        "archived" | "archive" => Some(ThreadStatus::Archived),
        _ => None,
    }
}

pub(super) fn thread_lifecycle_action_from_delta(
    status: Option<&str>,
    name: Option<&str>,
    active: Option<bool>,
    archived: Option<bool>,
    metadata: &serde_json::Value,
) -> ThreadLifecycleActionKind {
    if archived == Some(true) {
        return ThreadLifecycleActionKind::Archive;
    }
    if archived == Some(false) {
        return ThreadLifecycleActionKind::Unarchive;
    }
    if name.is_some_and(|name| !name.trim().is_empty()) {
        return ThreadLifecycleActionKind::SetName;
    }
    if active == Some(true) {
        return ThreadLifecycleActionKind::Resume;
    }
    match string_at_value(metadata, &["action", "kind", "type"])
        .as_deref()
        .or(status)
        .map(|value| value.trim().to_ascii_lowercase().replace(['-', ' '], "_"))
        .as_deref()
    {
        Some("start" | "started") => ThreadLifecycleActionKind::Start,
        Some("resume" | "resumed") => ThreadLifecycleActionKind::Resume,
        Some("archive" | "archived") => ThreadLifecycleActionKind::Archive,
        Some("unarchive" | "unarchived") => ThreadLifecycleActionKind::Unarchive,
        Some("delete" | "deleted") => ThreadLifecycleActionKind::Delete,
        Some("unsubscribe" | "unsubscribed") => ThreadLifecycleActionKind::Unsubscribe,
        Some("set_name" | "rename" | "renamed") => ThreadLifecycleActionKind::SetName,
        Some("compact" | "compacted") => ThreadLifecycleActionKind::Compact,
        Some("rollback" | "rolled_back") => ThreadLifecycleActionKind::Rollback,
        Some("inject_items" | "items_injected") => ThreadLifecycleActionKind::InjectItems,
        _ => ThreadLifecycleActionKind::UpdateMetadata,
    }
}

pub(super) fn string_at_value(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(serde_json::Value::as_str))
        .map(ToString::to_string)
}

pub(super) fn thread_run_mode_label(thread: &ThreadSummary) -> String {
    if thread.worktree_path.is_some() {
        "Worktree".to_string()
    } else {
        "Thread".to_string()
    }
}

pub(super) fn goal_signal_summary(goal: &GoalState) -> String {
    let objective = goal.objective.as_deref().unwrap_or("No objective");
    let budget = match (goal.tokens_used, goal.token_budget) {
        (Some(used), Some(budget)) => format!(" · {used}/{budget} tokens"),
        (Some(used), None) => format!(" · {used} tokens used"),
        (None, Some(budget)) => format!(" · {budget} token budget"),
        (None, None) => String::new(),
    };
    let time = goal
        .time_used_seconds
        .map(|seconds| format!(" · {seconds}s"))
        .unwrap_or_default();
    format!(
        "Goal {} · {}{}{}",
        goal_status_label(goal.status),
        objective,
        budget,
        time
    )
}

fn goal_status_label(status: GoalStatus) -> &'static str {
    match status {
        GoalStatus::Active => "active",
        GoalStatus::Paused => "paused",
        GoalStatus::Blocked => "blocked",
        GoalStatus::UsageLimited => "usage limited",
        GoalStatus::BudgetLimited => "budget limited",
        GoalStatus::Complete => "complete",
        GoalStatus::Cleared => "cleared",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thread_status_from_provider_normalizes_common_provider_values() {
        assert_eq!(
            thread_status_from_provider(" pending-approval "),
            Some(ThreadStatus::PendingApproval)
        );
        assert_eq!(
            thread_status_from_provider("needs input"),
            Some(ThreadStatus::AwaitingInput)
        );
        assert_eq!(
            thread_status_from_provider("DONE"),
            Some(ThreadStatus::Completed)
        );
        assert_eq!(thread_status_from_provider("unknown"), None);
    }

    #[test]
    fn lifecycle_action_prefers_explicit_state_before_metadata() {
        assert_eq!(
            thread_lifecycle_action_from_delta(
                Some("delete"),
                None,
                None,
                Some(true),
                &serde_json::json!({ "action": "resume" })
            ),
            ThreadLifecycleActionKind::Archive
        );
        assert_eq!(
            thread_lifecycle_action_from_delta(
                None,
                Some("New title"),
                Some(true),
                None,
                &serde_json::json!({ "action": "delete" })
            ),
            ThreadLifecycleActionKind::SetName
        );
        assert_eq!(
            thread_lifecycle_action_from_delta(
                Some("started"),
                None,
                None,
                None,
                &serde_json::json!({ "action": "items injected" })
            ),
            ThreadLifecycleActionKind::InjectItems
        );
    }

    #[test]
    fn child_thread_metadata_injects_status_text_without_losing_payload() {
        let metadata = child_thread_metadata_with_status_text(
            serde_json::json!({ "role": "reviewer" }),
            Some("running".to_string()),
        );
        assert_eq!(metadata["role"], "reviewer");
        assert_eq!(metadata["status_text"], "running");

        let wrapped = child_thread_metadata_with_status_text(
            serde_json::json!("raw"),
            Some("done".to_string()),
        );
        assert_eq!(wrapped["status_text"], "done");
        assert_eq!(wrapped["metadata"], "raw");
    }

    #[test]
    fn thread_item_roles_group_provider_tools_as_tool_messages() {
        assert_eq!(
            chat_role_from_thread_item(ThreadItemKind::UserMessage),
            ChatMessageRole::User
        );
        assert_eq!(
            chat_role_from_thread_item(ThreadItemKind::Plan),
            ChatMessageRole::Plan
        );
        assert_eq!(
            chat_role_from_thread_item(ThreadItemKind::DynamicToolCall),
            ChatMessageRole::Tool
        );
        assert_eq!(
            chat_role_from_thread_item(ThreadItemKind::ContextCompaction),
            ChatMessageRole::Activity
        );
    }
}

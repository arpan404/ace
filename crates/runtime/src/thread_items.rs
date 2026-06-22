use crate::provider::{NormalizedThreadItem, ProviderMetadata, ThreadItemKind, ThreadItemStatus};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThreadItemNormalizationInput {
    pub provider: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[must_use]
pub fn normalize_provider_thread_item(
    input: ThreadItemNormalizationInput,
) -> Option<NormalizedThreadItem> {
    let status = thread_item_status_from_method(&input.method)?;
    let item = input.params.get("item").unwrap_or(&input.params);
    let item_type = string_at(item, "type").or_else(|| item_type_from_method(&input.method));
    let kind = item_type
        .as_deref()
        .map(thread_item_kind_for_type)
        .unwrap_or(ThreadItemKind::Unknown);

    let item_id = string_at(&input.params, "itemId").or_else(|| string_at(item, "id"));
    let text = text_for_thread_item(&input.method, item, &input.params);
    let title = title_for_thread_item(kind, item, text.as_deref());
    let metadata = metadata_for_thread_item(item);

    Some(NormalizedThreadItem {
        kind,
        status,
        thread_id: string_at(&input.params, "threadId").or_else(|| string_at(item, "threadId")),
        turn_id: string_at(&input.params, "turnId").or_else(|| string_at(item, "turnId")),
        item_id,
        parent_thread_id: string_at(item, "parentThreadId")
            .or_else(|| string_at(item, "parent_thread_id"))
            .or_else(|| string_at(item, "senderThreadId")),
        child_thread_id: string_at(item, "childThreadId")
            .or_else(|| string_at(item, "child_thread_id"))
            .or_else(|| string_at(item, "threadId")),
        sender: string_at(item, "sender")
            .or_else(|| string_at(item, "senderName"))
            .or_else(|| string_at(item, "agentName")),
        role: string_at(item, "role")
            .or_else(|| string_at(item, "agentRole"))
            .or_else(|| string_at(item, "agent_role")),
        title,
        text,
        status_text: string_at(item, "status")
            .or_else(|| string_at(item, "state"))
            .or_else(|| string_at(&input.params, "status"))
            .or_else(|| string_at(&input.params, "state")),
        model: string_at(item, "model")
            .or_else(|| string_at(&input.params, "model"))
            .or_else(|| string_at(item, "modelName"))
            .or_else(|| string_at(&input.params, "modelName")),
        target: string_at(item, "target")
            .or_else(|| string_at(&input.params, "target"))
            .or_else(|| string_at(item, "path"))
            .or_else(|| string_at(&input.params, "path"))
            .or_else(|| string_at(item, "command"))
            .or_else(|| string_at(&input.params, "command")),
        url: string_at(item, "url").or_else(|| string_at(&input.params, "url")),
        files: value_at(item, "files").or_else(|| value_at(&input.params, "files")),
        diff: value_at(item, "diff")
            .or_else(|| value_at(&input.params, "diff"))
            .or_else(|| value_at(item, "patch"))
            .or_else(|| value_at(&input.params, "patch")),
        token_usage: value_at(item, "tokenUsage")
            .or_else(|| value_at(&input.params, "tokenUsage"))
            .or_else(|| value_at(item, "token_usage"))
            .or_else(|| value_at(&input.params, "token_usage"))
            .or_else(|| value_at(item, "usage"))
            .or_else(|| value_at(&input.params, "usage"))
            .or_else(|| value_at(item, "tokens"))
            .or_else(|| value_at(&input.params, "tokens")),
        metadata,
        provider: ProviderMetadata {
            provider: input.provider,
            method: Some(input.method),
            schema_version: string_at(&input.params, "schemaVersion")
                .or_else(|| string_at(item, "schemaVersion")),
            raw_payload: input.params,
        },
    })
}

fn thread_item_status_from_method(method: &str) -> Option<ThreadItemStatus> {
    match method {
        "item/started" => Some(ThreadItemStatus::Started),
        "item/completed" => Some(ThreadItemStatus::Completed),
        "item/failed" => Some(ThreadItemStatus::Failed),
        "item/agentMessage/delta"
        | "item/reasoning/delta"
        | "item/reasoning/textDelta"
        | "item/reasoning/summaryTextDelta"
        | "item/reasoning/summaryPartAdded"
        | "item/plan/delta"
        | "turn/plan/updated"
        | "item/commandExecution/outputDelta"
        | "item/commandExecution/terminalInteraction"
        | "item/fileChange/outputDelta"
        | "item/fileChange/patchUpdated"
        | "item/mcpToolCall/progress"
        | "item/subAgentActivity/delta"
        | "item/collabAgentToolCall/progress"
        | "command/exec/outputDelta"
        | "process/outputDelta" => Some(ThreadItemStatus::Updated),
        _ => {
            if method.starts_with("item/") && method.ends_with("/delta") {
                Some(ThreadItemStatus::Updated)
            } else {
                None
            }
        }
    }
}

fn thread_item_kind_for_type(item_type: &str) -> ThreadItemKind {
    match item_type {
        "userMessage" => ThreadItemKind::UserMessage,
        "hookPrompt" => ThreadItemKind::HookPrompt,
        "agentMessage" => ThreadItemKind::AgentMessage,
        "plan" => ThreadItemKind::Plan,
        "reasoning" => ThreadItemKind::Reasoning,
        "commandExecution" => ThreadItemKind::CommandExecution,
        "fileChange" => ThreadItemKind::FileChange,
        "mcpToolCall" => ThreadItemKind::McpToolCall,
        "dynamicToolCall" => ThreadItemKind::DynamicToolCall,
        "collabAgentToolCall" => ThreadItemKind::CollabAgentToolCall,
        "subAgentActivity" => ThreadItemKind::SubAgentActivity,
        "webSearch" => ThreadItemKind::WebSearch,
        "imageView" => ThreadItemKind::ImageView,
        "imageGeneration" => ThreadItemKind::ImageGeneration,
        "enteredReviewMode" => ThreadItemKind::EnteredReviewMode,
        "exitedReviewMode" => ThreadItemKind::ExitedReviewMode,
        "contextCompaction" => ThreadItemKind::ContextCompaction,
        _ => ThreadItemKind::Unknown,
    }
}

fn text_for_thread_item(method: &str, item: &Value, params: &Value) -> Option<String> {
    if method.ends_with("/delta") || method == "turn/plan/updated" {
        return string_at(params, "delta")
            .or_else(|| string_at(params, "text"))
            .or_else(|| string_at(params, "content"))
            .or_else(|| string_at(item, "delta"));
    }

    string_at(item, "text")
        .or_else(|| string_at(item, "message"))
        .or_else(|| string_at(item, "content"))
        .or_else(|| string_at(item, "summary"))
        .or_else(|| item.get("input").and_then(|input| string_at(input, "text")))
}

fn title_for_thread_item(kind: ThreadItemKind, item: &Value, text: Option<&str>) -> Option<String> {
    string_at(item, "title")
        .or_else(|| string_at(item, "name"))
        .or_else(|| {
            if matches!(
                kind,
                ThreadItemKind::EnteredReviewMode | ThreadItemKind::ExitedReviewMode
            ) {
                Some(
                    match kind {
                        ThreadItemKind::EnteredReviewMode => "Entered review mode",
                        ThreadItemKind::ExitedReviewMode => "Exited review mode",
                        _ => unreachable!(),
                    }
                    .to_string(),
                )
            } else {
                None
            }
        })
        .or_else(|| text.map(compact_title))
}

fn metadata_for_thread_item(item: &Value) -> Value {
    let mut metadata = serde_json::Map::new();
    for key in [
        "status",
        "model",
        "agentRole",
        "agentName",
        "nickname",
        "target",
        "url",
        "files",
        "diff",
        "tokens",
    ] {
        if let Some(value) = item.get(key) {
            metadata.insert(key.to_string(), value.clone());
        }
    }
    Value::Object(metadata)
}

fn compact_title(text: &str) -> String {
    let trimmed = text.trim();
    let mut title = trimmed.chars().take(80).collect::<String>();
    if trimmed.chars().count() > 80 {
        title.push_str("...");
    }
    title
}

fn item_type_from_method(method: &str) -> Option<String> {
    if method.contains("agentMessage") {
        Some("agentMessage".to_string())
    } else if method.contains("reasoning") {
        Some("reasoning".to_string())
    } else if method.contains("plan") {
        Some("plan".to_string())
    } else if method.contains("commandExecution") || method.starts_with("command/exec") {
        Some("commandExecution".to_string())
    } else if method.contains("fileChange") {
        Some("fileChange".to_string())
    } else if method.contains("mcpToolCall") {
        Some("mcpToolCall".to_string())
    } else if method.contains("collabAgentToolCall") {
        Some("collabAgentToolCall".to_string())
    } else if method.contains("subAgentActivity") {
        Some("subAgentActivity".to_string())
    } else {
        None
    }
}

fn string_at(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(ToString::to_string)
}

fn value_at(value: &Value, key: &str) -> Option<Value> {
    value.get(key).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_agent_message_delta() {
        let item = normalize_provider_thread_item(ThreadItemNormalizationInput {
            provider: "future-provider".to_string(),
            method: "item/agentMessage/delta".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "itemId": "item-agent",
                "delta": "Working on it"
            }),
        })
        .expect("thread item");

        assert_eq!(item.kind, ThreadItemKind::AgentMessage);
        assert_eq!(item.status, ThreadItemStatus::Updated);
        assert_eq!(item.text.as_deref(), Some("Working on it"));
        assert_eq!(item.item_id.as_deref(), Some("item-agent"));
        assert_eq!(item.provider.provider, "future-provider");
        assert_eq!(item.provider.raw_payload["threadId"], "thread-1");
    }

    #[test]
    fn normalizes_review_compaction_and_subagent_items() {
        let review = normalize_provider_thread_item(ThreadItemNormalizationInput {
            provider: "future-provider".to_string(),
            method: "item/completed".to_string(),
            params: json!({
                "threadId": "thread-1",
                "item": {
                    "id": "review-1",
                    "type": "enteredReviewMode"
                }
            }),
        })
        .expect("review item");
        assert_eq!(review.kind, ThreadItemKind::EnteredReviewMode);
        assert_eq!(review.title.as_deref(), Some("Entered review mode"));

        let compaction = normalize_provider_thread_item(ThreadItemNormalizationInput {
            provider: "future-provider".to_string(),
            method: "item/completed".to_string(),
            params: json!({
                "threadId": "thread-1",
                "item": {
                    "id": "compact-1",
                    "type": "contextCompaction",
                    "summary": "Compressed older turns",
                    "tokens": 4096
                }
            }),
        })
        .expect("compaction item");
        assert_eq!(compaction.kind, ThreadItemKind::ContextCompaction);
        assert_eq!(compaction.metadata["tokens"], 4096);

        let subagent = normalize_provider_thread_item(ThreadItemNormalizationInput {
            provider: "future-provider".to_string(),
            method: "item/completed".to_string(),
            params: json!({
                "threadId": "parent-thread",
                "item": {
                    "id": "subagent-1",
                    "type": "subAgentActivity",
                    "parentThreadId": "parent-thread",
                    "childThreadId": "child-thread",
                    "agentRole": "reviewer",
                    "agentName": "Reviewer",
                    "status": "running"
                }
            }),
        })
        .expect("subagent item");
        assert_eq!(subagent.kind, ThreadItemKind::SubAgentActivity);
        assert_eq!(subagent.parent_thread_id.as_deref(), Some("parent-thread"));
        assert_eq!(subagent.child_thread_id.as_deref(), Some("child-thread"));
        assert_eq!(subagent.role.as_deref(), Some("reviewer"));
        assert_eq!(subagent.sender.as_deref(), Some("Reviewer"));
        assert_eq!(subagent.status_text.as_deref(), Some("running"));
    }

    #[test]
    fn normalizes_codex_item_detail_fields_without_parsing_raw_payloads() {
        let command = normalize_provider_thread_item(ThreadItemNormalizationInput {
            provider: "codex".to_string(),
            method: "item/completed".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {
                    "id": "cmd-1",
                    "type": "commandExecution",
                    "command": "cargo test --workspace",
                    "status": "completed",
                    "model": "gpt-5-codex",
                    "usage": {
                        "input_tokens": 10,
                        "output_tokens": 20
                    }
                }
            }),
        })
        .expect("command item");
        assert_eq!(command.kind, ThreadItemKind::CommandExecution);
        assert_eq!(command.target.as_deref(), Some("cargo test --workspace"));
        assert_eq!(command.status_text.as_deref(), Some("completed"));
        assert_eq!(command.model.as_deref(), Some("gpt-5-codex"));
        assert_eq!(
            command.token_usage.as_ref().expect("token usage")["output_tokens"],
            20
        );
        assert_eq!(
            command.provider.raw_payload["item"]["command"],
            "cargo test --workspace"
        );

        let file_change = normalize_provider_thread_item(ThreadItemNormalizationInput {
            provider: "codex".to_string(),
            method: "item/fileChange/patchUpdated".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "itemId": "file-1",
                "path": "src/main.rs",
                "files": ["src/main.rs"],
                "patch": "@@ -1 +1 @@"
            }),
        })
        .expect("file change item");
        assert_eq!(file_change.kind, ThreadItemKind::FileChange);
        assert_eq!(file_change.status, ThreadItemStatus::Updated);
        assert_eq!(file_change.target.as_deref(), Some("src/main.rs"));
        assert_eq!(file_change.files, Some(json!(["src/main.rs"])));
        assert_eq!(file_change.diff, Some(json!("@@ -1 +1 @@")));

        let web_search = normalize_provider_thread_item(ThreadItemNormalizationInput {
            provider: "codex".to_string(),
            method: "item/completed".to_string(),
            params: json!({
                "threadId": "thread-1",
                "item": {
                    "id": "search-1",
                    "type": "webSearch",
                    "query": "Codex app-server",
                    "url": "https://developers.openai.com/codex/app-server"
                }
            }),
        })
        .expect("web search item");
        assert_eq!(web_search.kind, ThreadItemKind::WebSearch);
        assert_eq!(
            web_search.url.as_deref(),
            Some("https://developers.openai.com/codex/app-server")
        );
        assert_eq!(
            web_search.metadata["url"],
            "https://developers.openai.com/codex/app-server"
        );
    }
}

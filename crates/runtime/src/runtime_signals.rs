use crate::provider::{NormalizedRuntimeSignal, ProviderMetadata, RuntimeSignalKind};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeSignalNormalizationInput {
    pub provider: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[must_use]
pub fn normalize_provider_runtime_signal(
    input: RuntimeSignalNormalizationInput,
) -> Option<NormalizedRuntimeSignal> {
    let mut signal = NormalizedRuntimeSignal {
        kind: runtime_signal_kind(&input.method)?,
        thread_id: string_at(&input.params, "threadId")
            .or_else(|| string_at(&input.params, "thread_id"))
            .or_else(|| {
                nested_string_at(&input.params, "/thread", &["id", "threadId", "thread_id"])
            }),
        turn_id: string_at(&input.params, "turnId")
            .or_else(|| string_at(&input.params, "turn_id"))
            .or_else(|| nested_string_at(&input.params, "/turn", &["id", "turnId", "turn_id"])),
        item_id: string_at(&input.params, "itemId")
            .or_else(|| string_at(&input.params, "item_id"))
            .or_else(|| nested_string_at(&input.params, "/item", &["id", "itemId", "item_id"])),
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
        metadata: input.params.clone(),
        provider: ProviderMetadata {
            provider: input.provider,
            method: Some(input.method.clone()),
            schema_version: string_at(&input.params, "schemaVersion"),
            raw_payload: input.params.clone(),
        },
    };

    match signal.kind {
        RuntimeSignalKind::Warning => {
            signal.message = first_string([
                string_at(&input.params, "message").as_deref(),
                string_at(&input.params, "text").as_deref(),
                string_at(&input.params, "warning").as_deref(),
                string_at(&input.params, "description").as_deref(),
                string_at(&input.params, "title").as_deref(),
                string_at(&input.params, "error").as_deref(),
            ]);
            if signal.message.is_none() {
                signal.message = warning_message_from_method(&input.method);
            }
            signal.message.as_ref()?;
        }
        RuntimeSignalKind::ModelRerouted => {
            signal.from_model = first_string([
                string_at(&input.params, "fromModel").as_deref(),
                string_at(&input.params, "from_model").as_deref(),
                string_at(&input.params, "previousModel").as_deref(),
                string_at(&input.params, "previous_model").as_deref(),
            ]);
            signal.to_model = first_string([
                string_at(&input.params, "toModel").as_deref(),
                string_at(&input.params, "to_model").as_deref(),
                string_at(&input.params, "model").as_deref(),
                string_at(&input.params, "targetModel").as_deref(),
                string_at(&input.params, "target_model").as_deref(),
            ]);
            signal.reason = first_string([
                string_at(&input.params, "reason").as_deref(),
                string_at(&input.params, "message").as_deref(),
                string_at(&input.params, "description").as_deref(),
            ]);
        }
        RuntimeSignalKind::RealtimeTranscriptDelta => {
            signal.text = first_string([
                string_at(&input.params, "delta").as_deref(),
                string_at(&input.params, "text").as_deref(),
                string_at(&input.params, "transcript").as_deref(),
                string_at(&input.params, "content").as_deref(),
            ]);
            signal.text.as_ref()?;
        }
        RuntimeSignalKind::RealtimeAudioDelta => {
            signal.audio = first_string([
                string_at(&input.params, "audio").as_deref(),
                string_at(&input.params, "delta").as_deref(),
                string_at(&input.params, "data").as_deref(),
                string_at(&input.params, "base64").as_deref(),
            ]);
            signal.audio.as_ref()?;
        }
        RuntimeSignalKind::ThreadLifecycleChanged => {
            signal.status = first_string([
                string_at(&input.params, "status").as_deref(),
                string_at(&input.params, "state").as_deref(),
                string_at(&input.params, "lifecycle").as_deref(),
            ])
            .or_else(|| lifecycle_status_from_method(&input.method));
            signal.name = string_at(&input.params, "name")
                .or_else(|| nested_string_at(&input.params, "/thread", &["name", "title"]));
            signal.active = bool_at(&input.params, "active")
                .or_else(|| lifecycle_active_from_method(&input.method));
            signal.archived = bool_at(&input.params, "archived")
                .or_else(|| lifecycle_archived_from_method(&input.method));
        }
        RuntimeSignalKind::ThreadSettingsUpdated => {
            signal.status = Some("settings_updated".to_string());
        }
        RuntimeSignalKind::ThreadTokenUsageUpdated => {
            signal.status = Some("token_usage_updated".to_string());
        }
        RuntimeSignalKind::TurnDiffUpdated => {
            signal.diff =
                string_at(&input.params, "diff").or_else(|| string_at(&input.params, "patch"));
            signal.files = input.params.get("files").cloned();
        }
        RuntimeSignalKind::ProcessExited => {
            signal.process_id = first_string([
                string_at(&input.params, "processId").as_deref(),
                string_at(&input.params, "process_id").as_deref(),
                string_at(&input.params, "id").as_deref(),
            ]);
            signal.exit_code = i64_at(&input.params, "exitCode")
                .or_else(|| i64_at(&input.params, "exit_code"))
                .or_else(|| i64_at(&input.params, "code"));
        }
        RuntimeSignalKind::ServerRequestResolved => {
            signal.request_id = first_string([
                string_at(&input.params, "requestId").as_deref(),
                string_at(&input.params, "request_id").as_deref(),
                string_at(&input.params, "id").as_deref(),
            ]);
            signal.status = first_string([
                string_at(&input.params, "status").as_deref(),
                string_at(&input.params, "outcome").as_deref(),
                string_at(&input.params, "result").as_deref(),
            ])
            .or_else(|| Some("resolved".to_string()));
        }
        RuntimeSignalKind::TurnLifecycleChanged => {}
        RuntimeSignalKind::ProviderStateUpdated => {
            signal.status = first_string([
                string_at(&input.params, "status").as_deref(),
                string_at(&input.params, "state").as_deref(),
                string_at(&input.params, "event").as_deref(),
                string_at(&input.params, "type").as_deref(),
            ])
            .or_else(|| provider_state_status_from_method(&input.method));
            signal.message = first_string([
                string_at(&input.params, "message").as_deref(),
                string_at(&input.params, "text").as_deref(),
                string_at(&input.params, "description").as_deref(),
                string_at(&input.params, "error").as_deref(),
            ]);
            signal.name = first_string([
                string_at(&input.params, "name").as_deref(),
                string_at(&input.params, "title").as_deref(),
                string_at(&input.params, "app").as_deref(),
                string_at(&input.params, "skill").as_deref(),
                string_at(&input.params, "plugin").as_deref(),
                string_at(&input.params, "connector").as_deref(),
                string_at(&input.params, "server").as_deref(),
                string_at(&input.params, "account").as_deref(),
                string_at(&input.params, "query").as_deref(),
                string_at(&input.params, "id").as_deref(),
            ]);
            if let Some(surface) = provider_state_surface(&input.method, &input.params) {
                signal.metadata = normalized_provider_state_metadata(&input.params, surface);
            }
        }
        RuntimeSignalKind::RealtimeSessionUpdated => {
            signal.status = first_string([
                string_at(&input.params, "status").as_deref(),
                string_at(&input.params, "state").as_deref(),
                string_at(&input.params, "event").as_deref(),
                string_at(&input.params, "type").as_deref(),
            ])
            .or_else(|| realtime_session_status_from_method(&input.method));
            signal.message = first_string([
                string_at(&input.params, "message").as_deref(),
                string_at(&input.params, "text").as_deref(),
                string_at(&input.params, "description").as_deref(),
                string_at(&input.params, "error").as_deref(),
            ]);
            signal.text = first_string([
                string_at(&input.params, "sdp").as_deref(),
                string_at(&input.params, "transcript").as_deref(),
                string_at(&input.params, "content").as_deref(),
            ]);
        }
        RuntimeSignalKind::TurnModerationUpdated => {
            signal.status = first_string([
                string_at(&input.params, "status").as_deref(),
                string_at(&input.params, "state").as_deref(),
            ])
            .or_else(|| Some("moderation_metadata_updated".to_string()));
        }
        RuntimeSignalKind::AutoApprovalReviewUpdated => {
            signal.status = first_string([
                string_at(&input.params, "status").as_deref(),
                string_at(&input.params, "state").as_deref(),
                string_at(&input.params, "outcome").as_deref(),
                string_at(&input.params, "result").as_deref(),
            ])
            .or_else(|| auto_approval_review_status_from_method(&input.method));
            signal.message = first_string([
                string_at(&input.params, "message").as_deref(),
                string_at(&input.params, "text").as_deref(),
                string_at(&input.params, "description").as_deref(),
                string_at(&input.params, "reason").as_deref(),
            ]);
        }
        RuntimeSignalKind::ReviewModeUpdated
        | RuntimeSignalKind::SubagentAction
        | RuntimeSignalKind::HandoffUpdated
        | RuntimeSignalKind::PlanImplementationUpdated
        | RuntimeSignalKind::ApprovalRetryRecorded
        | RuntimeSignalKind::GoalUpdated
        | RuntimeSignalKind::ForkUpdated
        | RuntimeSignalKind::SideChatUpdated => {}
    }

    Some(signal)
}

fn runtime_signal_kind(method: &str) -> Option<RuntimeSignalKind> {
    match method {
        "warning" => Some(RuntimeSignalKind::Warning),
        "configWarning"
        | "deprecationNotice"
        | "error"
        | "guardianWarning"
        | "windows/worldWritableWarning" => Some(RuntimeSignalKind::Warning),
        "model/rerouted" => Some(RuntimeSignalKind::ModelRerouted),
        "realtime/transcriptDelta"
        | "realtime/transcript/delta"
        | "thread/realtime/transcriptDelta"
        | "thread/realtime/transcript/delta" => Some(RuntimeSignalKind::RealtimeTranscriptDelta),
        "realtime/audioDelta"
        | "realtime/audio/delta"
        | "thread/realtime/audioDelta"
        | "thread/realtime/audio/delta"
        | "thread/realtime/outputAudioDelta"
        | "thread/realtime/outputAudio/delta" => Some(RuntimeSignalKind::RealtimeAudioDelta),
        "thread/started"
        | "thread/status/changed"
        | "thread/archived"
        | "thread/unarchived"
        | "thread/deleted"
        | "thread/closed"
        | "thread/compacted"
        | "thread/name/updated" => Some(RuntimeSignalKind::ThreadLifecycleChanged),
        "thread/settings/updated" => Some(RuntimeSignalKind::ThreadSettingsUpdated),
        "thread/tokenUsage/updated" => Some(RuntimeSignalKind::ThreadTokenUsageUpdated),
        "turn/diff/updated" => Some(RuntimeSignalKind::TurnDiffUpdated),
        "turn/moderationMetadata" => Some(RuntimeSignalKind::TurnModerationUpdated),
        "process/exited" => Some(RuntimeSignalKind::ProcessExited),
        "serverRequest/resolved" => Some(RuntimeSignalKind::ServerRequestResolved),
        "thread/realtime/closed"
        | "thread/realtime/error"
        | "thread/realtime/itemAdded"
        | "thread/realtime/sdp"
        | "thread/realtime/started"
        | "thread/realtime/transcript/done" => Some(RuntimeSignalKind::RealtimeSessionUpdated),
        "item/autoApprovalReview/completed" | "item/autoApprovalReview/started" => {
            Some(RuntimeSignalKind::AutoApprovalReviewUpdated)
        }
        "account/login/completed"
        | "account/rateLimits/updated"
        | "account/updated"
        | "app/list/updated"
        | "externalAgentConfig/import/completed"
        | "fs/changed"
        | "fuzzyFileSearch/sessionCompleted"
        | "fuzzyFileSearch/sessionUpdated"
        | "hook/completed"
        | "hook/started"
        | "mcpServer/oauthLogin/completed"
        | "mcpServer/startupStatus/updated"
        | "model/verification"
        | "remoteControl/status/changed"
        | "skills/changed"
        | "windowsSandbox/setupCompleted" => Some(RuntimeSignalKind::ProviderStateUpdated),
        _ => None,
    }
}

fn warning_message_from_method(method: &str) -> Option<String> {
    Some(
        match method {
            "configWarning" => "Configuration warning",
            "deprecationNotice" => "Deprecation notice",
            "error" => "Provider error",
            "guardianWarning" => "Approval warning",
            "windows/worldWritableWarning" => "World-writable path warning",
            _ => return None,
        }
        .to_string(),
    )
}

fn provider_state_status_from_method(method: &str) -> Option<String> {
    match method {
        "account/login/completed" => Some("account_login_completed".to_string()),
        "account/rateLimits/updated" => Some("account_rate_limits_updated".to_string()),
        "account/updated" => Some("account_updated".to_string()),
        "app/list/updated" => Some("app_list_updated".to_string()),
        "externalAgentConfig/import/completed" => {
            Some("external_agent_config_import_completed".to_string())
        }
        "fs/changed" => Some("filesystem_changed".to_string()),
        "fuzzyFileSearch/sessionCompleted" => Some("fuzzy_file_search_completed".to_string()),
        "fuzzyFileSearch/sessionUpdated" => Some("fuzzy_file_search_updated".to_string()),
        "hook/completed" => Some("hook_completed".to_string()),
        "hook/started" => Some("hook_started".to_string()),
        "mcpServer/oauthLogin/completed" => Some("mcp_oauth_login_completed".to_string()),
        "mcpServer/startupStatus/updated" => Some("mcp_startup_status_updated".to_string()),
        "model/verification" => Some("model_verification".to_string()),
        "remoteControl/status/changed" => Some("remote_control_status_changed".to_string()),
        "skills/changed" => Some("skills_changed".to_string()),
        "windowsSandbox/setupCompleted" => Some("windows_sandbox_setup_completed".to_string()),
        _ => None,
    }
}

fn provider_state_surface_from_method(method: &str) -> Option<&'static str> {
    match method {
        "app/list/updated" => Some("app"),
        "skills/changed" => Some("skill"),
        "mcpServer/oauthLogin/completed" | "mcpServer/startupStatus/updated" => Some("mcp"),
        "account/login/completed" | "account/rateLimits/updated" | "account/updated" => {
            Some("account")
        }
        "remoteControl/status/changed" => Some("remote"),
        "windowsSandbox/setupCompleted" => Some("sandbox"),
        _ => None,
    }
}

fn provider_state_surface(method: &str, params: &Value) -> Option<&'static str> {
    if method == "skills/changed" && skills_changed_payload_is_plugin(params) {
        return Some("plugin");
    }
    provider_state_surface_from_method(method)
}

fn skills_changed_payload_is_plugin(params: &Value) -> bool {
    if string_at(params, "plugin")
        .or_else(|| string_at(params, "pluginId"))
        .or_else(|| string_at(params, "plugin_id"))
        .or_else(|| string_at(params, "connector"))
        .is_some()
    {
        return true;
    }
    ["surface", "kind", "type", "category"]
        .into_iter()
        .filter_map(|key| string_at(params, key))
        .any(|value| {
            let value = value.to_ascii_lowercase();
            value.contains("plugin")
        })
        || string_at(params, "source")
            .is_some_and(|source| source.to_ascii_lowercase().contains("plugin"))
}

fn normalized_provider_state_metadata(params: &Value, surface: &str) -> Value {
    let mut metadata = params.as_object().cloned().unwrap_or_default();
    metadata.insert("surface".to_string(), Value::String(surface.to_string()));
    Value::Object(metadata)
}

fn realtime_session_status_from_method(method: &str) -> Option<String> {
    Some(
        match method {
            "thread/realtime/closed" => "closed",
            "thread/realtime/error" => "error",
            "thread/realtime/itemAdded" => "item_added",
            "thread/realtime/sdp" => "sdp_updated",
            "thread/realtime/started" => "started",
            "thread/realtime/transcript/done" => "transcript_done",
            _ => return None,
        }
        .to_string(),
    )
}

fn auto_approval_review_status_from_method(method: &str) -> Option<String> {
    Some(
        match method {
            "item/autoApprovalReview/completed" => "completed",
            "item/autoApprovalReview/started" => "started",
            _ => return None,
        }
        .to_string(),
    )
}

fn lifecycle_status_from_method(method: &str) -> Option<String> {
    Some(
        match method {
            "thread/started" => "started",
            "thread/archived" => "archived",
            "thread/unarchived" => "unarchived",
            "thread/deleted" => "deleted",
            "thread/closed" => "closed",
            "thread/compacted" => "compacted",
            "thread/name/updated" => "renamed",
            _ => return None,
        }
        .to_string(),
    )
}

fn lifecycle_active_from_method(method: &str) -> Option<bool> {
    match method {
        "thread/deleted" | "thread/closed" => Some(false),
        "thread/started" => Some(true),
        _ => None,
    }
}

fn lifecycle_archived_from_method(method: &str) -> Option<bool> {
    match method {
        "thread/archived" => Some(true),
        "thread/unarchived" => Some(false),
        _ => None,
    }
}

fn string_at(value: &Value, key: &str) -> Option<String> {
    value
        .as_object()
        .and_then(|object| object.get(key))
        .and_then(|value| match value {
            Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_string()),
            Value::Number(number) => Some(number.to_string()),
            _ => None,
        })
}

fn bool_at(value: &Value, key: &str) -> Option<bool> {
    value
        .as_object()
        .and_then(|object| object.get(key))
        .and_then(Value::as_bool)
}

fn i64_at(value: &Value, key: &str) -> Option<i64> {
    value
        .as_object()
        .and_then(|object| object.get(key))
        .and_then(Value::as_i64)
}

fn nested_string_at(value: &Value, pointer: &str, keys: &[&str]) -> Option<String> {
    value
        .pointer(pointer)
        .and_then(|nested| keys.iter().find_map(|key| string_at(nested, key)))
}

fn first_string<'a>(values: impl IntoIterator<Item = Option<&'a str>>) -> Option<String> {
    values
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_warning_lifecycle_and_provider_state_signals() {
        let warning = normalize_provider_runtime_signal(RuntimeSignalNormalizationInput {
            provider: "future-provider".to_string(),
            method: "warning".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "message": "Context is almost full",
                "severity": "warning"
            }),
        })
        .expect("warning signal");
        assert_eq!(warning.kind, RuntimeSignalKind::Warning);
        assert_eq!(warning.message.as_deref(), Some("Context is almost full"));
        assert_eq!(warning.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(warning.provider.provider, "future-provider");
        assert_eq!(warning.provider.raw_payload["severity"], "warning");

        let lifecycle = normalize_provider_runtime_signal(RuntimeSignalNormalizationInput {
            provider: "future-provider".to_string(),
            method: "thread/name/updated".to_string(),
            params: json!({
                "thread": { "id": "thread-1", "name": "Adapter parity" }
            }),
        })
        .expect("lifecycle signal");
        assert_eq!(lifecycle.kind, RuntimeSignalKind::ThreadLifecycleChanged);
        assert_eq!(lifecycle.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(lifecycle.status.as_deref(), Some("renamed"));
        assert_eq!(lifecycle.name.as_deref(), Some("Adapter parity"));

        let provider_state = normalize_provider_runtime_signal(RuntimeSignalNormalizationInput {
            provider: "future-provider".to_string(),
            method: "mcpServer/startupStatus/updated".to_string(),
            params: json!({
                "server": "browser",
                "status": "running"
            }),
        })
        .expect("provider state signal");
        assert_eq!(provider_state.kind, RuntimeSignalKind::ProviderStateUpdated);
        assert_eq!(provider_state.status.as_deref(), Some("running"));
        assert_eq!(
            provider_state.provider.method.as_deref(),
            Some("mcpServer/startupStatus/updated")
        );
        assert_eq!(provider_state.name.as_deref(), Some("browser"));
        assert_eq!(provider_state.metadata["surface"], "mcp");

        let skill_state = normalize_provider_runtime_signal(RuntimeSignalNormalizationInput {
            provider: "future-provider".to_string(),
            method: "skills/changed".to_string(),
            params: json!({
                "event": "installed",
                "skill": "rust",
                "source": "marketplace"
            }),
        })
        .expect("skill state signal");
        assert_eq!(skill_state.kind, RuntimeSignalKind::ProviderStateUpdated);
        assert_eq!(skill_state.status.as_deref(), Some("installed"));
        assert_eq!(skill_state.name.as_deref(), Some("rust"));
        assert_eq!(skill_state.metadata["surface"], "skill");
        assert_eq!(skill_state.provider.raw_payload["source"], "marketplace");

        let plugin_state = normalize_provider_runtime_signal(RuntimeSignalNormalizationInput {
            provider: "future-provider".to_string(),
            method: "skills/changed".to_string(),
            params: json!({
                "event": "installed",
                "plugin": "browser",
                "source": "plugin_marketplace"
            }),
        })
        .expect("plugin state signal");
        assert_eq!(plugin_state.kind, RuntimeSignalKind::ProviderStateUpdated);
        assert_eq!(plugin_state.status.as_deref(), Some("installed"));
        assert_eq!(plugin_state.name.as_deref(), Some("browser"));
        assert_eq!(plugin_state.metadata["surface"], "plugin");

        let app_state = normalize_provider_runtime_signal(RuntimeSignalNormalizationInput {
            provider: "future-provider".to_string(),
            method: "app/list/updated".to_string(),
            params: json!({
                "app": "browser",
                "status": "ready",
                "connector": "openai-bundled/browser"
            }),
        })
        .expect("app state signal");
        assert_eq!(app_state.kind, RuntimeSignalKind::ProviderStateUpdated);
        assert_eq!(app_state.status.as_deref(), Some("ready"));
        assert_eq!(app_state.name.as_deref(), Some("browser"));
        assert_eq!(app_state.metadata["surface"], "app");
        assert_eq!(
            app_state.provider.raw_payload["connector"],
            "openai-bundled/browser"
        );
    }

    #[test]
    fn normalizes_realtime_process_and_server_request_signals() {
        for method in [
            "realtime/transcriptDelta",
            "realtime/transcript/delta",
            "thread/realtime/transcriptDelta",
            "thread/realtime/transcript/delta",
        ] {
            let transcript = normalize_provider_runtime_signal(RuntimeSignalNormalizationInput {
                provider: "future-provider".to_string(),
                method: method.to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "delta": "hello"
                }),
            })
            .expect("transcript signal");
            assert_eq!(
                transcript.kind,
                RuntimeSignalKind::RealtimeTranscriptDelta,
                "{method}"
            );
            assert_eq!(transcript.text.as_deref(), Some("hello"), "{method}");
        }

        for method in [
            "realtime/audioDelta",
            "realtime/audio/delta",
            "thread/realtime/audioDelta",
            "thread/realtime/audio/delta",
            "thread/realtime/outputAudioDelta",
            "thread/realtime/outputAudio/delta",
        ] {
            let audio = normalize_provider_runtime_signal(RuntimeSignalNormalizationInput {
                provider: "future-provider".to_string(),
                method: method.to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "audio": "AAAA"
                }),
            })
            .expect("audio signal");
            assert_eq!(
                audio.kind,
                RuntimeSignalKind::RealtimeAudioDelta,
                "{method}"
            );
            assert_eq!(audio.audio.as_deref(), Some("AAAA"), "{method}");
        }

        let process = normalize_provider_runtime_signal(RuntimeSignalNormalizationInput {
            provider: "future-provider".to_string(),
            method: "process/exited".to_string(),
            params: json!({
                "processId": "proc-1",
                "exitCode": 2
            }),
        })
        .expect("process signal");
        assert_eq!(process.kind, RuntimeSignalKind::ProcessExited);
        assert_eq!(process.process_id.as_deref(), Some("proc-1"));
        assert_eq!(process.exit_code, Some(2));

        let resolved = normalize_provider_runtime_signal(RuntimeSignalNormalizationInput {
            provider: "future-provider".to_string(),
            method: "serverRequest/resolved".to_string(),
            params: json!({
                "requestId": "approval-1",
                "outcome": "approved"
            }),
        })
        .expect("server request resolved signal");
        assert_eq!(resolved.kind, RuntimeSignalKind::ServerRequestResolved);
        assert_eq!(resolved.request_id.as_deref(), Some("approval-1"));
        assert_eq!(resolved.status.as_deref(), Some("approved"));
    }
}

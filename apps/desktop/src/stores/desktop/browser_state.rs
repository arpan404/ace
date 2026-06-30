use super::{
    ArtifactItemProjection, BrowserActivityProjection, BrowserBridgeProjection,
    BrowserPreviewProjection, BrowserProjection,
};
use ace_core::ThreadId;
use ace_protocol::provider_runtime::{ProviderHostToolBridgeStatus, ProviderHostToolsListResponse};
use ace_runtime::tools::{SemanticToolCall, ToolRunStatus, ToolSurface};
use serde::Serialize;

pub(super) fn browser_projection_from_host_tools(
    response: &ProviderHostToolsListResponse,
    updated_at: String,
) -> BrowserProjection {
    let bridge = response
        .bridges
        .iter()
        .find(|bridge| bridge.surface == ToolSurface::Browser)
        .map(|bridge| BrowserBridgeProjection {
            status: match bridge.status {
                ProviderHostToolBridgeStatus::Connected => "connected",
                ProviderHostToolBridgeStatus::Unavailable => "unavailable",
                ProviderHostToolBridgeStatus::Missing => "missing",
            }
            .to_string(),
            descriptor_name: bridge.descriptor_name.clone(),
            aliases: bridge.aliases.clone(),
            actions: bridge
                .actions
                .iter()
                .map(|action| serde_name(*action))
                .collect(),
            capability_keys: bridge.capability_keys.clone(),
        });

    BrowserProjection {
        bridge,
        activities: Vec::new(),
        previews: Vec::new(),
        error: None,
        updated_at: Some(updated_at),
    }
}

pub(super) fn browser_activity_from_tool(
    thread_id: ThreadId,
    tool: &SemanticToolCall,
    sequence: Option<i64>,
    observed_at: String,
) -> BrowserActivityProjection {
    let id = tool
        .provider
        .item_id
        .clone()
        .or_else(|| {
            tool.provider
                .turn_id
                .as_ref()
                .map(|turn| format!("{turn}:browser"))
        })
        .or_else(|| sequence.map(|sequence| format!("browser-seq-{sequence}")))
        .unwrap_or_else(|| format!("browser-{}", stable_store_id(&tool.display.title)));
    let mut detail = tool
        .display
        .summary
        .clone()
        .unwrap_or_else(|| serde_name(tool.action));
    if let Some(operation) = tool.provider.operation.as_deref().filter(|operation| {
        !operation.trim().is_empty() && !detail.to_ascii_lowercase().contains(operation)
    }) {
        detail = format!("{detail} · {operation}");
    }
    BrowserActivityProjection {
        id,
        thread_id,
        title: tool.display.title.clone(),
        detail,
        target: tool
            .display
            .target
            .as_ref()
            .map(|target| target.label.clone()),
        status: tool_status_label(tool.display.status).to_string(),
        turn_id: tool.provider.turn_id.clone(),
        observed_at,
    }
}

pub(super) fn artifact_is_browser_preview(artifact: &ArtifactItemProjection) -> bool {
    artifact.kind.eq_ignore_ascii_case("image")
        || artifact
            .mime_type
            .as_deref()
            .is_some_and(|mime| mime.starts_with("image/"))
        || artifact.title.to_ascii_lowercase().contains("screenshot")
        || artifact.detail.to_ascii_lowercase().contains("screenshot")
}

pub(super) fn browser_preview_from_artifact(
    artifact: &ArtifactItemProjection,
) -> BrowserPreviewProjection {
    let location = artifact
        .url
        .clone()
        .or_else(|| artifact.path.clone())
        .unwrap_or_else(|| "provider attachment".to_string());
    BrowserPreviewProjection {
        id: artifact.id.clone(),
        title: artifact.title.clone(),
        detail: artifact.detail.clone(),
        location,
        mime_type: artifact.mime_type.clone(),
        observed_at: artifact.observed_at.clone(),
    }
}

pub(super) fn browser_activity_summary(activity: &BrowserActivityProjection) -> String {
    match activity.target.as_deref() {
        Some(target) if !target.trim().is_empty() => {
            format!("{} · {} · {target}", activity.status, activity.title)
        }
        _ => format!("{} · {}", activity.status, activity.title),
    }
}

fn tool_status_label(status: ToolRunStatus) -> &'static str {
    match status {
        ToolRunStatus::Started => "started",
        ToolRunStatus::Updated => "updated",
        ToolRunStatus::Completed => "completed",
        ToolRunStatus::Failed => "failed",
        ToolRunStatus::ApprovalRequested => "approval requested",
    }
}

fn serde_name<T: Serialize>(value: T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(ToString::to_string))
        .unwrap_or_else(|| "unknown".to_string())
}

fn stable_store_id(value: &str) -> u64 {
    value
        .bytes()
        .fold(14_695_981_039_346_656_037, |hash, byte| {
            hash.wrapping_mul(1_099_511_628_211) ^ u64::from(byte)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ace_runtime::tools::{
        ProviderToolMetadata, ToolActionKind, ToolDisplay, ToolTarget, ToolTargetKind,
        ToolTransport,
    };

    #[test]
    fn browser_projection_reads_bridge_summary() {
        let response = ProviderHostToolsListResponse {
            tools: Vec::new(),
            bridges: vec![
                ace_protocol::provider_runtime::ProviderHostToolBridgeSummary {
                    surface: ToolSurface::Browser,
                    status: ProviderHostToolBridgeStatus::Connected,
                    descriptor_name: Some("browser.bridge".to_string()),
                    aliases: vec!["ace_browser".to_string()],
                    actions: vec![
                        ToolActionKind::BrowserNavigate,
                        ToolActionKind::BrowserScreenshot,
                    ],
                    capability_keys: vec!["host_tool.bridge.status.connected".to_string()],
                },
            ],
        };

        let projection = browser_projection_from_host_tools(&response, "updated".to_string());
        let bridge = projection.bridge.expect("browser bridge");

        assert_eq!(bridge.status, "connected");
        assert_eq!(
            bridge.actions,
            vec!["browser.navigate", "browser.screenshot"]
        );
        assert_eq!(projection.updated_at.as_deref(), Some("updated"));
    }

    #[test]
    fn browser_activity_uses_provider_metadata_and_target() {
        let tool = SemanticToolCall {
            transport: ToolTransport::BrowserBridge,
            surface: ToolSurface::Browser,
            action: ToolActionKind::BrowserClick,
            display: ToolDisplay {
                title: "Click button".to_string(),
                summary: Some("Clicked primary button".to_string()),
                status: ToolRunStatus::Completed,
                icon_key: "browser".to_string(),
                technical_metadata: serde_json::Value::Null,
                target: Some(ToolTarget {
                    kind: ToolTargetKind::Text,
                    label: "Checkout".to_string(),
                }),
            },
            provider: ProviderToolMetadata {
                provider: Some("codex".to_string()),
                method: Some("item/tool/call".to_string()),
                item_id: None,
                turn_id: Some("turn-1".to_string()),
                thread_id: Some("thread-1".to_string()),
                server_name: Some("browser".to_string()),
                tool_name: Some("ace_browser".to_string()),
                operation: Some("button press".to_string()),
                raw_args: serde_json::Value::Null,
                raw_result: serde_json::Value::Null,
                raw_payload: serde_json::Value::Null,
            },
        };

        let activity = browser_activity_from_tool(
            ThreadId("thread-1".to_string()),
            &tool,
            Some(7),
            "now".to_string(),
        );

        assert_eq!(activity.id, "turn-1:browser");
        assert_eq!(activity.detail, "Clicked primary button · button press");
        assert_eq!(
            browser_activity_summary(&activity),
            "completed · Click button · Checkout"
        );
    }

    #[test]
    fn artifact_preview_prefers_url_then_path_then_provider_attachment() {
        let artifact = ArtifactItemProjection {
            id: "artifact-1".to_string(),
            thread_id: ThreadId("thread-1".to_string()),
            message_id: "message-1".to_string(),
            kind: "image".to_string(),
            title: "Screenshot".to_string(),
            detail: "image · provider attachment".to_string(),
            url: None,
            path: Some("screenshots/latest.png".to_string()),
            mime_type: Some("image/png".to_string()),
            observed_at: "now".to_string(),
        };

        assert!(artifact_is_browser_preview(&artifact));
        assert_eq!(
            browser_preview_from_artifact(&artifact).location,
            "screenshots/latest.png"
        );
    }
}

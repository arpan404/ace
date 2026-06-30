use super::{ApprovalItemProjection, ApprovalRegistryProjection};
use ace_protocol::provider_runtime::{ProviderRuntimeStateGetResponse, ProviderServerRequestAudit};
use ace_runtime::{
    provider::{NormalizedServerRequest, ServerRequestKind},
    threads::{ApprovalRecord, ApprovalStatus},
};

pub(super) fn approval_registry_projection_from_state(
    response: &ProviderRuntimeStateGetResponse,
    updated_at: String,
) -> ApprovalRegistryProjection {
    let mut pending = Vec::new();
    let mut resolved = 0;
    for provider in &response.providers {
        for approval in &provider.state.approvals {
            match approval.status {
                ApprovalStatus::Pending => pending.push(approval_item_projection(approval)),
                ApprovalStatus::Resolved => resolved += 1,
            }
        }
    }
    pending.sort_by(|left, right| {
        left.provider
            .cmp(&right.provider)
            .then_with(|| left.request_id.cmp(&right.request_id))
    });

    ApprovalRegistryProjection {
        pending,
        resolved,
        error: None,
        updated_at: Some(updated_at),
    }
}

fn approval_item_projection(approval: &ApprovalRecord) -> ApprovalItemProjection {
    approval_item_from_request(&approval.request)
}

pub(super) fn approval_item_from_request(
    request: &NormalizedServerRequest,
) -> ApprovalItemProjection {
    ApprovalItemProjection {
        provider: request.provider.provider.clone(),
        request_id: request.request_id.clone(),
        title: request
            .title
            .clone()
            .unwrap_or_else(|| server_request_kind_label(request.kind).to_string()),
        prompt: request
            .prompt
            .clone()
            .or_else(|| approval_detail_label(request))
            .unwrap_or_else(|| "Provider request is awaiting a decision.".to_string()),
        kind: server_request_kind_label(request.kind).to_string(),
        method: request.method.clone(),
        scope: request.scope.clone(),
        selected_policy: request.selected_policy.clone(),
        detail: approval_detail_label(request),
    }
}

pub(super) fn approval_audit(reason: &'static str) -> ProviderServerRequestAudit {
    ProviderServerRequestAudit {
        decided_by: Some("user".to_string()),
        reason: Some(reason.to_string()),
        metadata: serde_json::json!({ "surface": "desktop" }),
        ..ProviderServerRequestAudit::default()
    }
}

fn server_request_kind_label(kind: ServerRequestKind) -> &'static str {
    match kind {
        ServerRequestKind::CommandApproval => "Command approval",
        ServerRequestKind::FileChangeApproval => "File change approval",
        ServerRequestKind::ToolUserInput => "Tool input",
        ServerRequestKind::McpElicitation => "MCP elicitation",
        ServerRequestKind::PermissionApproval => "Permission approval",
        ServerRequestKind::DynamicToolCall => "Dynamic tool",
        ServerRequestKind::AccountTokenRefresh => "Account token refresh",
        ServerRequestKind::Attestation => "Attestation",
        ServerRequestKind::ApplyPatchApproval => "Patch approval",
        ServerRequestKind::ExecApproval => "Command approval",
        ServerRequestKind::Unknown => "Provider request",
    }
}

fn approval_detail_label(request: &NormalizedServerRequest) -> Option<String> {
    request
        .detail
        .command
        .clone()
        .or_else(|| request.detail.argv.as_ref().map(|argv| argv.join(" ")))
        .or_else(|| request.detail.path.clone())
        .or_else(|| request.detail.paths.as_ref().map(|paths| paths.join(", ")))
        .or_else(|| request.detail.tool_name.clone())
        .or_else(|| request.detail.server_name.clone())
        .or_else(|| request.detail.operation.clone())
        .or_else(|| request.detail.permission.clone())
        .or_else(|| request.detail.resource.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ace_runtime::provider::{ProviderMetadata, ServerRequestDetail};

    fn request(kind: ServerRequestKind) -> NormalizedServerRequest {
        NormalizedServerRequest {
            kind,
            request_id: "request-1".to_string(),
            method: "provider/request".to_string(),
            thread_id: Some("thread-1".to_string()),
            turn_id: Some("turn-1".to_string()),
            item_id: Some("item-1".to_string()),
            scope: Some("workspace".to_string()),
            title: None,
            prompt: None,
            selected_policy: Some("on-request".to_string()),
            detail: ServerRequestDetail {
                argv: Some(vec!["cargo".to_string(), "test".to_string()]),
                ..ServerRequestDetail::default()
            },
            metadata: serde_json::Value::Null,
            provider: ProviderMetadata {
                provider: "codex".to_string(),
                method: Some("provider/request".to_string()),
                schema_version: None,
                raw_payload: serde_json::Value::Null,
            },
        }
    }

    #[test]
    fn approval_item_uses_kind_and_detail_when_title_and_prompt_are_missing() {
        let item = approval_item_from_request(&request(ServerRequestKind::ExecApproval));

        assert_eq!(item.title, "Command approval");
        assert_eq!(item.prompt, "cargo test");
        assert_eq!(item.kind, "Command approval");
        assert_eq!(item.detail.as_deref(), Some("cargo test"));
        assert_eq!(item.selected_policy.as_deref(), Some("on-request"));
    }

    #[test]
    fn approval_audit_marks_user_decision_from_desktop_surface() {
        let audit = approval_audit("approved from desktop");

        assert_eq!(audit.decided_by.as_deref(), Some("user"));
        assert_eq!(audit.reason.as_deref(), Some("approved from desktop"));
        assert_eq!(audit.metadata["surface"], "desktop");
    }
}

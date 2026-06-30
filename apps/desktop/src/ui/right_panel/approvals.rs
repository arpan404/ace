use crate::{
    actions::{ApproveProviderRequest, DenyProviderRequest, RefreshApprovals},
    stores::{ApprovalItemProjection, ApprovalRegistryProjection, DesktopProjection},
    ui::{components::*, theme::Theme},
};
use gpui::{AnyElement, IntoElement, div, prelude::*, px};
use gpui_component::{IconName, scroll::ScrollableElement as _};

use super::{clamp_text, info_row, registry_error_card};

pub(super) fn approvals_body(theme: Theme, projection: &DesktopProjection) -> AnyElement {
    let approvals = &projection.approvals;
    div()
        .size_full()
        .flex()
        .flex_col()
        .gap_3()
        .child(info_row(
            theme,
            "Pending",
            &approvals.pending.len().to_string(),
        ))
        .child(info_row(theme, "Resolved", &approvals.resolved.to_string()))
        .when_some(approvals.updated_at.as_deref(), |this, updated| {
            this.child(info_row(theme, "Updated", updated))
        })
        .child(approval_actions(theme))
        .when_some(approvals.error.as_deref(), |this, error| {
            this.child(registry_error_card(theme, error))
        })
        .child(approval_list(theme, approvals))
        .into_any_element()
}

fn approval_actions(theme: Theme) -> AnyElement {
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .child(action_button(IconName::Info, "Refresh", theme, || {
            Box::new(RefreshApprovals)
        }))
        .into_any_element()
}

fn approval_list(theme: Theme, approvals: &ApprovalRegistryProjection) -> AnyElement {
    if approvals.pending.is_empty() {
        return div()
            .rounded_md()
            .border_1()
            .border_color(theme.border_subtle)
            .bg(theme.panel)
            .px_2()
            .py_2()
            .text_size(px(12.0))
            .text_color(theme.muted)
            .child("No pending approvals")
            .into_any_element();
    }

    div()
        .flex_1()
        .min_h_0()
        .flex()
        .flex_col()
        .gap_2()
        .children(
            approvals
                .pending
                .iter()
                .map(|approval| approval_card(theme, approval))
                .collect::<Vec<_>>(),
        )
        .overflow_y_scrollbar()
        .into_any_element()
}

fn approval_card(theme: Theme, approval: &ApprovalItemProjection) -> AnyElement {
    let provider = approval.provider.clone();
    let request_id = approval.request_id.clone();
    let deny_provider = provider.clone();
    let deny_request_id = request_id.clone();

    div()
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel)
        .p_2()
        .flex()
        .flex_col()
        .gap_2()
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap_2()
                .text_size(px(12.0))
                .text_color(theme.foreground.opacity(0.84))
                .child(icon_svg(IconName::Bell, theme.accent_warning))
                .child(clamp_text(&approval.title, 130)),
        )
        .child(
            div()
                .text_size(px(11.0))
                .line_height(px(16.0))
                .text_color(theme.foreground.opacity(0.74))
                .child(clamp_text(&approval.prompt, 220)),
        )
        .when_some(approval.detail.as_deref(), |this, detail| {
            this.child(
                div()
                    .font_family(theme.code_font_family)
                    .text_size(px(11.0))
                    .line_height(px(16.0))
                    .text_color(theme.muted)
                    .child(clamp_text(detail, 180)),
            )
        })
        .child(
            div()
                .text_size(px(11.0))
                .line_height(px(16.0))
                .text_color(theme.muted_subtle)
                .child(approval_meta(approval)),
        )
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap_2()
                .child(action_button(
                    IconName::ThumbsUp,
                    "Approve",
                    theme,
                    move || {
                        Box::new(ApproveProviderRequest {
                            provider: provider.clone(),
                            request_id: request_id.clone(),
                        })
                    },
                ))
                .child(action_button(
                    IconName::ThumbsDown,
                    "Deny",
                    theme,
                    move || {
                        Box::new(DenyProviderRequest {
                            provider: deny_provider.clone(),
                            request_id: deny_request_id.clone(),
                        })
                    },
                )),
        )
        .into_any_element()
}

fn approval_meta(approval: &ApprovalItemProjection) -> String {
    let mut parts = vec![
        approval.provider.clone(),
        approval.kind.clone(),
        approval.method.clone(),
    ];
    if let Some(scope) = approval.scope.as_deref() {
        parts.push(scope.to_string());
    }
    if let Some(policy) = approval.selected_policy.as_deref() {
        parts.push(policy.to_string());
    }
    parts.push(format!("request {}", approval.request_id));
    parts.join(" · ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_meta_includes_scope_policy_and_request() {
        let approval = ApprovalItemProjection {
            provider: "codex".to_string(),
            request_id: "req-1".to_string(),
            kind: "command".to_string(),
            method: "shell.exec".to_string(),
            title: "Run command".to_string(),
            prompt: "cargo test".to_string(),
            detail: Some("workspace".to_string()),
            scope: Some("project".to_string()),
            selected_policy: Some("ask".to_string()),
        };

        assert_eq!(
            approval_meta(&approval),
            "codex · command · shell.exec · project · ask · request req-1"
        );
    }

    #[test]
    fn approval_meta_omits_missing_optional_fields() {
        let approval = ApprovalItemProjection {
            provider: "codex".to_string(),
            request_id: "req-2".to_string(),
            kind: "tool".to_string(),
            method: "browser.open".to_string(),
            title: "Open browser".to_string(),
            prompt: "Preview app".to_string(),
            detail: None,
            scope: None,
            selected_policy: None,
        };

        assert_eq!(
            approval_meta(&approval),
            "codex · tool · browser.open · request req-2"
        );
    }
}

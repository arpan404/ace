use ace_core::{ModelSelection, ProviderKind};
use ace_runtime::chat::{
    ComposerContextKind, ComposerDraft, ComposerPermissionMode, ComposerTrait, InteractionMode,
    RuntimeMode,
};

pub(super) struct PermissionPayload {
    pub(super) sandbox_policy: serde_json::Value,
    pub(super) approval_policy: serde_json::Value,
    pub(super) approvals_reviewer: Option<&'static str>,
}

pub(super) fn model_selection_label(selection: &ModelSelection) -> String {
    ProviderKind::from_runtime_id(&selection.provider).map_or_else(
        || format!("{} · {}", selection.provider, selection.model),
        |provider| format!("{} · {}", provider.display_name(), selection.model),
    )
}

pub(super) fn composer_status_line(draft: &ComposerDraft) -> String {
    let host = draft.host_selection.as_ref().map_or_else(
        || "This computer".to_string(),
        |host| format!("{}:{}", host.provider, host.host_id),
    );
    let reasoning = draft
        .reasoning_effort
        .map_or("No reasoning".to_string(), |effort| {
            format!("{} reasoning", effort.label())
        });
    let traits = if draft.traits.is_empty() {
        "No traits".to_string()
    } else {
        draft
            .traits
            .iter()
            .map(|trait_kind| trait_kind.label())
            .collect::<Vec<_>>()
            .join(", ")
    };
    let context = if draft.context.is_empty() {
        "No context".to_string()
    } else {
        draft
            .context
            .iter()
            .map(|context| context.label())
            .collect::<Vec<_>>()
            .join(", ")
    };
    format!(
        "{} {} · {} · {} · {} · {} · {}",
        interaction_mode_label(draft.interaction_mode),
        runtime_mode_label(draft.runtime_mode),
        draft.model_selection.model,
        draft.permission_mode.label(),
        reasoning,
        host,
        if traits == "No traits" && context == "No context" {
            "No extra context".to_string()
        } else {
            format!("{traits} · {context}")
        }
    )
}

pub(super) fn copy_composer_turn_settings(target: &mut ComposerDraft, source: &ComposerDraft) {
    target.model_selection = source.model_selection.clone();
    target.host_selection = source.host_selection.clone();
    target.reasoning_effort = source.reasoning_effort;
    target.permission_mode = source.permission_mode;
    target.traits = source.traits.clone();
    target.context = source.context.clone();
    target.runtime_mode = source.runtime_mode;
    target.interaction_mode = source.interaction_mode;
}

pub(super) fn composer_traits_text(traits: &[ComposerTrait]) -> Option<String> {
    if traits.is_empty() {
        return None;
    }

    let instructions = traits
        .iter()
        .map(|trait_kind| format!("- {}: {}", trait_kind.label(), trait_kind.instruction()))
        .collect::<Vec<_>>()
        .join("\n");

    Some(format!(
        "Agent traits selected for this turn:\n{instructions}\nFollow these traits unless they conflict with higher-priority system, developer, or user instructions."
    ))
}

pub(super) fn permission_payload(permission: ComposerPermissionMode) -> PermissionPayload {
    match permission {
        ComposerPermissionMode::Strict => PermissionPayload {
            sandbox_policy: serde_json::json!({
                "mode": "read-only",
                "networkAccess": "restricted",
            }),
            approval_policy: serde_json::json!({ "mode": "on-request" }),
            approvals_reviewer: Some("user"),
        },
        ComposerPermissionMode::Auto => PermissionPayload {
            sandbox_policy: serde_json::json!({
                "mode": "workspace-write",
                "networkAccess": "restricted",
            }),
            approval_policy: serde_json::json!({ "mode": "on-request" }),
            approvals_reviewer: Some("user"),
        },
        ComposerPermissionMode::AutoReview => PermissionPayload {
            sandbox_policy: serde_json::json!({
                "mode": "workspace-write",
                "networkAccess": "restricted",
            }),
            approval_policy: serde_json::json!({ "mode": "on-request" }),
            approvals_reviewer: Some("auto_review"),
        },
        ComposerPermissionMode::FullAccess => PermissionPayload {
            sandbox_policy: serde_json::json!({
                "mode": "danger-full-access",
                "networkAccess": "enabled",
            }),
            approval_policy: serde_json::json!({ "mode": "never" }),
            approvals_reviewer: None,
        },
    }
}

pub(super) fn composer_collaboration_mode(
    draft: &ComposerDraft,
    reasoning_effort: Option<&'static str>,
    permissions: &PermissionPayload,
) -> serde_json::Value {
    let mut settings = serde_json::json!({
        "model": draft.model_selection.model,
        "model_provider": draft.model_selection.provider.runtime_id(),
        "reasoning_effort": reasoning_effort,
        "interaction_mode": interaction_mode_value(draft.interaction_mode),
        "runtime_mode": runtime_mode_value(draft.runtime_mode),
        "permission_mode": permission_mode_value(draft.permission_mode),
        "sandbox_policy": permissions.sandbox_policy,
        "approval_policy": permissions.approval_policy,
        "approvals_reviewer": permissions.approvals_reviewer,
        "traits": draft
            .traits
            .iter()
            .map(|trait_kind| composer_trait_value(*trait_kind))
            .collect::<Vec<_>>(),
        "context": draft
            .context
            .iter()
            .map(|context| composer_context_value(*context))
            .collect::<Vec<_>>(),
        "developer_instructions": null,
    });

    if let Some(host) = draft.host_selection.as_ref() {
        settings["host"] = serde_json::json!({
            "provider": host.provider,
            "host_id": host.host_id,
        });
    }

    serde_json::json!({
        "mode": if draft.interaction_mode == InteractionMode::Plan {
            "plan"
        } else {
            "default"
        },
        "settings": settings,
    })
}

pub(super) fn toggle_vec_value<T: Copy + PartialEq>(values: &mut Vec<T>, value: T) {
    if let Some(index) = values.iter().position(|candidate| *candidate == value) {
        values.remove(index);
    } else {
        values.push(value);
    }
}

fn interaction_mode_label(mode: InteractionMode) -> &'static str {
    match mode {
        InteractionMode::Chat => "Chat",
        InteractionMode::Plan => "Plan",
    }
}

fn runtime_mode_label(mode: RuntimeMode) -> &'static str {
    match mode {
        RuntimeMode::Normal => "normal",
        RuntimeMode::Local => "local",
        RuntimeMode::Worktree => "worktree",
        RuntimeMode::Remote => "remote",
    }
}

fn interaction_mode_value(mode: InteractionMode) -> &'static str {
    match mode {
        InteractionMode::Chat => "chat",
        InteractionMode::Plan => "plan",
    }
}

fn runtime_mode_value(mode: RuntimeMode) -> &'static str {
    match mode {
        RuntimeMode::Normal => "normal",
        RuntimeMode::Local => "local",
        RuntimeMode::Worktree => "worktree",
        RuntimeMode::Remote => "remote",
    }
}

fn permission_mode_value(permission: ComposerPermissionMode) -> &'static str {
    match permission {
        ComposerPermissionMode::Strict => "strict",
        ComposerPermissionMode::Auto => "auto",
        ComposerPermissionMode::AutoReview => "auto_review",
        ComposerPermissionMode::FullAccess => "full_access",
    }
}

fn composer_trait_value(trait_kind: ComposerTrait) -> &'static str {
    match trait_kind {
        ComposerTrait::Precise => "precise",
        ComposerTrait::Fast => "fast",
        ComposerTrait::TestFocused => "test_focused",
        ComposerTrait::ReviewFocused => "review_focused",
    }
}

fn composer_context_value(context: ComposerContextKind) -> &'static str {
    match context {
        ComposerContextKind::Pinned => "pinned",
        ComposerContextKind::Highlights => "highlights",
        ComposerContextKind::Todos => "todos",
        ComposerContextKind::Terminal => "terminal",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ace_runtime::chat::{ComposerHostSelection, ProviderModelSelection, ReasoningEffort};

    #[test]
    fn composer_traits_text_lists_selected_trait_instructions() {
        assert_eq!(composer_traits_text(&[]), None);
        let text = composer_traits_text(&[ComposerTrait::Precise, ComposerTrait::TestFocused])
            .expect("traits text");

        assert!(text.contains("- Precise:"));
        assert!(text.contains("- Tested:"));
        assert!(text.contains("Follow these traits"));
    }

    #[test]
    fn toggle_vec_value_removes_existing_or_appends_new_value() {
        let mut traits = vec![ComposerTrait::Precise, ComposerTrait::Fast];

        toggle_vec_value(&mut traits, ComposerTrait::Precise);
        assert_eq!(traits, vec![ComposerTrait::Fast]);

        toggle_vec_value(&mut traits, ComposerTrait::ReviewFocused);
        assert_eq!(
            traits,
            vec![ComposerTrait::Fast, ComposerTrait::ReviewFocused]
        );
    }

    #[test]
    fn composer_status_line_summarizes_turn_settings() {
        let mut draft = ComposerDraft::empty(ace_core::ThreadId::new(), "now".to_string());
        draft.runtime_mode = RuntimeMode::Remote;
        draft.interaction_mode = InteractionMode::Plan;
        draft.reasoning_effort = Some(ReasoningEffort::High);
        draft.permission_mode = ComposerPermissionMode::AutoReview;
        draft.traits = vec![ComposerTrait::Precise];
        draft.context = vec![ComposerContextKind::Todos];
        draft.host_selection = Some(ComposerHostSelection {
            provider: "ssh".to_string(),
            host_id: "prod".to_string(),
        });
        draft.model_selection = ProviderModelSelection {
            provider: ProviderKind::Codex,
            model: "gpt-5".to_string(),
        };

        assert_eq!(
            composer_status_line(&draft),
            "Plan remote · gpt-5 · Auto review · High reasoning · ssh:prod · Precise · Todos"
        );
    }
}

use ace_runtime::provider::{
    ProviderFeature, ProviderFeatureCategory, ProviderFeatureDirection, ProviderFeatureSupport,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexMethodDirection {
    ClientRequest,
    ClientNotification,
    ServerNotification,
    ServerRequest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexMethodSupport {
    TypedSupported,
    RawSupported,
    VersionGated,
    IntentionallyDeferred,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct CodexMethodSpec {
    pub method: &'static str,
    pub direction: CodexMethodDirection,
    pub support: CodexMethodSupport,
}

impl CodexMethodSpec {
    #[must_use]
    pub const fn new(
        method: &'static str,
        direction: CodexMethodDirection,
        support: CodexMethodSupport,
    ) -> Self {
        Self {
            method,
            direction,
            support,
        }
    }
}

use CodexMethodDirection::{ClientNotification, ClientRequest, ServerNotification, ServerRequest};
use CodexMethodSupport::{IntentionallyDeferred, RawSupported, TypedSupported, VersionGated};

pub const CODEX_METHOD_INVENTORY: &[CodexMethodSpec] = &[
    CodexMethodSpec::new("initialize", ClientRequest, TypedSupported),
    CodexMethodSpec::new("initialized", ClientNotification, TypedSupported),
    CodexMethodSpec::new("thread/start", ClientRequest, TypedSupported),
    CodexMethodSpec::new("thread/resume", ClientRequest, TypedSupported),
    CodexMethodSpec::new("thread/fork", ClientRequest, TypedSupported),
    CodexMethodSpec::new("thread/read", ClientRequest, TypedSupported),
    CodexMethodSpec::new("thread/list", ClientRequest, TypedSupported),
    CodexMethodSpec::new("thread/loadedList", ClientRequest, TypedSupported),
    CodexMethodSpec::new("thread/archive", ClientRequest, TypedSupported),
    CodexMethodSpec::new("thread/unarchive", ClientRequest, TypedSupported),
    CodexMethodSpec::new("thread/delete", ClientRequest, TypedSupported),
    CodexMethodSpec::new("thread/unsubscribe", ClientRequest, TypedSupported),
    CodexMethodSpec::new("thread/setName", ClientRequest, TypedSupported),
    CodexMethodSpec::new("thread/updateMetadata", ClientRequest, TypedSupported),
    CodexMethodSpec::new("thread/compact", ClientRequest, TypedSupported),
    CodexMethodSpec::new("thread/rollback", ClientRequest, TypedSupported),
    CodexMethodSpec::new("thread/injectItems", ClientRequest, TypedSupported),
    CodexMethodSpec::new(
        "thread/approveGuardianDeniedAction",
        ClientRequest,
        TypedSupported,
    ),
    CodexMethodSpec::new("thread/handoffToAgent", ClientRequest, TypedSupported),
    CodexMethodSpec::new("turn/start", ClientRequest, TypedSupported),
    CodexMethodSpec::new("turn/interrupt", ClientRequest, TypedSupported),
    CodexMethodSpec::new("configRequirements/read", ClientRequest, TypedSupported),
    CodexMethodSpec::new("permissionProfile/list", ClientRequest, TypedSupported),
    CodexMethodSpec::new("goal/set", ClientRequest, TypedSupported),
    CodexMethodSpec::new("goal/get", ClientRequest, TypedSupported),
    CodexMethodSpec::new("goal/clear", ClientRequest, TypedSupported),
    CodexMethodSpec::new("goal/pause", ClientRequest, TypedSupported),
    CodexMethodSpec::new("goal/resume", ClientRequest, TypedSupported),
    CodexMethodSpec::new("subagent/list", ClientRequest, TypedSupported),
    CodexMethodSpec::new("subagent/read", ClientRequest, TypedSupported),
    CodexMethodSpec::new("subagent/steer", ClientRequest, TypedSupported),
    CodexMethodSpec::new("subagent/stop", ClientRequest, TypedSupported),
    CodexMethodSpec::new("subagent/close", ClientRequest, TypedSupported),
    CodexMethodSpec::new("review/start", ClientRequest, VersionGated),
    CodexMethodSpec::new("command/exec", ClientRequest, VersionGated),
    CodexMethodSpec::new("command/writeStdin", ClientRequest, VersionGated),
    CodexMethodSpec::new("command/resize", ClientRequest, VersionGated),
    CodexMethodSpec::new("command/terminate", ClientRequest, VersionGated),
    CodexMethodSpec::new("process/list", ClientRequest, VersionGated),
    CodexMethodSpec::new("process/clean", ClientRequest, VersionGated),
    CodexMethodSpec::new("mcp/status", ClientRequest, VersionGated),
    CodexMethodSpec::new("mcp/resourceRead", ClientRequest, VersionGated),
    CodexMethodSpec::new("mcp/oauthLogin", ClientRequest, VersionGated),
    CodexMethodSpec::new("mcp/toolCall", ClientRequest, VersionGated),
    CodexMethodSpec::new("skills/list", ClientRequest, VersionGated),
    CodexMethodSpec::new("skills/read", ClientRequest, VersionGated),
    CodexMethodSpec::new("skills/install", ClientRequest, VersionGated),
    CodexMethodSpec::new("plugins/list", ClientRequest, VersionGated),
    CodexMethodSpec::new("plugins/install", ClientRequest, VersionGated),
    CodexMethodSpec::new("apps/list", ClientRequest, VersionGated),
    CodexMethodSpec::new("apps/configWrite", ClientRequest, VersionGated),
    CodexMethodSpec::new("remote/connectionList", ClientRequest, VersionGated),
    CodexMethodSpec::new("remote/handoff", ClientRequest, VersionGated),
    CodexMethodSpec::new("cloud/threadStart", ClientRequest, IntentionallyDeferred),
    CodexMethodSpec::new("cloud/handoff", ClientRequest, IntentionallyDeferred),
    CodexMethodSpec::new("turn/started", ServerNotification, TypedSupported),
    CodexMethodSpec::new("turn/startedStreaming", ServerNotification, TypedSupported),
    CodexMethodSpec::new("turn/completed", ServerNotification, TypedSupported),
    CodexMethodSpec::new("turn/failed", ServerNotification, TypedSupported),
    CodexMethodSpec::new("turn/interrupted", ServerNotification, TypedSupported),
    CodexMethodSpec::new("turn/cancelled", ServerNotification, TypedSupported),
    CodexMethodSpec::new("turn/plan/updated", ServerNotification, TypedSupported),
    CodexMethodSpec::new("item/started", ServerNotification, TypedSupported),
    CodexMethodSpec::new("item/updated", ServerNotification, TypedSupported),
    CodexMethodSpec::new("item/completed", ServerNotification, TypedSupported),
    CodexMethodSpec::new("item/failed", ServerNotification, TypedSupported),
    CodexMethodSpec::new(
        "item/assistantMessage/delta",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new("item/reasoning/delta", ServerNotification, TypedSupported),
    CodexMethodSpec::new("item/plan/delta", ServerNotification, TypedSupported),
    CodexMethodSpec::new(
        "item/commandExecution/outputDelta",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new(
        "item/fileChange/patchDelta",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new(
        "item/mcpToolCall/progress",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new(
        "item/dynamicToolCall/progress",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new(
        "item/collabAgentToolCall/progress",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new("process/outputDelta", ServerNotification, TypedSupported),
    CodexMethodSpec::new("model/rerouted", ServerNotification, RawSupported),
    CodexMethodSpec::new("warning", ServerNotification, RawSupported),
    CodexMethodSpec::new("realtime/transcriptDelta", ServerNotification, VersionGated),
    CodexMethodSpec::new("realtime/audioDelta", ServerNotification, VersionGated),
    CodexMethodSpec::new("command/approvalRequest", ServerRequest, RawSupported),
    CodexMethodSpec::new("fileChange/approvalRequest", ServerRequest, RawSupported),
    CodexMethodSpec::new("tool/userInputRequest", ServerRequest, RawSupported),
    CodexMethodSpec::new("mcp/elicitation", ServerRequest, RawSupported),
    CodexMethodSpec::new("permission/approvalRequest", ServerRequest, RawSupported),
    CodexMethodSpec::new("dynamicTool/call", ServerRequest, RawSupported),
    CodexMethodSpec::new("account/tokenRefresh", ServerRequest, RawSupported),
    CodexMethodSpec::new("attestation/request", ServerRequest, RawSupported),
    CodexMethodSpec::new("applyPatch/approvalRequest", ServerRequest, RawSupported),
    CodexMethodSpec::new("exec/approvalRequest", ServerRequest, RawSupported),
];

#[must_use]
pub fn codex_method_inventory() -> &'static [CodexMethodSpec] {
    CODEX_METHOD_INVENTORY
}

#[must_use]
pub fn classify_codex_method(
    method: &str,
    direction: CodexMethodDirection,
) -> Option<CodexMethodSupport> {
    CODEX_METHOD_INVENTORY
        .iter()
        .find(|spec| spec.method == method && spec.direction == direction)
        .map(|spec| spec.support)
}

#[must_use]
pub fn codex_provider_features() -> Vec<ProviderFeature> {
    let mut features = CODEX_METHOD_INVENTORY
        .iter()
        .map(|spec| ProviderFeature {
            key: format!("codex.method.{}", spec.method.replace('/', ".")),
            display_name: codex_method_display_name(spec.method),
            category: codex_method_category(spec.method, spec.direction),
            support: codex_method_support(spec.support),
            direction: Some(codex_method_direction(spec.direction)),
            provider_method: Some(spec.method.to_string()),
            capability: None,
        })
        .collect::<Vec<_>>();
    features.extend(codex_execution_location_features());
    features
}

#[must_use]
pub fn codex_execution_location_features() -> Vec<ProviderFeature> {
    [
        (
            "codex.execution_location.local",
            "Local execution",
            ProviderFeatureCategory::Handoff,
            ProviderFeatureSupport::Native,
            None,
        ),
        (
            "codex.execution_location.worktree",
            "Worktree execution",
            ProviderFeatureCategory::Handoff,
            ProviderFeatureSupport::Native,
            Some("codex.handoff.to_location"),
        ),
        (
            "codex.execution_location.remote_host",
            "Remote host execution",
            ProviderFeatureCategory::Remote,
            ProviderFeatureSupport::VersionGated,
            Some("remote/handoff"),
        ),
        (
            "codex.execution_location.cloud",
            "Cloud execution",
            ProviderFeatureCategory::Cloud,
            ProviderFeatureSupport::Deferred,
            Some("cloud/handoff"),
        ),
    ]
    .into_iter()
    .map(
        |(key, display_name, category, support, provider_method)| ProviderFeature {
            key: key.to_string(),
            display_name: display_name.to_string(),
            category,
            support,
            direction: Some(ProviderFeatureDirection::Internal),
            provider_method: provider_method.map(ToString::to_string),
            capability: None,
        },
    )
    .collect()
}

fn codex_method_direction(direction: CodexMethodDirection) -> ProviderFeatureDirection {
    match direction {
        CodexMethodDirection::ClientRequest => ProviderFeatureDirection::ClientRequest,
        CodexMethodDirection::ClientNotification => ProviderFeatureDirection::ClientNotification,
        CodexMethodDirection::ServerNotification => ProviderFeatureDirection::ServerNotification,
        CodexMethodDirection::ServerRequest => ProviderFeatureDirection::ServerRequest,
    }
}

fn codex_method_support(support: CodexMethodSupport) -> ProviderFeatureSupport {
    match support {
        CodexMethodSupport::TypedSupported => ProviderFeatureSupport::Typed,
        CodexMethodSupport::RawSupported => ProviderFeatureSupport::Raw,
        CodexMethodSupport::VersionGated => ProviderFeatureSupport::VersionGated,
        CodexMethodSupport::IntentionallyDeferred => ProviderFeatureSupport::Deferred,
    }
}

fn codex_method_category(method: &str, direction: CodexMethodDirection) -> ProviderFeatureCategory {
    if direction == CodexMethodDirection::ServerRequest {
        return ProviderFeatureCategory::ServerRequests;
    }
    match method.split('/').next().unwrap_or_default() {
        "thread" => {
            if method.contains("handoff") {
                ProviderFeatureCategory::Handoff
            } else {
                ProviderFeatureCategory::Threads
            }
        }
        "turn" => {
            if method.contains("/plan/") {
                ProviderFeatureCategory::Plans
            } else {
                ProviderFeatureCategory::Turns
            }
        }
        "goal" => ProviderFeatureCategory::Goals,
        "subagent" => ProviderFeatureCategory::Subagents,
        "review" => ProviderFeatureCategory::Tools,
        "command" | "process" | "tool" | "dynamicTool" | "applyPatch" | "exec" => {
            ProviderFeatureCategory::Tools
        }
        "mcp" => ProviderFeatureCategory::Mcp,
        "skills" => ProviderFeatureCategory::Skills,
        "plugins" => ProviderFeatureCategory::Plugins,
        "apps" => ProviderFeatureCategory::Apps,
        "remote" => {
            if method.contains("handoff") {
                ProviderFeatureCategory::Handoff
            } else {
                ProviderFeatureCategory::Remote
            }
        }
        "cloud" => ProviderFeatureCategory::Cloud,
        "configRequirements" | "permissionProfile" | "permission" => {
            ProviderFeatureCategory::Permissions
        }
        "item" => {
            if method.contains("/plan/") {
                ProviderFeatureCategory::Plans
            } else {
                ProviderFeatureCategory::Events
            }
        }
        "model" | "warning" | "realtime" => ProviderFeatureCategory::Events,
        "account" | "attestation" => ProviderFeatureCategory::Diagnostics,
        _ => ProviderFeatureCategory::Unknown,
    }
}

fn codex_method_display_name(method: &str) -> String {
    method
        .split('/')
        .map(|part| {
            part.chars()
                .enumerate()
                .fold(String::new(), |mut label, (index, ch)| {
                    if index > 0 && ch.is_uppercase() {
                        label.push(' ');
                    }
                    label.push(ch);
                    label
                })
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn inventory_classifies_every_known_method_once_per_direction() {
        let mut seen = HashSet::new();
        for spec in CODEX_METHOD_INVENTORY {
            assert!(
                seen.insert((spec.method, spec.direction)),
                "duplicate Codex method inventory entry for {} {:?}",
                spec.method,
                spec.direction
            );
        }
        assert!(
            CODEX_METHOD_INVENTORY
                .iter()
                .all(|spec| !spec.method.is_empty())
        );
    }

    #[test]
    fn inventory_covers_required_codex_parity_groups() {
        assert_eq!(
            classify_codex_method("thread/start", ClientRequest),
            Some(TypedSupported)
        );
        assert_eq!(
            classify_codex_method("subagent/steer", ClientRequest),
            Some(TypedSupported)
        );
        assert_eq!(
            classify_codex_method("remote/handoff", ClientRequest),
            Some(VersionGated)
        );
        assert_eq!(
            classify_codex_method("cloud/handoff", ClientRequest),
            Some(IntentionallyDeferred)
        );
        assert_eq!(
            classify_codex_method("command/approvalRequest", ServerRequest),
            Some(RawSupported)
        );
        assert_eq!(
            classify_codex_method("item/plan/delta", ServerNotification),
            Some(TypedSupported)
        );
    }

    #[test]
    fn inventory_keeps_all_support_classes_represented() {
        for support in [
            TypedSupported,
            RawSupported,
            VersionGated,
            IntentionallyDeferred,
        ] {
            assert!(
                CODEX_METHOD_INVENTORY
                    .iter()
                    .any(|spec| spec.support == support),
                "missing support class {support:?}"
            );
        }
    }

    #[test]
    fn provider_features_preserve_method_support_and_categories() {
        let features = codex_provider_features();
        let plan = features
            .iter()
            .find(|feature| feature.provider_method.as_deref() == Some("turn/plan/updated"))
            .expect("plan feature");
        assert_eq!(plan.category, ProviderFeatureCategory::Plans);
        assert_eq!(plan.support, ProviderFeatureSupport::Typed);
        assert_eq!(
            plan.direction,
            Some(ProviderFeatureDirection::ServerNotification)
        );

        let remote = features
            .iter()
            .find(|feature| feature.provider_method.as_deref() == Some("remote/handoff"))
            .expect("remote handoff feature");
        assert_eq!(remote.category, ProviderFeatureCategory::Handoff);
        assert_eq!(remote.support, ProviderFeatureSupport::VersionGated);

        let cloud = features
            .iter()
            .find(|feature| feature.provider_method.as_deref() == Some("cloud/handoff"))
            .expect("cloud handoff feature");
        assert_eq!(cloud.support, ProviderFeatureSupport::Deferred);

        let local_location = features
            .iter()
            .find(|feature| feature.key == "codex.execution_location.local")
            .expect("local execution location feature");
        assert_eq!(local_location.category, ProviderFeatureCategory::Handoff);
        assert_eq!(local_location.support, ProviderFeatureSupport::Native);
        assert_eq!(
            local_location.direction,
            Some(ProviderFeatureDirection::Internal)
        );
        assert!(local_location.provider_method.is_none());

        let worktree_location = features
            .iter()
            .find(|feature| feature.key == "codex.execution_location.worktree")
            .expect("worktree execution location feature");
        assert_eq!(worktree_location.category, ProviderFeatureCategory::Handoff);
        assert_eq!(worktree_location.support, ProviderFeatureSupport::Native);
        assert_eq!(
            worktree_location.provider_method.as_deref(),
            Some("codex.handoff.to_location")
        );

        let remote_location = features
            .iter()
            .find(|feature| feature.key == "codex.execution_location.remote_host")
            .expect("remote execution location feature");
        assert_eq!(remote_location.category, ProviderFeatureCategory::Remote);
        assert_eq!(
            remote_location.support,
            ProviderFeatureSupport::VersionGated
        );

        let cloud_location = features
            .iter()
            .find(|feature| feature.key == "codex.execution_location.cloud")
            .expect("cloud execution location feature");
        assert_eq!(cloud_location.category, ProviderFeatureCategory::Cloud);
        assert_eq!(cloud_location.support, ProviderFeatureSupport::Deferred);
    }
}

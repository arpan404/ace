use ace_runtime::provider::{
    ProviderAdapterContract, ProviderAdapterOperation, ProviderAdapterOperationSpec,
    ProviderAdapterOperationSupport, ProviderFeature, ProviderFeatureCategory,
    ProviderFeatureDirection, ProviderFeatureSupport,
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
use CodexMethodSupport::{IntentionallyDeferred, TypedSupported, VersionGated};

pub const CODEX_METHOD_INVENTORY: &[CodexMethodSpec] = &[
    CodexMethodSpec::new("initialize", ClientRequest, TypedSupported),
    CodexMethodSpec::new("initialized", ClientNotification, TypedSupported),
    CodexMethodSpec::new("account/login/cancel", ClientRequest, TypedSupported),
    CodexMethodSpec::new("account/login/start", ClientRequest, TypedSupported),
    CodexMethodSpec::new("account/logout", ClientRequest, TypedSupported),
    CodexMethodSpec::new(
        "account/rateLimitResetCredit/consume",
        ClientRequest,
        TypedSupported,
    ),
    CodexMethodSpec::new("account/rateLimits/read", ClientRequest, TypedSupported),
    CodexMethodSpec::new("account/read", ClientRequest, TypedSupported),
    CodexMethodSpec::new(
        "account/sendAddCreditsNudgeEmail",
        ClientRequest,
        TypedSupported,
    ),
    CodexMethodSpec::new("account/usage/read", ClientRequest, TypedSupported),
    CodexMethodSpec::new("app/list", ClientRequest, VersionGated),
    CodexMethodSpec::new("collaborationMode/list", ClientRequest, VersionGated),
    CodexMethodSpec::new("config/batchWrite", ClientRequest, TypedSupported),
    CodexMethodSpec::new("config/mcpServer/reload", ClientRequest, TypedSupported),
    CodexMethodSpec::new("config/read", ClientRequest, TypedSupported),
    CodexMethodSpec::new("config/value/write", ClientRequest, TypedSupported),
    CodexMethodSpec::new(
        "experimentalFeature/enablement/set",
        ClientRequest,
        TypedSupported,
    ),
    CodexMethodSpec::new("experimentalFeature/list", ClientRequest, TypedSupported),
    CodexMethodSpec::new("externalAgentConfig/detect", ClientRequest, TypedSupported),
    CodexMethodSpec::new("externalAgentConfig/import", ClientRequest, TypedSupported),
    CodexMethodSpec::new("feedback/upload", ClientRequest, TypedSupported),
    CodexMethodSpec::new("environment/add", ClientRequest, VersionGated),
    CodexMethodSpec::new("fs/copy", ClientRequest, TypedSupported),
    CodexMethodSpec::new("fs/createDirectory", ClientRequest, TypedSupported),
    CodexMethodSpec::new("fs/getMetadata", ClientRequest, TypedSupported),
    CodexMethodSpec::new("fs/readDirectory", ClientRequest, TypedSupported),
    CodexMethodSpec::new("fs/readFile", ClientRequest, TypedSupported),
    CodexMethodSpec::new("fs/remove", ClientRequest, TypedSupported),
    CodexMethodSpec::new("fs/unwatch", ClientRequest, TypedSupported),
    CodexMethodSpec::new("fs/watch", ClientRequest, TypedSupported),
    CodexMethodSpec::new("fs/writeFile", ClientRequest, TypedSupported),
    CodexMethodSpec::new("fuzzyFileSearch", ClientRequest, TypedSupported),
    CodexMethodSpec::new("fuzzyFileSearch/sessionStart", ClientRequest, VersionGated),
    CodexMethodSpec::new("fuzzyFileSearch/sessionStop", ClientRequest, VersionGated),
    CodexMethodSpec::new("fuzzyFileSearch/sessionUpdate", ClientRequest, VersionGated),
    CodexMethodSpec::new("hooks/list", ClientRequest, TypedSupported),
    CodexMethodSpec::new("marketplace/add", ClientRequest, TypedSupported),
    CodexMethodSpec::new("marketplace/remove", ClientRequest, TypedSupported),
    CodexMethodSpec::new("marketplace/upgrade", ClientRequest, TypedSupported),
    CodexMethodSpec::new("model/list", ClientRequest, TypedSupported),
    CodexMethodSpec::new(
        "modelProvider/capabilities/read",
        ClientRequest,
        TypedSupported,
    ),
    CodexMethodSpec::new("memory/reset", ClientRequest, VersionGated),
    CodexMethodSpec::new("mock/experimentalMethod", ClientRequest, VersionGated),
    CodexMethodSpec::new("thread/start", ClientRequest, TypedSupported),
    CodexMethodSpec::new("thread/resume", ClientRequest, TypedSupported),
    CodexMethodSpec::new("thread/fork", ClientRequest, TypedSupported),
    CodexMethodSpec::new("thread/read", ClientRequest, TypedSupported),
    CodexMethodSpec::new("thread/list", ClientRequest, TypedSupported),
    CodexMethodSpec::new("thread/loaded/list", ClientRequest, TypedSupported),
    CodexMethodSpec::new("thread/archive", ClientRequest, TypedSupported),
    CodexMethodSpec::new("thread/unarchive", ClientRequest, TypedSupported),
    CodexMethodSpec::new("thread/delete", ClientRequest, TypedSupported),
    CodexMethodSpec::new("thread/unsubscribe", ClientRequest, TypedSupported),
    CodexMethodSpec::new("thread/name/set", ClientRequest, TypedSupported),
    CodexMethodSpec::new("thread/metadata/update", ClientRequest, TypedSupported),
    CodexMethodSpec::new("thread/compact/start", ClientRequest, TypedSupported),
    CodexMethodSpec::new("thread/rollback", ClientRequest, TypedSupported),
    CodexMethodSpec::new("thread/inject_items", ClientRequest, TypedSupported),
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
    CodexMethodSpec::new("thread/goal/set", ClientRequest, TypedSupported),
    CodexMethodSpec::new("thread/goal/get", ClientRequest, TypedSupported),
    CodexMethodSpec::new("thread/goal/clear", ClientRequest, TypedSupported),
    CodexMethodSpec::new("turn/steer", ClientRequest, TypedSupported),
    CodexMethodSpec::new("subagent/list", ClientRequest, TypedSupported),
    CodexMethodSpec::new("subagent/read", ClientRequest, TypedSupported),
    CodexMethodSpec::new("subagent/steer", ClientRequest, TypedSupported),
    CodexMethodSpec::new("subagent/stop", ClientRequest, TypedSupported),
    CodexMethodSpec::new("subagent/close", ClientRequest, TypedSupported),
    CodexMethodSpec::new("review/start", ClientRequest, VersionGated),
    CodexMethodSpec::new("thread/shellCommand", ClientRequest, VersionGated),
    CodexMethodSpec::new("command/exec", ClientRequest, VersionGated),
    CodexMethodSpec::new("command/exec/write", ClientRequest, VersionGated),
    CodexMethodSpec::new("command/exec/resize", ClientRequest, VersionGated),
    CodexMethodSpec::new("command/exec/terminate", ClientRequest, VersionGated),
    CodexMethodSpec::new("process/list", ClientRequest, VersionGated),
    CodexMethodSpec::new("process/clean", ClientRequest, VersionGated),
    CodexMethodSpec::new("process/kill", ClientRequest, VersionGated),
    CodexMethodSpec::new("process/resizePty", ClientRequest, VersionGated),
    CodexMethodSpec::new("process/spawn", ClientRequest, VersionGated),
    CodexMethodSpec::new("process/writeStdin", ClientRequest, VersionGated),
    CodexMethodSpec::new("mcpServerStatus/list", ClientRequest, VersionGated),
    CodexMethodSpec::new("mcpServer/resource/read", ClientRequest, VersionGated),
    CodexMethodSpec::new("mcpServer/oauth/login", ClientRequest, VersionGated),
    CodexMethodSpec::new("mcpServer/tool/call", ClientRequest, VersionGated),
    CodexMethodSpec::new("plugin/skill/read", ClientRequest, VersionGated),
    CodexMethodSpec::new("plugin/installed", ClientRequest, TypedSupported),
    CodexMethodSpec::new("plugin/read", ClientRequest, TypedSupported),
    CodexMethodSpec::new("plugin/share/checkout", ClientRequest, TypedSupported),
    CodexMethodSpec::new("plugin/share/delete", ClientRequest, TypedSupported),
    CodexMethodSpec::new("plugin/share/list", ClientRequest, TypedSupported),
    CodexMethodSpec::new("plugin/share/save", ClientRequest, TypedSupported),
    CodexMethodSpec::new("plugin/share/updateTargets", ClientRequest, TypedSupported),
    CodexMethodSpec::new("plugin/uninstall", ClientRequest, TypedSupported),
    CodexMethodSpec::new("skills/config/write", ClientRequest, VersionGated),
    CodexMethodSpec::new("skills/extraRoots/set", ClientRequest, TypedSupported),
    CodexMethodSpec::new("skills/list", ClientRequest, VersionGated),
    CodexMethodSpec::new("skills/install", ClientRequest, VersionGated),
    CodexMethodSpec::new("plugin/list", ClientRequest, VersionGated),
    CodexMethodSpec::new("plugin/install", ClientRequest, VersionGated),
    CodexMethodSpec::new("apps/configWrite", ClientRequest, VersionGated),
    CodexMethodSpec::new("remote/connectionList", ClientRequest, VersionGated),
    CodexMethodSpec::new("remote/handoff", ClientRequest, VersionGated),
    CodexMethodSpec::new("remoteControl/client/list", ClientRequest, VersionGated),
    CodexMethodSpec::new("remoteControl/client/revoke", ClientRequest, VersionGated),
    CodexMethodSpec::new("remoteControl/disable", ClientRequest, VersionGated),
    CodexMethodSpec::new("remoteControl/enable", ClientRequest, VersionGated),
    CodexMethodSpec::new("remoteControl/pairing/start", ClientRequest, VersionGated),
    CodexMethodSpec::new("remoteControl/pairing/status", ClientRequest, VersionGated),
    CodexMethodSpec::new("remoteControl/status/read", ClientRequest, VersionGated),
    CodexMethodSpec::new(
        "thread/backgroundTerminals/clean",
        ClientRequest,
        VersionGated,
    ),
    CodexMethodSpec::new(
        "thread/backgroundTerminals/list",
        ClientRequest,
        VersionGated,
    ),
    CodexMethodSpec::new(
        "thread/backgroundTerminals/terminate",
        ClientRequest,
        VersionGated,
    ),
    CodexMethodSpec::new("thread/decrement_elicitation", ClientRequest, VersionGated),
    CodexMethodSpec::new("thread/increment_elicitation", ClientRequest, VersionGated),
    CodexMethodSpec::new("thread/memoryMode/set", ClientRequest, VersionGated),
    CodexMethodSpec::new("thread/realtime/appendAudio", ClientRequest, VersionGated),
    CodexMethodSpec::new("thread/realtime/appendSpeech", ClientRequest, VersionGated),
    CodexMethodSpec::new("thread/realtime/appendText", ClientRequest, VersionGated),
    CodexMethodSpec::new("thread/realtime/listVoices", ClientRequest, VersionGated),
    CodexMethodSpec::new("thread/realtime/start", ClientRequest, VersionGated),
    CodexMethodSpec::new("thread/realtime/stop", ClientRequest, VersionGated),
    CodexMethodSpec::new("thread/search", ClientRequest, VersionGated),
    CodexMethodSpec::new("thread/settings/update", ClientRequest, VersionGated),
    CodexMethodSpec::new("thread/turns/items/list", ClientRequest, VersionGated),
    CodexMethodSpec::new("thread/turns/list", ClientRequest, VersionGated),
    CodexMethodSpec::new("windowsSandbox/readiness", ClientRequest, TypedSupported),
    CodexMethodSpec::new("windowsSandbox/setupStart", ClientRequest, TypedSupported),
    CodexMethodSpec::new("cloud/threadStart", ClientRequest, IntentionallyDeferred),
    CodexMethodSpec::new("cloud/handoff", ClientRequest, IntentionallyDeferred),
    CodexMethodSpec::new(
        "account/login/completed",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new(
        "account/rateLimits/updated",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new("account/updated", ServerNotification, TypedSupported),
    CodexMethodSpec::new("app/list/updated", ServerNotification, TypedSupported),
    CodexMethodSpec::new(
        "command/exec/outputDelta",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new("configWarning", ServerNotification, TypedSupported),
    CodexMethodSpec::new("deprecationNotice", ServerNotification, TypedSupported),
    CodexMethodSpec::new("error", ServerNotification, TypedSupported),
    CodexMethodSpec::new(
        "externalAgentConfig/import/completed",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new("fs/changed", ServerNotification, TypedSupported),
    CodexMethodSpec::new(
        "fuzzyFileSearch/sessionCompleted",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new(
        "fuzzyFileSearch/sessionUpdated",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new("guardianWarning", ServerNotification, TypedSupported),
    CodexMethodSpec::new("hook/completed", ServerNotification, TypedSupported),
    CodexMethodSpec::new("hook/started", ServerNotification, TypedSupported),
    CodexMethodSpec::new("turn/started", ServerNotification, TypedSupported),
    CodexMethodSpec::new("turn/completed", ServerNotification, TypedSupported),
    CodexMethodSpec::new("turn/diff/updated", ServerNotification, TypedSupported),
    CodexMethodSpec::new(
        "turn/moderationMetadata",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new("turn/plan/updated", ServerNotification, TypedSupported),
    CodexMethodSpec::new("thread/archived", ServerNotification, TypedSupported),
    CodexMethodSpec::new("thread/closed", ServerNotification, TypedSupported),
    CodexMethodSpec::new("thread/compacted", ServerNotification, TypedSupported),
    CodexMethodSpec::new("thread/deleted", ServerNotification, TypedSupported),
    CodexMethodSpec::new("thread/goal/updated", ServerNotification, TypedSupported),
    CodexMethodSpec::new("thread/goal/cleared", ServerNotification, TypedSupported),
    CodexMethodSpec::new("thread/name/updated", ServerNotification, TypedSupported),
    CodexMethodSpec::new("thread/realtime/closed", ServerNotification, TypedSupported),
    CodexMethodSpec::new("thread/realtime/error", ServerNotification, TypedSupported),
    CodexMethodSpec::new(
        "thread/realtime/itemAdded",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new(
        "thread/realtime/outputAudio/delta",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new("thread/realtime/sdp", ServerNotification, TypedSupported),
    CodexMethodSpec::new(
        "thread/realtime/started",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new(
        "thread/realtime/transcript/delta",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new(
        "thread/realtime/transcript/done",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new(
        "thread/settings/updated",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new("thread/started", ServerNotification, TypedSupported),
    CodexMethodSpec::new("thread/status/changed", ServerNotification, TypedSupported),
    CodexMethodSpec::new(
        "thread/tokenUsage/updated",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new("thread/unarchived", ServerNotification, TypedSupported),
    CodexMethodSpec::new("item/started", ServerNotification, TypedSupported),
    CodexMethodSpec::new("item/completed", ServerNotification, TypedSupported),
    CodexMethodSpec::new("item/failed", ServerNotification, TypedSupported),
    CodexMethodSpec::new(
        "item/agentMessage/delta",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new(
        "item/autoApprovalReview/completed",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new(
        "item/autoApprovalReview/started",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new("item/reasoning/delta", ServerNotification, TypedSupported),
    CodexMethodSpec::new(
        "item/reasoning/summaryPartAdded",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new(
        "item/reasoning/summaryTextDelta",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new(
        "item/reasoning/textDelta",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new("item/plan/delta", ServerNotification, TypedSupported),
    CodexMethodSpec::new(
        "item/commandExecution/outputDelta",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new(
        "item/commandExecution/terminalInteraction",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new(
        "item/fileChange/outputDelta",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new(
        "item/fileChange/patchUpdated",
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
    CodexMethodSpec::new("process/exited", ServerNotification, TypedSupported),
    CodexMethodSpec::new(
        "mcpServer/oauthLogin/completed",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new(
        "mcpServer/startupStatus/updated",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new("model/rerouted", ServerNotification, TypedSupported),
    CodexMethodSpec::new("model/verification", ServerNotification, TypedSupported),
    CodexMethodSpec::new(
        "remoteControl/status/changed",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new("serverRequest/resolved", ServerNotification, TypedSupported),
    CodexMethodSpec::new("skills/changed", ServerNotification, TypedSupported),
    CodexMethodSpec::new("warning", ServerNotification, TypedSupported),
    CodexMethodSpec::new("realtime/transcriptDelta", ServerNotification, VersionGated),
    CodexMethodSpec::new("realtime/audioDelta", ServerNotification, VersionGated),
    CodexMethodSpec::new(
        "windows/worldWritableWarning",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new(
        "windowsSandbox/setupCompleted",
        ServerNotification,
        TypedSupported,
    ),
    CodexMethodSpec::new(
        "account/chatgptAuthTokens/refresh",
        ServerRequest,
        TypedSupported,
    ),
    CodexMethodSpec::new("applyPatchApproval", ServerRequest, TypedSupported),
    CodexMethodSpec::new("attestation/generate", ServerRequest, TypedSupported),
    CodexMethodSpec::new("execCommandApproval", ServerRequest, TypedSupported),
    CodexMethodSpec::new(
        "item/commandExecution/requestApproval",
        ServerRequest,
        TypedSupported,
    ),
    CodexMethodSpec::new(
        "item/fileChange/requestApproval",
        ServerRequest,
        TypedSupported,
    ),
    CodexMethodSpec::new(
        "item/permissions/requestApproval",
        ServerRequest,
        TypedSupported,
    ),
    CodexMethodSpec::new("item/tool/call", ServerRequest, TypedSupported),
    CodexMethodSpec::new("item/tool/requestUserInput", ServerRequest, TypedSupported),
    CodexMethodSpec::new(
        "mcpServer/elicitation/request",
        ServerRequest,
        TypedSupported,
    ),
    CodexMethodSpec::new("command/approvalRequest", ServerRequest, TypedSupported),
    CodexMethodSpec::new("fileChange/approvalRequest", ServerRequest, TypedSupported),
    CodexMethodSpec::new("tool/userInputRequest", ServerRequest, TypedSupported),
    CodexMethodSpec::new("tool/user_input_request", ServerRequest, TypedSupported),
    CodexMethodSpec::new(
        "mcpServer/elicitationRequest",
        ServerRequest,
        TypedSupported,
    ),
    CodexMethodSpec::new("mcp/elicitation", ServerRequest, TypedSupported),
    CodexMethodSpec::new("permission/approvalRequest", ServerRequest, TypedSupported),
    CodexMethodSpec::new(
        "item/dynamicToolCall/requestApproval",
        ServerRequest,
        TypedSupported,
    ),
    CodexMethodSpec::new("dynamicTool/call", ServerRequest, TypedSupported),
    CodexMethodSpec::new("dynamicTool/requestApproval", ServerRequest, TypedSupported),
    CodexMethodSpec::new(
        "account/chatgpt_auth_tokens/refresh",
        ServerRequest,
        TypedSupported,
    ),
    CodexMethodSpec::new("account/tokenRefresh", ServerRequest, TypedSupported),
    CodexMethodSpec::new("attestation/request", ServerRequest, TypedSupported),
    CodexMethodSpec::new("applyPatch/approvalRequest", ServerRequest, TypedSupported),
    CodexMethodSpec::new(
        "apply_patch/approval_request",
        ServerRequest,
        TypedSupported,
    ),
    CodexMethodSpec::new("exec/approvalRequest", ServerRequest, TypedSupported),
    CodexMethodSpec::new(
        "exec_command/approval_request",
        ServerRequest,
        TypedSupported,
    ),
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexMethodInventoryReport {
    pub source: String,
    pub note: String,
    pub total_methods: usize,
    pub client_request_methods: Vec<String>,
    pub client_notification_methods: Vec<String>,
    pub server_notification_methods: Vec<String>,
    pub server_request_methods: Vec<String>,
    pub typed_supported_methods: Vec<String>,
    pub raw_supported_methods: Vec<String>,
    pub version_gated_methods: Vec<String>,
    pub deferred_methods: Vec<String>,
    pub typed_client_request_methods: Vec<String>,
    pub raw_client_request_methods: Vec<String>,
    pub version_gated_client_request_methods: Vec<String>,
    pub deferred_client_request_methods: Vec<String>,
}

#[must_use]
pub fn codex_method_inventory_report() -> CodexMethodInventoryReport {
    let mut report = CodexMethodInventoryReport {
        source: "compiled_codex_adapter_inventory".to_string(),
        note: "classified methods describe adapter knowledge; installed support is reported separately when available".to_string(),
        total_methods: CODEX_METHOD_INVENTORY.len(),
        client_request_methods: Vec::new(),
        client_notification_methods: Vec::new(),
        server_notification_methods: Vec::new(),
        server_request_methods: Vec::new(),
        typed_supported_methods: Vec::new(),
        raw_supported_methods: Vec::new(),
        version_gated_methods: Vec::new(),
        deferred_methods: Vec::new(),
        typed_client_request_methods: Vec::new(),
        raw_client_request_methods: Vec::new(),
        version_gated_client_request_methods: Vec::new(),
        deferred_client_request_methods: Vec::new(),
    };

    for spec in CODEX_METHOD_INVENTORY {
        let method = spec.method.to_string();
        match spec.direction {
            CodexMethodDirection::ClientRequest => {
                report.client_request_methods.push(method.clone())
            }
            CodexMethodDirection::ClientNotification => {
                report.client_notification_methods.push(method.clone());
            }
            CodexMethodDirection::ServerNotification => {
                report.server_notification_methods.push(method.clone());
            }
            CodexMethodDirection::ServerRequest => {
                report.server_request_methods.push(method.clone())
            }
        }

        match spec.support {
            CodexMethodSupport::TypedSupported => {
                report.typed_supported_methods.push(method.clone());
                if spec.direction == CodexMethodDirection::ClientRequest {
                    report.typed_client_request_methods.push(method);
                }
            }
            CodexMethodSupport::RawSupported => {
                report.raw_supported_methods.push(method.clone());
                if spec.direction == CodexMethodDirection::ClientRequest {
                    report.raw_client_request_methods.push(method);
                }
            }
            CodexMethodSupport::VersionGated => {
                report.version_gated_methods.push(method.clone());
                if spec.direction == CodexMethodDirection::ClientRequest {
                    report.version_gated_client_request_methods.push(method);
                }
            }
            CodexMethodSupport::IntentionallyDeferred => {
                report.deferred_methods.push(method.clone());
                if spec.direction == CodexMethodDirection::ClientRequest {
                    report.deferred_client_request_methods.push(method);
                }
            }
        }
    }

    report
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexAdapterOperationCoverage {
    pub operation: ProviderAdapterOperation,
    pub declared_support: ProviderAdapterOperationSupport,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical_method: Option<String>,
    #[serde(default)]
    pub provider_methods: Vec<CodexAdapterProviderMethodCoverage>,
    #[serde(default)]
    pub missing_methods: Vec<String>,
    #[serde(default)]
    pub support_mismatches: Vec<CodexAdapterSupportMismatch>,
    pub fully_covered: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexAdapterProviderMethodCoverage {
    pub method: String,
    pub support: CodexMethodSupport,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexAdapterSupportMismatch {
    pub method: String,
    pub expected: ProviderAdapterOperationSupport,
    pub actual: CodexMethodSupport,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexAdapterContractCoverageReport {
    pub operations: usize,
    pub fully_covered_operations: usize,
    pub provider_methods: usize,
    #[serde(default)]
    pub missing_methods: Vec<String>,
    #[serde(default)]
    pub support_mismatches: Vec<CodexAdapterSupportMismatch>,
    pub fully_covered: bool,
}

#[must_use]
pub fn codex_adapter_contract_coverage(
    contract: &ProviderAdapterContract,
) -> Vec<CodexAdapterOperationCoverage> {
    contract
        .operations
        .iter()
        .map(codex_adapter_operation_coverage)
        .collect()
}

#[must_use]
pub fn codex_adapter_contract_coverage_report(
    contract: &ProviderAdapterContract,
) -> CodexAdapterContractCoverageReport {
    let coverage = codex_adapter_contract_coverage(contract);
    let provider_methods = coverage
        .iter()
        .map(|operation| operation.provider_methods.len())
        .sum();
    let missing_methods = coverage
        .iter()
        .flat_map(|operation| operation.missing_methods.iter().cloned())
        .collect::<Vec<_>>();
    let support_mismatches = coverage
        .iter()
        .flat_map(|operation| operation.support_mismatches.iter().cloned())
        .collect::<Vec<_>>();
    let fully_covered_operations = coverage
        .iter()
        .filter(|operation| operation.fully_covered)
        .count();
    CodexAdapterContractCoverageReport {
        operations: coverage.len(),
        fully_covered_operations,
        provider_methods,
        fully_covered: missing_methods.is_empty() && support_mismatches.is_empty(),
        missing_methods,
        support_mismatches,
    }
}

fn codex_adapter_operation_coverage(
    operation: &ProviderAdapterOperationSpec,
) -> CodexAdapterOperationCoverage {
    let mut provider_methods = Vec::with_capacity(operation.provider_methods.len());
    let mut missing_methods = Vec::new();
    let mut support_mismatches = Vec::new();

    for method in &operation.provider_methods {
        match classify_codex_method(method, CodexMethodDirection::ClientRequest) {
            Some(support) => {
                if !codex_support_satisfies_adapter_support(support, operation.support) {
                    support_mismatches.push(CodexAdapterSupportMismatch {
                        method: method.clone(),
                        expected: operation.support,
                        actual: support,
                    });
                }
                provider_methods.push(CodexAdapterProviderMethodCoverage {
                    method: method.clone(),
                    support,
                });
            }
            None => missing_methods.push(method.clone()),
        }
    }

    let fully_covered = missing_methods.is_empty() && support_mismatches.is_empty();

    CodexAdapterOperationCoverage {
        operation: operation.operation,
        declared_support: operation.support,
        canonical_method: operation.canonical_method.clone(),
        provider_methods,
        missing_methods,
        support_mismatches,
        fully_covered,
    }
}

fn codex_support_satisfies_adapter_support(
    method_support: CodexMethodSupport,
    adapter_support: ProviderAdapterOperationSupport,
) -> bool {
    match adapter_support {
        ProviderAdapterOperationSupport::Required | ProviderAdapterOperationSupport::Optional => {
            matches!(
                method_support,
                CodexMethodSupport::TypedSupported | CodexMethodSupport::RawSupported
            )
        }
        ProviderAdapterOperationSupport::VersionGated => {
            method_support == CodexMethodSupport::VersionGated
        }
        ProviderAdapterOperationSupport::Deferred => {
            method_support == CodexMethodSupport::IntentionallyDeferred
        }
    }
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
            if method.contains("/goal/") {
                ProviderFeatureCategory::Goals
            } else if method.contains("handoff") {
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
        "subagent" => ProviderFeatureCategory::Subagents,
        "command"
        | "process"
        | "tool"
        | "dynamicTool"
        | "applyPatch"
        | "applyPatchApproval"
        | "exec"
        | "execCommandApproval"
        | "review"
        | "fs"
        | "fuzzyFileSearch"
        | "hooks"
        | "environment"
        | "memory"
        | "mock" => ProviderFeatureCategory::Tools,
        "mcp" | "mcpServer" | "mcpServerStatus" => ProviderFeatureCategory::Mcp,
        "skills" => ProviderFeatureCategory::Skills,
        "plugins" | "plugin" | "marketplace" => ProviderFeatureCategory::Plugins,
        "apps" | "app" => ProviderFeatureCategory::Apps,
        "remote" | "remoteControl" => {
            if method.contains("handoff") {
                ProviderFeatureCategory::Handoff
            } else {
                ProviderFeatureCategory::Remote
            }
        }
        "cloud" => ProviderFeatureCategory::Cloud,
        "configRequirements"
        | "permissionProfile"
        | "permission"
        | "config"
        | "experimentalFeature" => ProviderFeatureCategory::Permissions,
        "item" => {
            if method.contains("/plan/") {
                ProviderFeatureCategory::Plans
            } else {
                ProviderFeatureCategory::Events
            }
        }
        "collaborationMode" | "model" | "modelProvider" | "warning" | "realtime" => {
            ProviderFeatureCategory::Events
        }
        "account"
        | "attestation"
        | "feedback"
        | "externalAgentConfig"
        | "windows"
        | "windowsSandbox"
        | "configWarning"
        | "guardianWarning"
        | "deprecationNotice"
        | "error" => ProviderFeatureCategory::Diagnostics,
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
    use ace_runtime::{
        provider::ServerRequestKind,
        server_requests::{KNOWN_SERVER_REQUEST_METHODS, server_request_kind},
        tools::{
            ProviderServerRequestToolNormalizationInput, normalize_provider_server_request_tool,
        },
    };
    use serde_json::Value;
    use std::{
        collections::{BTreeSet, HashSet},
        fs,
        io::ErrorKind,
        process::Command,
    };

    const CURRENT_CLIENT_REQUEST_METHODS: &[&str] = &[
        "account/login/cancel",
        "account/login/start",
        "account/logout",
        "account/rateLimitResetCredit/consume",
        "account/rateLimits/read",
        "account/read",
        "account/sendAddCreditsNudgeEmail",
        "account/usage/read",
        "app/list",
        "collaborationMode/list",
        "command/exec",
        "command/exec/resize",
        "command/exec/terminate",
        "command/exec/write",
        "config/batchWrite",
        "config/mcpServer/reload",
        "config/read",
        "config/value/write",
        "configRequirements/read",
        "experimentalFeature/enablement/set",
        "experimentalFeature/list",
        "externalAgentConfig/detect",
        "externalAgentConfig/import",
        "feedback/upload",
        "environment/add",
        "fs/copy",
        "fs/createDirectory",
        "fs/getMetadata",
        "fs/readDirectory",
        "fs/readFile",
        "fs/remove",
        "fs/unwatch",
        "fs/watch",
        "fs/writeFile",
        "fuzzyFileSearch",
        "fuzzyFileSearch/sessionStart",
        "fuzzyFileSearch/sessionStop",
        "fuzzyFileSearch/sessionUpdate",
        "hooks/list",
        "initialize",
        "marketplace/add",
        "marketplace/remove",
        "marketplace/upgrade",
        "mcpServer/oauth/login",
        "mcpServer/resource/read",
        "mcpServer/tool/call",
        "mcpServerStatus/list",
        "model/list",
        "modelProvider/capabilities/read",
        "memory/reset",
        "mock/experimentalMethod",
        "permissionProfile/list",
        "plugin/install",
        "plugin/installed",
        "plugin/list",
        "plugin/read",
        "plugin/share/checkout",
        "plugin/share/delete",
        "plugin/share/list",
        "plugin/share/save",
        "plugin/share/updateTargets",
        "plugin/skill/read",
        "plugin/uninstall",
        "process/kill",
        "process/resizePty",
        "process/spawn",
        "process/writeStdin",
        "remoteControl/client/list",
        "remoteControl/client/revoke",
        "remoteControl/disable",
        "remoteControl/enable",
        "remoteControl/pairing/start",
        "remoteControl/pairing/status",
        "remoteControl/status/read",
        "review/start",
        "skills/config/write",
        "skills/extraRoots/set",
        "skills/list",
        "thread/approveGuardianDeniedAction",
        "thread/archive",
        "thread/backgroundTerminals/clean",
        "thread/backgroundTerminals/list",
        "thread/backgroundTerminals/terminate",
        "thread/compact/start",
        "thread/decrement_elicitation",
        "thread/delete",
        "thread/fork",
        "thread/goal/clear",
        "thread/goal/get",
        "thread/goal/set",
        "thread/increment_elicitation",
        "thread/inject_items",
        "thread/list",
        "thread/loaded/list",
        "thread/memoryMode/set",
        "thread/metadata/update",
        "thread/name/set",
        "thread/read",
        "thread/realtime/appendAudio",
        "thread/realtime/appendSpeech",
        "thread/realtime/appendText",
        "thread/realtime/listVoices",
        "thread/realtime/start",
        "thread/realtime/stop",
        "thread/resume",
        "thread/rollback",
        "thread/search",
        "thread/settings/update",
        "thread/shellCommand",
        "thread/start",
        "thread/turns/items/list",
        "thread/turns/list",
        "thread/unarchive",
        "thread/unsubscribe",
        "turn/interrupt",
        "turn/start",
        "turn/steer",
        "windowsSandbox/readiness",
        "windowsSandbox/setupStart",
    ];

    const CURRENT_CLIENT_NOTIFICATION_METHODS: &[&str] = &["initialized"];

    const CURRENT_SERVER_NOTIFICATION_METHODS: &[&str] = &[
        "account/login/completed",
        "account/rateLimits/updated",
        "account/updated",
        "app/list/updated",
        "command/exec/outputDelta",
        "configWarning",
        "deprecationNotice",
        "error",
        "externalAgentConfig/import/completed",
        "fs/changed",
        "fuzzyFileSearch/sessionCompleted",
        "fuzzyFileSearch/sessionUpdated",
        "guardianWarning",
        "hook/completed",
        "hook/started",
        "item/agentMessage/delta",
        "item/autoApprovalReview/completed",
        "item/autoApprovalReview/started",
        "item/commandExecution/outputDelta",
        "item/commandExecution/terminalInteraction",
        "item/completed",
        "item/fileChange/outputDelta",
        "item/fileChange/patchUpdated",
        "item/mcpToolCall/progress",
        "item/plan/delta",
        "item/reasoning/summaryPartAdded",
        "item/reasoning/summaryTextDelta",
        "item/reasoning/textDelta",
        "item/started",
        "mcpServer/oauthLogin/completed",
        "mcpServer/startupStatus/updated",
        "model/rerouted",
        "model/verification",
        "process/exited",
        "process/outputDelta",
        "remoteControl/status/changed",
        "serverRequest/resolved",
        "skills/changed",
        "thread/archived",
        "thread/closed",
        "thread/compacted",
        "thread/deleted",
        "thread/goal/cleared",
        "thread/goal/updated",
        "thread/name/updated",
        "thread/realtime/closed",
        "thread/realtime/error",
        "thread/realtime/itemAdded",
        "thread/realtime/outputAudio/delta",
        "thread/realtime/sdp",
        "thread/realtime/started",
        "thread/realtime/transcript/delta",
        "thread/realtime/transcript/done",
        "thread/settings/updated",
        "thread/started",
        "thread/status/changed",
        "thread/tokenUsage/updated",
        "thread/unarchived",
        "turn/completed",
        "turn/diff/updated",
        "turn/moderationMetadata",
        "turn/plan/updated",
        "turn/started",
        "warning",
        "windows/worldWritableWarning",
        "windowsSandbox/setupCompleted",
    ];

    const CURRENT_SERVER_REQUEST_METHODS: &[&str] = &[
        "account/chatgptAuthTokens/refresh",
        "applyPatchApproval",
        "attestation/generate",
        "execCommandApproval",
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/permissions/requestApproval",
        "item/tool/call",
        "item/tool/requestUserInput",
        "mcpServer/elicitation/request",
    ];

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
            classify_codex_method("turn/steer", ClientRequest),
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
            classify_codex_method("item/commandExecution/requestApproval", ServerRequest),
            Some(TypedSupported)
        );
        assert_eq!(
            classify_codex_method("item/plan/delta", ServerNotification),
            Some(TypedSupported)
        );
    }

    #[test]
    fn runtime_signal_notifications_are_typed_supported() {
        for method in [
            "account/login/completed",
            "account/rateLimits/updated",
            "account/updated",
            "app/list/updated",
            "configWarning",
            "deprecationNotice",
            "error",
            "externalAgentConfig/import/completed",
            "fs/changed",
            "fuzzyFileSearch/sessionCompleted",
            "fuzzyFileSearch/sessionUpdated",
            "guardianWarning",
            "hook/completed",
            "hook/started",
            "item/autoApprovalReview/completed",
            "item/autoApprovalReview/started",
            "mcpServer/oauthLogin/completed",
            "mcpServer/startupStatus/updated",
            "model/rerouted",
            "model/verification",
            "process/exited",
            "remoteControl/status/changed",
            "serverRequest/resolved",
            "skills/changed",
            "thread/archived",
            "thread/closed",
            "thread/compacted",
            "thread/deleted",
            "thread/name/updated",
            "thread/settings/updated",
            "thread/started",
            "thread/status/changed",
            "thread/tokenUsage/updated",
            "thread/unarchived",
            "turn/diff/updated",
            "turn/moderationMetadata",
            "warning",
            "windows/worldWritableWarning",
            "windowsSandbox/setupCompleted",
        ] {
            assert_eq!(
                classify_codex_method(method, ServerNotification),
                Some(TypedSupported),
                "{method}"
            );
        }
    }

    #[test]
    fn runtime_server_requests_are_typed_supported() {
        for method in KNOWN_SERVER_REQUEST_METHODS {
            assert_eq!(
                classify_codex_method(method, ServerRequest),
                Some(TypedSupported),
                "{method}"
            );
        }
    }

    #[test]
    fn current_generated_app_server_methods_are_classified() {
        assert_all_methods_classified(CURRENT_CLIENT_REQUEST_METHODS, ClientRequest);
        assert_all_methods_classified(CURRENT_CLIENT_NOTIFICATION_METHODS, ClientNotification);
        assert_all_methods_classified(CURRENT_SERVER_NOTIFICATION_METHODS, ServerNotification);
        assert_all_methods_classified(CURRENT_SERVER_REQUEST_METHODS, ServerRequest);
    }

    #[test]
    fn codex_server_request_inventory_has_runtime_normalizers() {
        let server_request_methods = CODEX_METHOD_INVENTORY
            .iter()
            .filter(|spec| spec.direction == ServerRequest)
            .map(|spec| spec.method)
            .collect::<Vec<_>>();

        assert!(!server_request_methods.is_empty());
        for method in server_request_methods {
            assert!(
                KNOWN_SERVER_REQUEST_METHODS.contains(&method),
                "{method} must be listed in runtime known server request methods"
            );
            assert_ne!(
                server_request_kind(method),
                ServerRequestKind::Unknown,
                "{method} must map to a concrete NormalizedServerRequest kind"
            );
        }
    }

    #[test]
    fn codex_host_tool_server_requests_have_semantic_display() {
        let semantic_methods = CODEX_METHOD_INVENTORY
            .iter()
            .filter(|spec| spec.direction == ServerRequest)
            .filter_map(|spec| {
                let kind = server_request_kind(spec.method);
                matches!(
                    kind,
                    ServerRequestKind::CommandApproval
                        | ServerRequestKind::ExecApproval
                        | ServerRequestKind::FileChangeApproval
                        | ServerRequestKind::ApplyPatchApproval
                        | ServerRequestKind::ToolUserInput
                        | ServerRequestKind::McpElicitation
                        | ServerRequestKind::DynamicToolCall
                )
                .then_some(spec.method)
            })
            .collect::<Vec<_>>();

        assert!(!semantic_methods.is_empty());
        for method in semantic_methods {
            let tool = normalize_provider_server_request_tool(
                ProviderServerRequestToolNormalizationInput {
                    provider: "codex".to_string(),
                    request_id: format!("{method}:request"),
                    method: method.to_string(),
                    params: serde_json::json!({
                        "threadId": "thread-1",
                        "turnId": "turn-1",
                        "itemId": "item-1",
                        "command": "cargo check",
                        "cwd": "/repo",
                        "path": "src/lib.rs",
                        "patch": "*** Begin Patch\n*** End Patch\n",
                        "serverName": "browser",
                        "toolName": "navigate_tab_url",
                        "operation": "navigate_tab_url",
                        "arguments": {
                            "url": "https://example.com"
                        },
                        "question": "Choose a tab",
                        "choices": ["current", "new"]
                    }),
                },
            )
            .unwrap_or_else(|| panic!("{method} must produce a semantic tool display"));

            assert!(
                !tool.display.title.trim().is_empty(),
                "{method} produced an empty display title"
            );
            assert!(
                tool.provider.raw_payload.is_object(),
                "{method} must preserve the raw provider payload"
            );
        }
    }

    #[test]
    fn installed_codex_generated_schema_methods_are_classified_when_available() {
        let out_dir = tempfile::tempdir().expect("schema tempdir");
        let output = match Command::new("codex")
            .args([
                "app-server",
                "generate-json-schema",
                "--experimental",
                "--out",
            ])
            .arg(out_dir.path())
            .output()
        {
            Ok(output) => output,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                eprintln!("skipping live Codex schema inventory test: codex binary not found");
                return;
            }
            Err(error) => panic!("failed to run codex schema generator: {error}"),
        };

        assert!(
            output.status.success(),
            "codex schema generator failed: status={:?} stdout={} stderr={}",
            output.status.code(),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );

        assert_generated_schema_file_classified(
            out_dir.path().join("ClientRequest.json"),
            ClientRequest,
        );
        assert_generated_schema_file_classified(
            out_dir.path().join("ClientNotification.json"),
            ClientNotification,
        );
        assert_generated_schema_file_classified(
            out_dir.path().join("ServerNotification.json"),
            ServerNotification,
        );
        assert_generated_schema_file_classified(
            out_dir.path().join("ServerRequest.json"),
            ServerRequest,
        );
    }

    #[test]
    fn generated_json_schema_method_parser_reads_single_value_enums() {
        let schema = serde_json::json!({
            "oneOf": [
                {
                    "properties": {
                        "method": {
                            "enum": ["thread/start"]
                        }
                    }
                },
                {
                    "properties": {
                        "method": {
                            "enum": ["turn/start"]
                        }
                    }
                }
            ]
        });
        assert_eq!(
            schema_methods(&schema),
            BTreeSet::from(["thread/start".to_string(), "turn/start".to_string()])
        );
    }

    fn assert_all_methods_classified(methods: &[&str], direction: CodexMethodDirection) {
        let missing = methods
            .iter()
            .filter(|method| classify_codex_method(method, direction).is_none())
            .copied()
            .collect::<Vec<_>>();
        assert!(
            missing.is_empty(),
            "missing generated Codex methods for {direction:?}: {missing:#?}"
        );
    }

    fn assert_generated_schema_file_classified(
        path: impl AsRef<std::path::Path>,
        direction: CodexMethodDirection,
    ) {
        let path = path.as_ref();
        let schema = fs::read_to_string(path)
            .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()));
        let schema = serde_json::from_str::<Value>(&schema)
            .unwrap_or_else(|error| panic!("failed to parse {}: {error}", path.display()));
        let methods = schema_methods(&schema).into_iter().collect::<Vec<_>>();
        let missing = methods
            .iter()
            .filter(|method| classify_codex_method(method, direction).is_none())
            .collect::<Vec<_>>();
        assert!(
            missing.is_empty(),
            "generated Codex schema has unclassified {direction:?} methods in {}: {missing:#?}",
            path.display()
        );
    }

    fn schema_methods(schema: &Value) -> BTreeSet<String> {
        schema
            .get("oneOf")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.pointer("/properties/method/enum"))
            .filter_map(Value::as_array)
            .flatten()
            .filter_map(Value::as_str)
            .map(ToString::to_string)
            .collect()
    }

    #[test]
    fn inventory_keeps_required_support_classes_represented_without_raw_client_requests() {
        for support in [TypedSupported, VersionGated, IntentionallyDeferred] {
            assert!(
                CODEX_METHOD_INVENTORY
                    .iter()
                    .any(|spec| spec.support == support),
                "missing support class {support:?}"
            );
        }
        assert!(
            CODEX_METHOD_INVENTORY
                .iter()
                .filter(|spec| spec.direction == ClientRequest)
                .all(|spec| spec.support != CodexMethodSupport::RawSupported),
            "client requests should use typed, version-gated, or deferred contracts"
        );
    }

    #[test]
    fn method_inventory_report_counts_directions_support_and_contract_coverage() {
        let report = codex_method_inventory_report();
        assert_eq!(report.source, "compiled_codex_adapter_inventory");
        assert_eq!(report.total_methods, CODEX_METHOD_INVENTORY.len());
        assert_eq!(
            report.client_request_methods.len()
                + report.client_notification_methods.len()
                + report.server_notification_methods.len()
                + report.server_request_methods.len(),
            report.total_methods
        );
        assert_eq!(
            report.typed_supported_methods.len()
                + report.raw_supported_methods.len()
                + report.version_gated_methods.len()
                + report.deferred_methods.len(),
            report.total_methods
        );
        assert!(
            report
                .version_gated_client_request_methods
                .contains(&"command/exec".to_string())
        );
        assert!(
            report
                .deferred_client_request_methods
                .contains(&"cloud/handoff".to_string())
        );
        assert!(
            report
                .server_request_methods
                .contains(&"item/tool/call".to_string())
        );

        let contract = ace_runtime::provider::ace_provider_adapter_contract();
        let coverage = codex_adapter_contract_coverage_report(&contract);
        assert_eq!(coverage.operations, contract.operations.len());
        assert_eq!(coverage.fully_covered_operations, coverage.operations);
        assert!(coverage.provider_methods > 0);
        assert!(coverage.fully_covered);
        assert!(coverage.missing_methods.is_empty());
        assert!(coverage.support_mismatches.is_empty());
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

        let realtime_session = features
            .iter()
            .find(|feature| feature.provider_method.as_deref() == Some("thread/realtime/started"))
            .expect("realtime session feature");
        assert_eq!(realtime_session.category, ProviderFeatureCategory::Threads);
        assert_eq!(realtime_session.support, ProviderFeatureSupport::Typed);
        assert_eq!(
            realtime_session.direction,
            Some(ProviderFeatureDirection::ServerNotification)
        );

        for method in [
            "thread/realtime/closed",
            "thread/realtime/error",
            "thread/realtime/itemAdded",
            "thread/realtime/sdp",
            "thread/realtime/transcript/done",
        ] {
            let feature = features
                .iter()
                .find(|feature| feature.provider_method.as_deref() == Some(method))
                .unwrap_or_else(|| panic!("missing realtime feature {method}"));
            assert_eq!(feature.support, ProviderFeatureSupport::Typed, "{method}");
        }

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

    #[test]
    fn adapter_contract_provider_methods_are_covered_by_codex_inventory() {
        let contract = ace_runtime::provider::ace_provider_adapter_contract();
        let coverage = codex_adapter_contract_coverage(&contract);

        assert_eq!(coverage.len(), contract.operations.len());
        assert!(
            coverage.iter().all(|operation| operation.fully_covered),
            "adapter contract coverage drift: {coverage:#?}"
        );

        let plan_fork = coverage
            .iter()
            .find(|operation| {
                operation.operation
                    == ace_runtime::provider::ProviderAdapterOperation::PlanForkForImplementation
            })
            .expect("plan fork operation");
        assert_eq!(
            plan_fork
                .provider_methods
                .iter()
                .map(|method| method.method.as_str())
                .collect::<Vec<_>>(),
            ["thread/fork", "thread/inject_items", "turn/start"]
        );
        assert!(
            plan_fork
                .provider_methods
                .iter()
                .all(|method| method.support == TypedSupported)
        );

        let mcp_tool = coverage
            .iter()
            .find(|operation| {
                operation.operation == ace_runtime::provider::ProviderAdapterOperation::McpToolCall
            })
            .expect("mcp tool operation");
        assert_eq!(
            mcp_tool.declared_support,
            ProviderAdapterOperationSupport::VersionGated
        );
        assert_eq!(mcp_tool.provider_methods[0].support, VersionGated);

        let cloud_handoff = coverage
            .iter()
            .find(|operation| {
                operation.operation == ace_runtime::provider::ProviderAdapterOperation::CloudHandoff
            })
            .expect("cloud handoff operation");
        assert_eq!(
            cloud_handoff.provider_methods[0].support,
            IntentionallyDeferred
        );

        let browser_bridge = coverage
            .iter()
            .find(|operation| {
                operation.operation
                    == ace_runtime::provider::ProviderAdapterOperation::BrowserBridgeContract
            })
            .expect("browser bridge contract operation");
        assert_eq!(
            browser_bridge.declared_support,
            ProviderAdapterOperationSupport::Required
        );
        assert!(browser_bridge.provider_methods.is_empty());
        assert!(browser_bridge.fully_covered);
    }

    #[test]
    fn codex_client_request_inventory_is_represented_in_adapter_contract() {
        let contract = ace_runtime::provider::ace_provider_adapter_contract();
        let contract_methods = contract
            .operations
            .iter()
            .flat_map(|operation| operation.provider_methods.iter())
            .cloned()
            .collect::<BTreeSet<_>>();
        let adapter_bootstrap_or_schema_only = BTreeSet::from([
            "initialize".to_string(),
            "mock/experimentalMethod".to_string(),
        ]);
        let missing = CODEX_METHOD_INVENTORY
            .iter()
            .filter(|spec| {
                spec.direction == ClientRequest
                    && !adapter_bootstrap_or_schema_only.contains(spec.method)
                    && !contract_methods.contains(spec.method)
            })
            .map(|spec| spec.method)
            .collect::<Vec<_>>();

        assert!(
            missing.is_empty(),
            "Codex client request methods missing from provider adapter contract: {missing:#?}"
        );
    }
}

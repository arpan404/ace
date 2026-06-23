use ace_codex::{
    CodexAdapterOperationCoverage, CodexAppConfigWrite, CodexGoalSet,
    CodexGuardianDeniedActionApproval, CodexHandoffToAgent, CodexMethodDirection, CodexMethodSpec,
    CodexMethodSupport, CodexNamedQuery, CodexPermissionPreset, CodexPlanImplementation,
    CodexReviewStart, CodexSkillsConfigWrite, CodexSkillsExtraRootsSet, CodexSubagentSteer,
    CodexSubagentThreadRequest, CodexThreadStart, CodexTurnStart, CodexTurnSteer,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexRawRequest {
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct CodexVersionedRequest {
    #[serde(default)]
    pub params: Value,
}

pub type CodexReviewStartRequest = CodexReviewStart;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCommandExecRequest {
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "thread_id")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub env: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCommandProcessRequest {
    #[serde(alias = "process_id")]
    pub process_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCommandWriteStdinRequest {
    #[serde(alias = "process_id")]
    pub process_id: String,
    pub stdin: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCommandResizeRequest {
    #[serde(alias = "process_id")]
    pub process_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexProcessListRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "thread_id")]
    pub thread_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexProcessCleanRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "thread_id")]
    pub thread_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexThreadSearchRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "thread_id")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, flatten, skip_serializing_if = "serde_json::Map::is_empty")]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexThreadTurnsListRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "thread_id")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, flatten, skip_serializing_if = "serde_json::Map::is_empty")]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexThreadTurnsItemsListRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "thread_id")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "turn_id")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, flatten, skip_serializing_if = "serde_json::Map::is_empty")]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexMcpStatusRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexMcpResourceReadRequest {
    pub server: String,
    pub uri: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexMcpOauthLoginRequest {
    pub server: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexMcpToolCallRequest {
    pub server: String,
    pub tool: String,
    #[serde(default)]
    pub arguments: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexFsPathRequest {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexFsReadFileRequest {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexFsWriteFileRequest {
    pub path: String,
    pub contents: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overwrite: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexFsReadDirectoryRequest {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recursive: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexFsCopyRequest {
    #[serde(alias = "from_path")]
    pub from_path: String,
    #[serde(alias = "to_path")]
    pub to_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overwrite: Option<bool>,
}

pub type CodexNamedQueryRequest = CodexNamedQuery;
pub type CodexSkillRequest = ace_codex::CodexSkillRequest;
pub type CodexSkillsConfigWriteRequest = CodexSkillsConfigWrite;
pub type CodexSkillsExtraRootsSetRequest = CodexSkillsExtraRootsSet;
pub type CodexPluginRequest = ace_codex::CodexPluginRequest;
pub type CodexPluginShareRequest = ace_codex::CodexPluginShareRequest;
pub type CodexPluginShareSaveRequest = ace_codex::CodexPluginShareSave;
pub type CodexPluginShareUpdateTargetsRequest = ace_codex::CodexPluginShareUpdateTargets;
pub type CodexAppConfigWriteRequest = CodexAppConfigWrite;
pub type CodexMarketplaceRequest = ace_codex::CodexMarketplaceRequest;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRemoteHandoffRequest {
    #[serde(alias = "thread_id")]
    pub thread_id: String,
    pub host: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexThreadStartRequest {
    #[serde(flatten)]
    pub params: CodexThreadStart,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexThreadIdRequest {
    pub thread_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct CodexThreadsListRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_archived: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexThreadForkRequest {
    pub thread_id: String,
    #[serde(default)]
    pub ephemeral: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexThreadSetNameRequest {
    pub thread_id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexThreadUpdateMetadataRequest {
    pub thread_id: String,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexThreadRollbackRequest {
    pub thread_id: String,
    pub turn_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexThreadInjectItemsRequest {
    pub thread_id: String,
    #[serde(default)]
    pub items: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexTurnStartRequest {
    #[serde(flatten)]
    pub params: CodexTurnStart,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexTurnSteerRequest {
    #[serde(flatten)]
    pub params: CodexTurnSteer,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexPlanTurnStartRequest {
    pub thread_id: String,
    pub prompt: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexPlanImplementationRequest {
    #[serde(flatten)]
    pub params: CodexPlanImplementation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexPermissionPresetRequest {
    pub preset: CodexPermissionPreset,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexGuardianDeniedActionApprovalRequest {
    #[serde(flatten)]
    pub params: CodexGuardianDeniedActionApproval,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexGoalSetRequest {
    #[serde(flatten)]
    pub params: CodexGoalSet,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexSubagentThreadRpcRequest {
    #[serde(flatten)]
    pub params: CodexSubagentThreadRequest,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexSubagentSteerRequest {
    #[serde(flatten)]
    pub params: CodexSubagentSteer,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexHandoffToAgentRequest {
    #[serde(flatten)]
    pub params: CodexHandoffToAgent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexHandoffLocation {
    Local,
    Worktree,
    RemoteHost,
    Cloud,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexHandoffToLocationRequest {
    pub thread_id: String,
    pub repo_path: String,
    pub target_location: CodexHandoffLocation,
    pub preferred_branch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_point: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexHandoffToLocationResponse {
    pub source_thread_id: String,
    pub target_location: CodexHandoffLocation,
    pub target_thread_id: Option<String>,
    pub worktree_path: String,
    pub worktree_branch: String,
    pub repo_root: String,
    pub interrupted_active_turn: bool,
    #[serde(default)]
    pub thread_metadata: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexShutdownRequest {
    #[serde(default = "default_shutdown_grace_ms")]
    pub grace_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexStderrTailResponse {
    pub lines: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexCompatibilityMethod {
    pub method: String,
    pub direction: CodexMethodDirection,
    pub support: CodexMethodSupport,
    pub invocation: CodexCompatibilityInvocation,
    pub raw_request_allowed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl From<CodexMethodSpec> for CodexCompatibilityMethod {
    fn from(spec: CodexMethodSpec) -> Self {
        let invocation = codex_compatibility_invocation(spec);
        Self {
            method: spec.method.to_string(),
            direction: spec.direction,
            support: spec.support,
            invocation,
            raw_request_allowed: codex_raw_request_allowed(spec),
            reason: codex_invocation_reason(spec, invocation),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexCompatibilityInvocation {
    TypedApi,
    RawRequest,
    ServerNotification,
    ServerRequestResponse,
    Deferred,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexCompatibilityInventoryResponse {
    pub methods: Vec<CodexCompatibilityMethod>,
    pub summary: CodexCompatibilityInventorySummary,
    pub raw_request_policy: CodexRawRequestPolicy,
    #[serde(default)]
    pub adapter_contract_coverage: Vec<CodexAdapterOperationCoverage>,
    pub adapter_contract_coverage_summary: CodexAdapterContractCoverageSummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct CodexCompatibilityInventorySummary {
    pub total_methods: usize,
    pub client_request_methods: usize,
    pub client_notification_methods: usize,
    pub server_notification_methods: usize,
    pub server_request_methods: usize,
    pub typed_supported_methods: usize,
    pub raw_supported_methods: usize,
    pub version_gated_methods: usize,
    pub intentionally_deferred_methods: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct CodexAdapterContractCoverageSummary {
    pub total_operations: usize,
    pub covered_operations: usize,
    pub missing_method_operations: usize,
    pub support_mismatch_operations: usize,
    pub fully_covered: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexRawRequestPolicy {
    pub allowed_direction: CodexMethodDirection,
    pub allowed_supports: Vec<CodexMethodSupport>,
    pub rejected_supports: Vec<CodexMethodSupport>,
    pub rejects_unknown_methods: bool,
    pub rejects_non_client_request_directions: bool,
}

impl CodexCompatibilityInventoryResponse {
    #[must_use]
    pub fn from_specs(specs: impl IntoIterator<Item = CodexMethodSpec>) -> Self {
        Self::from_specs_and_adapter_coverage(specs, Vec::new())
    }

    #[must_use]
    pub fn from_specs_and_adapter_coverage(
        specs: impl IntoIterator<Item = CodexMethodSpec>,
        adapter_contract_coverage: Vec<CodexAdapterOperationCoverage>,
    ) -> Self {
        let mut summary = CodexCompatibilityInventorySummary::default();
        let methods = specs
            .into_iter()
            .map(|spec| {
                summary.total_methods += 1;
                match spec.direction {
                    CodexMethodDirection::ClientRequest => summary.client_request_methods += 1,
                    CodexMethodDirection::ClientNotification => {
                        summary.client_notification_methods += 1;
                    }
                    CodexMethodDirection::ServerNotification => {
                        summary.server_notification_methods += 1;
                    }
                    CodexMethodDirection::ServerRequest => summary.server_request_methods += 1,
                }
                match spec.support {
                    CodexMethodSupport::TypedSupported => summary.typed_supported_methods += 1,
                    CodexMethodSupport::RawSupported => summary.raw_supported_methods += 1,
                    CodexMethodSupport::VersionGated => summary.version_gated_methods += 1,
                    CodexMethodSupport::IntentionallyDeferred => {
                        summary.intentionally_deferred_methods += 1;
                    }
                }
                spec.into()
            })
            .collect();

        Self {
            methods,
            summary,
            raw_request_policy: CodexRawRequestPolicy {
                allowed_direction: CodexMethodDirection::ClientRequest,
                allowed_supports: vec![
                    CodexMethodSupport::TypedSupported,
                    CodexMethodSupport::RawSupported,
                    CodexMethodSupport::VersionGated,
                ],
                rejected_supports: vec![CodexMethodSupport::IntentionallyDeferred],
                rejects_unknown_methods: true,
                rejects_non_client_request_directions: true,
            },
            adapter_contract_coverage_summary: adapter_coverage_summary(&adapter_contract_coverage),
            adapter_contract_coverage,
        }
    }
}

fn adapter_coverage_summary(
    coverage: &[CodexAdapterOperationCoverage],
) -> CodexAdapterContractCoverageSummary {
    CodexAdapterContractCoverageSummary {
        total_operations: coverage.len(),
        covered_operations: coverage
            .iter()
            .filter(|operation| operation.fully_covered)
            .count(),
        missing_method_operations: coverage
            .iter()
            .filter(|operation| !operation.missing_methods.is_empty())
            .count(),
        support_mismatch_operations: coverage
            .iter()
            .filter(|operation| !operation.support_mismatches.is_empty())
            .count(),
        fully_covered: coverage.iter().all(|operation| operation.fully_covered),
    }
}

fn codex_compatibility_invocation(spec: CodexMethodSpec) -> CodexCompatibilityInvocation {
    match spec.direction {
        CodexMethodDirection::ClientRequest => match spec.support {
            CodexMethodSupport::TypedSupported => CodexCompatibilityInvocation::TypedApi,
            CodexMethodSupport::RawSupported | CodexMethodSupport::VersionGated => {
                CodexCompatibilityInvocation::RawRequest
            }
            CodexMethodSupport::IntentionallyDeferred => CodexCompatibilityInvocation::Deferred,
        },
        CodexMethodDirection::ClientNotification => CodexCompatibilityInvocation::TypedApi,
        CodexMethodDirection::ServerNotification => {
            CodexCompatibilityInvocation::ServerNotification
        }
        CodexMethodDirection::ServerRequest => CodexCompatibilityInvocation::ServerRequestResponse,
    }
}

fn codex_raw_request_allowed(spec: CodexMethodSpec) -> bool {
    spec.direction == CodexMethodDirection::ClientRequest
        && matches!(
            spec.support,
            CodexMethodSupport::TypedSupported
                | CodexMethodSupport::RawSupported
                | CodexMethodSupport::VersionGated
        )
}

fn codex_invocation_reason(
    spec: CodexMethodSpec,
    invocation: CodexCompatibilityInvocation,
) -> Option<String> {
    match invocation {
        CodexCompatibilityInvocation::TypedApi => None,
        CodexCompatibilityInvocation::RawRequest => Some(match spec.support {
            CodexMethodSupport::VersionGated => {
                "version-gated client request; use raw request when the installed Codex supports it"
            }
            _ => "client request accepted by raw request policy",
        }
        .to_string()),
        CodexCompatibilityInvocation::ServerNotification => {
            Some("delivered through provider runtime event stream".to_string())
        }
        CodexCompatibilityInvocation::ServerRequestResponse => {
            Some("respond through provider runtime server-request APIs".to_string())
        }
        CodexCompatibilityInvocation::Deferred => {
            Some("intentionally deferred and rejected by raw request policy".to_string())
        }
    }
}

fn default_shutdown_grace_ms() -> u64 {
    1_000
}

#[cfg(test)]
mod tests {
    use ace_codex::{
        CodexMethodDirection, CodexMethodSpec, CodexMethodSupport, codex_method_inventory,
    };

    use super::*;

    #[test]
    fn compatibility_inventory_summarizes_methods_and_raw_request_policy() {
        let inventory = CodexCompatibilityInventoryResponse::from_specs(
            codex_method_inventory().iter().copied(),
        );

        assert_eq!(
            inventory.summary.total_methods,
            codex_method_inventory().len()
        );
        assert!(inventory.summary.client_request_methods > 0);
        assert!(inventory.summary.server_notification_methods > 0);
        assert!(inventory.summary.server_request_methods > 0);
        assert!(inventory.summary.version_gated_methods > 0);
        assert!(inventory.summary.intentionally_deferred_methods > 0);
        assert_eq!(
            inventory.raw_request_policy.allowed_direction,
            CodexMethodDirection::ClientRequest
        );
        assert!(
            inventory
                .raw_request_policy
                .allowed_supports
                .contains(&CodexMethodSupport::VersionGated)
        );
        assert!(
            inventory
                .raw_request_policy
                .rejected_supports
                .contains(&CodexMethodSupport::IntentionallyDeferred)
        );
        assert!(inventory.raw_request_policy.rejects_unknown_methods);
        assert!(
            inventory
                .raw_request_policy
                .rejects_non_client_request_directions
        );
        let thread_start = inventory
            .methods
            .iter()
            .find(|method| method.method == "thread/start")
            .expect("thread start");
        assert_eq!(
            thread_start.invocation,
            CodexCompatibilityInvocation::TypedApi
        );
        assert!(thread_start.raw_request_allowed);
        assert_eq!(thread_start.reason, None);

        let command_exec = inventory
            .methods
            .iter()
            .find(|method| method.method == "command/exec")
            .expect("command exec");
        assert_eq!(
            command_exec.invocation,
            CodexCompatibilityInvocation::RawRequest
        );
        assert!(command_exec.raw_request_allowed);
        assert!(
            command_exec
                .reason
                .as_deref()
                .expect("command reason")
                .contains("version-gated")
        );

        let item_completed = inventory
            .methods
            .iter()
            .find(|method| method.method == "item/completed")
            .expect("item completed");
        assert_eq!(
            item_completed.invocation,
            CodexCompatibilityInvocation::ServerNotification
        );
        assert!(!item_completed.raw_request_allowed);

        let command_approval = inventory
            .methods
            .iter()
            .find(|method| method.method == "command/approvalRequest")
            .expect("command approval");
        assert_eq!(
            command_approval.invocation,
            CodexCompatibilityInvocation::ServerRequestResponse
        );
        assert!(!command_approval.raw_request_allowed);

        let cloud_handoff = inventory
            .methods
            .iter()
            .find(|method| method.method == "cloud/handoff")
            .expect("cloud handoff");
        assert_eq!(
            cloud_handoff.invocation,
            CodexCompatibilityInvocation::Deferred
        );
        assert!(!cloud_handoff.raw_request_allowed);
        assert!(inventory.adapter_contract_coverage.is_empty());
        assert_eq!(
            inventory.adapter_contract_coverage_summary,
            CodexAdapterContractCoverageSummary {
                total_operations: 0,
                covered_operations: 0,
                missing_method_operations: 0,
                support_mismatch_operations: 0,
                fully_covered: true,
            }
        );
    }

    #[test]
    fn compatibility_inventory_counts_custom_specs() {
        let inventory = CodexCompatibilityInventoryResponse::from_specs([
            CodexMethodSpec::new(
                "thread/start",
                CodexMethodDirection::ClientRequest,
                CodexMethodSupport::TypedSupported,
            ),
            CodexMethodSpec::new(
                "warning",
                CodexMethodDirection::ServerNotification,
                CodexMethodSupport::RawSupported,
            ),
            CodexMethodSpec::new(
                "cloud/handoff",
                CodexMethodDirection::ClientRequest,
                CodexMethodSupport::IntentionallyDeferred,
            ),
        ]);

        assert_eq!(inventory.summary.total_methods, 3);
        assert_eq!(inventory.summary.client_request_methods, 2);
        assert_eq!(inventory.summary.server_notification_methods, 1);
        assert_eq!(inventory.summary.typed_supported_methods, 1);
        assert_eq!(inventory.summary.raw_supported_methods, 1);
        assert_eq!(inventory.summary.intentionally_deferred_methods, 1);
    }

    #[test]
    fn compatibility_inventory_summarizes_adapter_contract_coverage() {
        let contract = ace_runtime::provider::ace_provider_adapter_contract();
        let coverage = ace_codex::codex_adapter_contract_coverage(&contract);
        let inventory = CodexCompatibilityInventoryResponse::from_specs_and_adapter_coverage(
            codex_method_inventory().iter().copied(),
            coverage,
        );

        assert_eq!(
            inventory.adapter_contract_coverage_summary.total_operations,
            contract.operations.len()
        );
        assert_eq!(
            inventory
                .adapter_contract_coverage_summary
                .covered_operations,
            contract.operations.len()
        );
        assert_eq!(
            inventory
                .adapter_contract_coverage_summary
                .missing_method_operations,
            0
        );
        assert_eq!(
            inventory
                .adapter_contract_coverage_summary
                .support_mismatch_operations,
            0
        );
        assert!(inventory.adapter_contract_coverage_summary.fully_covered);
        assert!(
            inventory
                .adapter_contract_coverage
                .iter()
                .any(|operation| operation.operation
                    == ace_runtime::provider::ProviderAdapterOperation::PlanForkForImplementation
                    && operation.fully_covered)
        );
    }
}

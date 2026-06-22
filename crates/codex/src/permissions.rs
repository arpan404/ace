use ace_runtime::threads::PermissionPolicy;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexPermissionPreset {
    Strict,
    Auto,
    AutoReview,
    FullAccess,
}

impl CodexPermissionPreset {
    #[must_use]
    pub fn as_key(self) -> &'static str {
        match self {
            Self::Strict => "strict",
            Self::Auto => "auto",
            Self::AutoReview => "auto_review",
            Self::FullAccess => "full_access",
        }
    }

    #[must_use]
    pub fn turn_permissions(self) -> CodexTurnPermissions {
        match self {
            Self::Strict => CodexTurnPermissions {
                sandbox_policy: json!({
                    "mode": "read-only",
                    "networkAccess": "restricted",
                }),
                approval_policy: json!({ "mode": "on-request" }),
                approvals_reviewer: Some(CodexApprovalsReviewer::User),
            },
            Self::Auto => CodexTurnPermissions {
                sandbox_policy: json!({
                    "mode": "workspace-write",
                    "networkAccess": "restricted",
                }),
                approval_policy: json!({ "mode": "on-request" }),
                approvals_reviewer: Some(CodexApprovalsReviewer::User),
            },
            Self::AutoReview => CodexTurnPermissions {
                sandbox_policy: json!({
                    "mode": "workspace-write",
                    "networkAccess": "restricted",
                }),
                approval_policy: json!({ "mode": "on-request" }),
                approvals_reviewer: Some(CodexApprovalsReviewer::AutoReview),
            },
            Self::FullAccess => CodexTurnPermissions {
                sandbox_policy: json!({
                    "mode": "danger-full-access",
                    "networkAccess": "enabled",
                }),
                approval_policy: json!({ "mode": "never" }),
                approvals_reviewer: None,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexApprovalsReviewer {
    User,
    AutoReview,
}

impl CodexApprovalsReviewer {
    #[must_use]
    pub fn as_codex_value(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::AutoReview => "auto_review",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexTurnPermissions {
    pub sandbox_policy: Value,
    pub approval_policy: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approvals_reviewer: Option<CodexApprovalsReviewer>,
}

impl CodexTurnPermissions {
    #[must_use]
    pub fn approvals_reviewer_value(&self) -> Option<&'static str> {
        self.approvals_reviewer
            .map(CodexApprovalsReviewer::as_codex_value)
    }

    #[must_use]
    pub fn normalized_policy(&self) -> PermissionPolicy {
        PermissionPolicy::from_raw(
            self.sandbox_policy.clone(),
            self.approval_policy.clone(),
            self.approvals_reviewer_value().map(ToString::to_string),
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexPermissionCatalog {
    pub requirements: Value,
    pub profiles: Value,
    pub available_presets: Vec<CodexPermissionPreset>,
    pub presets: Vec<CodexPermissionPresetCatalogEntry>,
}

impl CodexPermissionCatalog {
    #[must_use]
    pub fn from_sources(requirements: Value, profiles: Value) -> Self {
        let presets = permission_preset_catalog_entries(&requirements, &profiles);
        let available_presets = presets
            .iter()
            .filter(|entry| entry.available)
            .map(|entry| entry.preset)
            .collect();
        Self {
            requirements,
            profiles,
            available_presets,
            presets,
        }
    }

    #[must_use]
    pub fn preset_entry(
        &self,
        preset: CodexPermissionPreset,
    ) -> Option<&CodexPermissionPresetCatalogEntry> {
        self.presets.iter().find(|entry| entry.preset == preset)
    }

    #[must_use]
    pub fn is_preset_available(&self, preset: CodexPermissionPreset) -> bool {
        self.preset_entry(preset)
            .map(|entry| entry.available)
            .unwrap_or(false)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexPermissionPresetCatalogEntry {
    pub preset: CodexPermissionPreset,
    pub key: String,
    pub label: String,
    pub permissions: CodexTurnPermissions,
    pub normalized_policy: PermissionPolicy,
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexGuardianDeniedActionApproval {
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_id: Option<String>,
    #[serde(default)]
    pub approved: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default)]
    pub audit: Value,
}

#[must_use]
pub fn available_permission_presets(
    requirements: &Value,
    profiles: &Value,
) -> Vec<CodexPermissionPreset> {
    permission_preset_catalog_entries(requirements, profiles)
        .into_iter()
        .filter(|entry| entry.available)
        .map(|entry| entry.preset)
        .collect()
}

#[must_use]
pub fn permission_preset_catalog_entries(
    requirements: &Value,
    profiles: &Value,
) -> Vec<CodexPermissionPresetCatalogEntry> {
    let all = [
        CodexPermissionPreset::Strict,
        CodexPermissionPreset::Auto,
        CodexPermissionPreset::AutoReview,
        CodexPermissionPreset::FullAccess,
    ];
    let allowed = string_set_from_any_path(
        requirements,
        &[
            "/allowedPermissionPresets",
            "/allowed_permission_presets",
            "/permissions/allowedPresets",
            "/permissions/allowed_presets",
        ],
    );
    let denied = string_set_from_any_path(
        requirements,
        &[
            "/deniedPermissionPresets",
            "/denied_permission_presets",
            "/permissions/deniedPresets",
            "/permissions/denied_presets",
        ],
    )
    .unwrap_or_default();
    let profile_names = profile_names(profiles);

    all.into_iter()
        .map(|preset| {
            let key = preset.as_key();
            let unavailable_reason = if let Some(allowed) = allowed.as_ref()
                && !allowed.iter().any(|value| preset_key_matches(value, key))
            {
                Some("blocked_by_managed_allow_list".to_string())
            } else if denied.iter().any(|value| preset_key_matches(value, key)) {
                Some("blocked_by_managed_deny_list".to_string())
            } else if !profile_names.is_empty()
                && !profile_names.iter().any(|value| {
                    preset_key_matches(value, key) || profile_supports_preset(value, preset)
                })
            {
                Some("missing_permission_profile".to_string())
            } else {
                None
            };
            let permissions = preset.turn_permissions();
            let normalized_policy = permissions.normalized_policy();
            CodexPermissionPresetCatalogEntry {
                preset,
                key: key.to_string(),
                label: preset.label().to_string(),
                permissions,
                normalized_policy,
                available: unavailable_reason.is_none(),
                unavailable_reason,
            }
        })
        .collect()
}

impl CodexPermissionPreset {
    #[must_use]
    fn label(self) -> &'static str {
        match self {
            Self::Strict => "Strict",
            Self::Auto => "Auto",
            Self::AutoReview => "Auto Review",
            Self::FullAccess => "Full Access",
        }
    }
}

fn string_set_from_any_path(value: &Value, paths: &[&str]) -> Option<Vec<String>> {
    paths.iter().find_map(|path| {
        value.pointer(path).and_then(|candidate| {
            candidate.as_array().map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(normalize_key)
                    .collect::<Vec<_>>()
            })
        })
    })
}

fn profile_names(profiles: &Value) -> Vec<String> {
    profiles
        .get("profiles")
        .or_else(|| profiles.get("permissionProfiles"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|profile| {
            profile
                .get("id")
                .or_else(|| profile.get("name"))
                .or_else(|| profile.get("key"))
                .and_then(Value::as_str)
        })
        .map(normalize_key)
        .collect()
}

fn preset_key_matches(value: &str, key: &str) -> bool {
    normalize_key(value) == normalize_key(key)
}

fn profile_supports_preset(profile: &str, preset: CodexPermissionPreset) -> bool {
    match preset {
        CodexPermissionPreset::Strict => {
            profile.contains("strict")
                || profile.contains("read_only")
                || profile.contains("readonly")
        }
        CodexPermissionPreset::Auto => {
            profile.contains("auto") || profile.contains("workspace_write")
        }
        CodexPermissionPreset::AutoReview => {
            profile.contains("auto_review") || profile.contains("autoreview")
        }
        CodexPermissionPreset::FullAccess => {
            profile.contains("full_access") || profile.contains("danger_full_access")
        }
    }
}

fn normalize_key(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .replace(['-', ' ', '.'], "_")
}

#[cfg(test)]
mod tests {
    use super::*;
    use ace_runtime::threads::{
        PermissionApprovalMode, PermissionApprovalReviewer, PermissionNetworkAccess,
        PermissionSandboxMode,
    };
    use serde_json::json;

    #[test]
    fn maps_permission_presets_to_codex_turn_policy_payloads() {
        let strict = CodexPermissionPreset::Strict.turn_permissions();
        assert_eq!(strict.sandbox_policy["mode"], "read-only");
        assert_eq!(strict.approval_policy["mode"], "on-request");
        assert_eq!(strict.approvals_reviewer_value(), Some("user"));

        let auto_review = CodexPermissionPreset::AutoReview.turn_permissions();
        assert_eq!(auto_review.sandbox_policy["mode"], "workspace-write");
        assert_eq!(auto_review.approvals_reviewer_value(), Some("auto_review"));
        let auto_review_normalized = auto_review.normalized_policy();
        assert_eq!(
            auto_review_normalized.sandbox_mode,
            PermissionSandboxMode::WorkspaceWrite
        );
        assert_eq!(
            auto_review_normalized.approval_mode,
            PermissionApprovalMode::OnRequest
        );
        assert_eq!(
            auto_review_normalized.approval_reviewer,
            Some(PermissionApprovalReviewer::AutoReview)
        );

        let full_access = CodexPermissionPreset::FullAccess.turn_permissions();
        assert_eq!(full_access.sandbox_policy["mode"], "danger-full-access");
        assert_eq!(full_access.approval_policy["mode"], "never");
        assert_eq!(full_access.approvals_reviewer_value(), None);
        assert!(
            full_access
                .normalized_policy()
                .allows_full_access_without_prompts()
        );
    }

    #[test]
    fn permission_catalog_honors_managed_allow_and_deny_lists() {
        let requirements = json!({
            "allowedPermissionPresets": ["strict", "auto-review", "full_access"],
            "deniedPermissionPresets": ["full-access"]
        });
        let profiles = json!({
            "profiles": [
                { "id": "strict" },
                { "id": "auto_review" },
                { "id": "danger-full-access" }
            ]
        });

        let available = available_permission_presets(&requirements, &profiles);
        assert_eq!(
            available,
            [
                CodexPermissionPreset::Strict,
                CodexPermissionPreset::AutoReview,
            ]
        );

        let catalog = CodexPermissionCatalog::from_sources(requirements, profiles);
        assert!(catalog.is_preset_available(CodexPermissionPreset::Strict));
        assert!(!catalog.is_preset_available(CodexPermissionPreset::FullAccess));
        let full_access = catalog
            .preset_entry(CodexPermissionPreset::FullAccess)
            .expect("full access entry");
        assert_eq!(full_access.key, "full_access");
        assert_eq!(full_access.label, "Full Access");
        assert_eq!(
            full_access.unavailable_reason.as_deref(),
            Some("blocked_by_managed_deny_list")
        );
        assert_eq!(
            full_access.permissions.sandbox_policy["mode"],
            "danger-full-access"
        );
        assert_eq!(
            full_access.normalized_policy.sandbox_mode,
            PermissionSandboxMode::DangerFullAccess
        );
        assert_eq!(
            full_access.normalized_policy.network_access,
            PermissionNetworkAccess::Enabled
        );
        assert_eq!(
            full_access.normalized_policy.approval_mode,
            PermissionApprovalMode::Never
        );
    }

    #[test]
    fn permission_catalog_marks_missing_profiles_unavailable() {
        let catalog = CodexPermissionCatalog::from_sources(
            json!({}),
            json!({ "profiles": [{ "id": "strict" }] }),
        );

        assert!(catalog.is_preset_available(CodexPermissionPreset::Strict));
        assert!(!catalog.is_preset_available(CodexPermissionPreset::Auto));
        assert_eq!(
            catalog
                .preset_entry(CodexPermissionPreset::Auto)
                .and_then(|entry| entry.unavailable_reason.as_deref()),
            Some("missing_permission_profile")
        );
    }
}

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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexPermissionCatalog {
    pub requirements: Value,
    pub profiles: Value,
    pub available_presets: Vec<CodexPermissionPreset>,
}

impl CodexPermissionCatalog {
    #[must_use]
    pub fn from_sources(requirements: Value, profiles: Value) -> Self {
        let available_presets = available_permission_presets(&requirements, &profiles);
        Self {
            requirements,
            profiles,
            available_presets,
        }
    }
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
        .filter(|preset| {
            let key = preset.as_key();
            if let Some(allowed) = allowed.as_ref()
                && !allowed.iter().any(|value| preset_key_matches(value, key))
            {
                return false;
            }
            if denied.iter().any(|value| preset_key_matches(value, key)) {
                return false;
            }
            profile_names.is_empty()
                || profile_names.iter().any(|value| {
                    preset_key_matches(value, key) || profile_supports_preset(value, *preset)
                })
        })
        .collect()
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

        let full_access = CodexPermissionPreset::FullAccess.turn_permissions();
        assert_eq!(full_access.sandbox_policy["mode"], "danger-full-access");
        assert_eq!(full_access.approval_policy["mode"], "never");
        assert_eq!(full_access.approvals_reviewer_value(), None);
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
    }
}

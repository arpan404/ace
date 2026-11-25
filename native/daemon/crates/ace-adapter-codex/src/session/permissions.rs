// SPDX-License-Identifier: Apache-2.0
//! What an ace permission mode becomes for Codex (`permission-policy.ts` and
//! `default-permissions.ts`): an ace selector names the native profile and the
//! reviewer, and a session that never chose one asks Codex for its own default
//! instead of resetting it. The agent's shell variables are per-thread config
//! overrides (`shell-env.ts`), because one app-server serves many threads.

use ace_json::{JsString, Map, Value};

/// `configuredTurnPolicy`'s refusal: the previous native permission stays.
pub const CONFIGURED_DEFAULT_MISSING: &str = "Codex did not report its configured permission default. The previous native permission remains applied; choose an explicit mode before continuing.";

/// The approval policies Codex names.
const APPROVAL_POLICIES: [&str; 3] = ["untrusted", "on-request", "never"];
/// The reviewers Codex names.
const REVIEWERS: [&str; 3] = ["user", "auto_review", "guardian_subagent"];
/// The sandbox modes, and the permission each one is.
const SANDBOX_MODES: [(&str, &str); 3] = [
    ("read-only", ":read-only"),
    ("workspace-write", ":workspace"),
    ("danger-full-access", ":danger-full-access"),
];
/// The granular approval keys (`granular`).
const GRANULAR_KEYS: [&str; 5] = [
    "sandbox_approval",
    "rules",
    "skill_approval",
    "request_permissions",
    "mcp_elicitations",
];
/// The longest profile name Codex accepts (`z.string().min(1).max(256)`).
const PROFILE_MAX: usize = 256;

/// `codexThreadPolicy(mode)` (and `codexTurnPolicy`, which is the same policy):
/// a selector without `{` is the native profile itself; a JSON selector is
/// ace's structured options.
pub fn codex_thread_policy(mode: Option<&str>) -> Result<Map, String> {
    let Some(mode) = mode else {
        return Ok(Map::new());
    };
    if !mode.starts_with('{') {
        return Ok(profile(mode));
    }
    let parsed = ace_json::parse(mode)
        .map_err(|error| format!("Codex permission mode is not JSON: {error}"))?;
    permission_options(&parsed)
}

/// `CodexPermissionOptions`: `permissions`, an optional `approvalPolicy` and the
/// required `approvalsReviewer`, strict.
fn permission_options(value: &Value) -> Result<Map, String> {
    let Some(options) = value.as_object() else {
        return Err("Codex permission mode must be a JSON object".to_owned());
    };
    for key in options.keys() {
        if !matches!(
            key.as_str(),
            "permissions" | "approvalPolicy" | "approvalsReviewer"
        ) {
            return Err(format!(
                "Unrecognized key \"{key}\" in Codex permission mode"
            ));
        }
    }
    let permissions = text(options.get("permissions"))
        .filter(|text| !text.is_empty() && text.len_utf16() <= PROFILE_MAX)
        .ok_or_else(|| "Codex permission mode needs a profile of 1 to 256 characters".to_owned())?;
    let reviewer = text(options.get("approvalsReviewer"))
        .filter(|text| REVIEWERS.contains(&text.as_str()))
        .ok_or_else(|| "Codex permission mode needs a reviewer".to_owned())?;
    let mut policy = profile(&permissions);
    policy.insert("approvalsReviewer", Value::from(reviewer));
    if let Some(approval) = text(options.get("approvalPolicy")) {
        if !APPROVAL_POLICIES.contains(&approval.as_str()) {
            return Err(format!(
                "Codex approval policy is not one Codex names: {approval}"
            ));
        }
        policy.insert("approvalPolicy", Value::from(approval));
    }
    Ok(policy)
}

/// `codexTurnPolicy(mode, cwd)`: the turn takes the same policy the thread
/// start does (`permission-policy.ts:17`-`:21`).
pub fn codex_turn_policy(mode: Option<&str>) -> Result<Map, String> {
    codex_thread_policy(mode)
}

fn profile(permissions: &str) -> Map {
    let mut policy = Map::new();
    policy.insert("permissions", Value::from(permissions));
    policy
}

/// `configuredTurnPolicy(configRead)`: Codex's own default, used when the
/// session never chose an ace mode. An omitted turn override preserves sticky
/// native settings, so it cannot reset them.
pub fn configured_turn_policy(value: &Value) -> Result<Map, String> {
    let config = value
        .get("config")
        .and_then(Value::as_object)
        .ok_or_else(|| CONFIGURED_DEFAULT_MISSING.to_owned())?;
    let permissions = match config.get("default_permissions") {
        None | Some(Value::Null) => {
            let mode = text(config.get("sandbox_mode"));
            mode.and_then(|mode| {
                SANDBOX_MODES
                    .iter()
                    .find(|(name, _)| *name == mode.as_str())
                    .map(|(_, profile)| JsString::from(*profile))
            })
        }
        // `z.string().min(1).max(256)`: a present value must be a profile name
        // of that length, so a bad one never falls back to the sandbox mode.
        Some(Value::String(name)) if !name.is_empty() && name.len_utf16() <= PROFILE_MAX => {
            Some(name.clone())
        }
        Some(_) => {
            return Err(format!(
                "Codex default_permissions must be 1 to {PROFILE_MAX} characters"
            ));
        }
    };
    let approval = config
        .get("approval_policy")
        .filter(|value| !value.is_null());
    let (Some(permissions), Some(approval)) = (permissions, approval) else {
        return Err(CONFIGURED_DEFAULT_MISSING.to_owned());
    };
    let approval = match approval {
        Value::String(name) if APPROVAL_POLICIES.contains(&name.as_str()) => approval.clone(),
        Value::String(name) => {
            return Err(format!(
                "Codex approval policy is not one Codex names: {}",
                name.as_str()
            ));
        }
        Value::Object(map) => {
            let granular = map
                .get("granular")
                .and_then(Value::as_object)
                .filter(|granular| {
                    GRANULAR_KEYS
                        .iter()
                        .all(|key| granular.get(key).is_some_and(Value::is_boolean))
                })
                .ok_or_else(|| CONFIGURED_DEFAULT_MISSING.to_owned())?;
            let mut kept = Map::new();
            let mut inner = Map::new();
            for key in GRANULAR_KEYS {
                let flag = granular.get(key).and_then(Value::as_bool).unwrap_or(false);
                inner.insert(key, Value::Bool(flag));
            }
            kept.insert("granular", Value::Object(inner));
            Value::Object(kept)
        }
        _ => return Err(CONFIGURED_DEFAULT_MISSING.to_owned()),
    };
    let reviewer = match config.get("approvals_reviewer") {
        None | Some(Value::Null) => "user".to_owned(),
        Some(Value::String(name)) if REVIEWERS.contains(&name.as_str()) => name.as_str().to_owned(),
        Some(_) => return Err(CONFIGURED_DEFAULT_MISSING.to_owned()),
    };
    let mut policy = profile(&permissions);
    policy.insert("approvalPolicy", approval);
    policy.insert("approvalsReviewer", Value::from(reviewer));
    Ok(policy)
}

/// `codexShellEnvConfig(agentEnv)`: each variable is its own dotted
/// `shell_environment_policy.set` key, so the person's own entries stay. A name
/// that would split the dotted path is left out.
pub fn codex_shell_env_config(agent_env: Option<&Map>) -> Map {
    let mut config = Map::new();
    for (name, value) in agent_env.into_iter().flatten() {
        let name = name.as_str();
        if !is_shell_variable(name) {
            continue;
        }
        let Some(value) = value.as_str() else {
            continue;
        };
        config.insert(
            format!("shell_environment_policy.set.{name}"),
            Value::from(value.to_owned()),
        );
    }
    config
}

/// `/^[A-Z][A-Z0-9_]*$/`.
fn is_shell_variable(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|first| first.is_ascii_uppercase())
        && chars.all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '_')
}

fn text(value: Option<&Value>) -> Option<JsString> {
    match value {
        Some(Value::String(text)) => Some(text.clone()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(text: &str) -> Value {
        ace_json::parse(text).expect("fixture parses")
    }

    fn object(map: Map) -> Value {
        Value::Object(map)
    }

    #[test]
    fn an_ace_mode_names_the_native_profile_and_reviewer_for_thread_and_turn() {
        for (mode, policy) in [
            (":read-only", r#"{"permissions":":read-only"}"#),
            (":workspace", r#"{"permissions":":workspace"}"#),
            (
                ":danger-full-access",
                r#"{"permissions":":danger-full-access"}"#,
            ),
            (
                r#"{"permissions":":workspace","approvalsReviewer":"auto_review"}"#,
                r#"{"permissions":":workspace","approvalsReviewer":"auto_review"}"#,
            ),
            (
                r#"{"permissions":":workspace","approvalsReviewer":"guardian_subagent"}"#,
                r#"{"permissions":":workspace","approvalsReviewer":"guardian_subagent"}"#,
            ),
        ] {
            assert_eq!(
                object(codex_thread_policy(Some(mode)).expect("a named mode")),
                json(policy),
                "thread policy for {mode}"
            );
            assert_eq!(
                object(codex_turn_policy(Some(mode)).expect("a named mode")),
                json(policy),
                "turn policy for {mode}"
            );
        }
    }

    #[test]
    fn an_ace_selectors_approval_policy_is_kept_beside_its_profile() {
        let mode =
            r#"{"permissions":":workspace","approvalPolicy":"never","approvalsReviewer":"user"}"#;
        assert_eq!(
            object(codex_thread_policy(Some(mode)).expect("a named mode")),
            json(mode)
        );
    }

    #[test]
    fn no_chosen_mode_leaves_codexs_own_configuration_in_place() {
        assert_eq!(
            object(codex_thread_policy(None).expect("nothing chosen")),
            json("{}")
        );
    }

    #[test]
    fn codexs_own_default_carries_its_reviewer_and_says_user_when_it_names_none() {
        assert_eq!(
            object(
                configured_turn_policy(&json(
                    r#"{"config":{"default_permissions":":workspace","approval_policy":"on-request"}}"#,
                ))
                .expect("a reported default"),
            ),
            json(r#"{"permissions":":workspace","approvalPolicy":"on-request","approvalsReviewer":"user"}"#)
        );
        assert_eq!(
            object(
                configured_turn_policy(&json(
                    r#"{"config":{"default_permissions":":read-only","approval_policy":"never","approvals_reviewer":"auto_review"}}"#,
                ))
                .expect("a reported default"),
            ),
            json(r#"{"permissions":":read-only","approvalPolicy":"never","approvalsReviewer":"auto_review"}"#)
        );
    }

    #[test]
    fn a_default_permission_outside_its_bound_or_not_a_string_is_refused() {
        let long = "x".repeat(257);
        for config in [
            r#"{"config":{"default_permissions":"","approval_policy":"never"}}"#.to_owned(),
            format!(
                r#"{{"config":{{"default_permissions":"{long}","approval_policy":"never"}}}}"#
            ),
            // zod's parse fails here; it is not a reason to fall back to the sandbox.
            r#"{"config":{"default_permissions":5,"sandbox_mode":"read-only","approval_policy":"never"}}"#.to_owned(),
        ] {
            assert_eq!(
                configured_turn_policy(&json(&config)),
                Err(format!("Codex default_permissions must be 1 to {PROFILE_MAX} characters")),
                "{config}"
            );
        }
    }

    #[test]
    fn a_sandbox_mode_stands_in_for_a_default_permission() {
        assert_eq!(
            object(
                configured_turn_policy(&json(
                    r#"{"config":{"sandbox_mode":"workspace-write","approval_policy":"untrusted"}}"#,
                ))
                .expect("a reported default"),
            ),
            json(r#"{"permissions":":workspace","approvalPolicy":"untrusted","approvalsReviewer":"user"}"#)
        );
    }

    #[test]
    fn a_granular_approval_policy_survives_the_read() {
        assert_eq!(
            object(
                configured_turn_policy(&json(
                    r#"{"config":{"default_permissions":":workspace","approval_policy":{"granular":{"sandbox_approval":true,"rules":false,"skill_approval":true,"request_permissions":false,"mcp_elicitations":true}}}}"#,
                ))
                .expect("a reported default"),
            ),
            json(
                r#"{"permissions":":workspace","approvalPolicy":{"granular":{"sandbox_approval":true,"rules":false,"skill_approval":true,"request_permissions":false,"mcp_elicitations":true}},"approvalsReviewer":"user"}"#,
            )
        );
    }

    #[test]
    fn a_default_codex_did_not_report_is_refused_rather_than_guessed() {
        assert_eq!(
            configured_turn_policy(&json(r#"{"config":{"default_permissions":":workspace"}}"#)),
            Err(CONFIGURED_DEFAULT_MISSING.to_owned())
        );
        assert_eq!(
            configured_turn_policy(&json("{}")),
            Err(CONFIGURED_DEFAULT_MISSING.to_owned())
        );
    }

    #[test]
    fn each_agent_variable_is_its_own_shell_environment_policy_set_override() {
        let agent_env = json(r#"{"ACE_THREAD_ID":"t_1","ACE_NO_INPUT":"1","ACE_HOME":"/h/.ace"}"#);
        assert_eq!(
            object(codex_shell_env_config(agent_env.as_object())),
            json(
                r#"{"shell_environment_policy.set.ACE_THREAD_ID":"t_1","shell_environment_policy.set.ACE_NO_INPUT":"1","shell_environment_policy.set.ACE_HOME":"/h/.ace"}"#,
            )
        );
    }

    #[test]
    fn a_session_without_agent_variables_adds_no_overrides() {
        assert_eq!(object(codex_shell_env_config(None)), json("{}"));
    }

    #[test]
    fn a_name_that_would_split_the_dotted_config_path_is_left_out() {
        let agent_env = json(r#"{"A.B":"x","ok_lower":"y"}"#);
        assert_eq!(
            object(codex_shell_env_config(agent_env.as_object())),
            json("{}")
        );
    }
}

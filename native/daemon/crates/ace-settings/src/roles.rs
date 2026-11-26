// SPDX-License-Identifier: Apache-2.0
//! The four role slots and the values a person configured (`roles.ts`). A role is set
//! only by its provider; model, tier and effort stay out while they are `default`.

use serde_json::{Map, Value};

/// A `delegate` task's run role.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum RunRole {
    Build,
    Judgment,
    Review,
    Verify,
}

impl RunRole {
    pub const ALL: [RunRole; 4] = [
        RunRole::Build,
        RunRole::Judgment,
        RunRole::Review,
        RunRole::Verify,
    ];

    /// The settings slot this role reads (`coder`, `planner`, …).
    pub fn slot(self) -> &'static str {
        match self {
            Self::Build => "coder",
            Self::Judgment => "planner",
            Self::Review => "reviewer",
            Self::Verify => "verifier",
        }
    }

    /// The role's own name, as clients spell it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Build => "build",
            Self::Judgment => "judgment",
            Self::Review => "review",
            Self::Verify => "verify",
        }
    }
}

/// One role's four settings keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RoleKeys {
    pub provider: &'static str,
    pub model: &'static str,
    pub tier: &'static str,
    pub effort: &'static str,
}

pub fn role_keys(role: RunRole) -> RoleKeys {
    match role {
        RunRole::Build => RoleKeys {
            provider: "providers.coder.provider",
            model: "providers.coder.model",
            tier: "providers.coder.tier",
            effort: "providers.coder.reasoningEffort",
        },
        RunRole::Judgment => RoleKeys {
            provider: "providers.planner.provider",
            model: "providers.planner.model",
            tier: "providers.planner.tier",
            effort: "providers.planner.reasoningEffort",
        },
        RunRole::Review => RoleKeys {
            provider: "providers.reviewer.provider",
            model: "providers.reviewer.model",
            tier: "providers.reviewer.tier",
            effort: "providers.reviewer.reasoningEffort",
        },
        RunRole::Verify => RoleKeys {
            provider: "providers.verifier.provider",
            model: "providers.verifier.model",
            tier: "providers.verifier.tier",
            effort: "providers.verifier.reasoningEffort",
        },
    }
}

/// Every role setting, for one read or subscription (16 keys).
pub fn role_setting_keys() -> Vec<&'static str> {
    RunRole::ALL
        .into_iter()
        .flat_map(|role| {
            let keys = role_keys(role);
            [keys.provider, keys.model, keys.tier, keys.effort]
        })
        .collect()
}

/// A set role: its provider, and only the fields changed from `default`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoleChoice {
    pub provider: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub tier: Option<String>,
}

/// A stored value checked against its key's schema; anything else counts as unset
/// (`roles.ts`'s `read`).
fn read(values: &Map<String, Value>, key: &str) -> Option<Value> {
    crate::schema::validate_value(key, values.get(key)?).ok()
}

/// A validated text value that isn't `default`.
fn text(values: &Map<String, Value>, key: &str) -> Option<String> {
    let value = read(values, key)?.as_str()?.trim().to_owned();
    (!value.is_empty() && value != "default").then_some(value)
}

/// A validated provider name.
fn provider(values: &Map<String, Value>, key: &str) -> Option<String> {
    read(values, key)?
        .as_str()
        .map(str::to_owned)
        .filter(|value| !value.is_empty())
}

/// The roles the person set, in the order roles are listed.
pub fn configured_roles(values: &Map<String, Value>) -> Vec<(RunRole, RoleChoice)> {
    let mut roles = Vec::new();
    for role in RunRole::ALL {
        let keys = role_keys(role);
        let Some(provider) = provider(values, keys.provider) else {
            continue;
        };
        roles.push((
            role,
            RoleChoice {
                provider,
                model: text(values, keys.model),
                effort: text(values, keys.effort),
                tier: text(values, keys.tier),
            },
        ));
    }
    roles
}

/// Roles are global settings: a project or thread layer cannot hold them.
pub fn role_setting(key: &str) -> bool {
    role_setting_keys().contains(&key)
}

#[cfg(test)]
mod tests {
    //! Ports `packages/settings/src/roles.test.ts`: "no role is set until the person
    //! picks its provider" and "a set role carries its provider and only the fields
    //! changed from default" (the layer refusal is `batch::placement`'s test).

    use super::*;
    use serde_json::json;

    fn values(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn a_stored_value_the_key_refuses_counts_as_unset() {
        // `roles.ts` runs the key's schema before reading it: "chatgpt" is not a
        // provider, and "bogus" is not a tier, so neither reaches a role.
        let unset = values(json!({ "providers.coder.provider": "chatgpt" }));
        assert!(configured_roles(&unset).is_empty());
        let partial = values(json!({
            "providers.coder.provider": "claude",
            "providers.coder.tier": "bogus",
            "providers.coder.model": 7
        }));
        let roles = configured_roles(&partial);
        assert_eq!(roles.len(), 1);
        assert_eq!(roles[0].1.provider, "claude");
        assert_eq!(roles[0].1.tier, None);
        assert_eq!(roles[0].1.model, None);
    }

    #[test]
    fn no_role_is_set_until_the_person_picks_its_provider() {
        assert!(configured_roles(&values(json!({}))).is_empty());
        // A model or effort alone still leaves the role to nobody.
        let set = values(json!({
            "providers.reviewer.model": "opus-5.5",
            "providers.reviewer.reasoningEffort": "xhigh"
        }));
        assert!(configured_roles(&set).is_empty());
    }

    #[test]
    fn a_set_role_carries_its_provider_and_only_the_fields_changed_from_default() {
        let set = values(json!({
            "providers.coder.provider": "codex",
            "providers.verifier.provider": "claude",
            "providers.verifier.model": "opus-5.5",
            "providers.verifier.reasoningEffort": "high",
            "providers.verifier.tier": "priority",
            "providers.reviewer.provider": "claude",
            "providers.reviewer.model": "default",
            "providers.reviewer.tier": "default"
        }));
        let roles = configured_roles(&set);
        assert_eq!(roles.len(), 3);
        assert_eq!(
            roles[0],
            (
                RunRole::Build,
                RoleChoice {
                    provider: "codex".into(),
                    model: None,
                    effort: None,
                    tier: None
                }
            )
        );
        assert_eq!(
            roles[2],
            (
                RunRole::Verify,
                RoleChoice {
                    provider: "claude".into(),
                    model: Some("opus-5.5".into()),
                    effort: Some("high".into()),
                    tier: Some("priority".into())
                }
            )
        );
        assert_eq!(roles[1].1.model, None);
        assert!(role_setting("providers.coder.model"));
        assert!(!role_setting("threads.unresponsiveAfter"));
    }
}

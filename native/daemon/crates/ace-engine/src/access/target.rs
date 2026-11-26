// SPDX-License-Identifier: Apache-2.0
//! The access boundary `index.ts:653`-`:716` owns: the child identity a delegated thread is
//! measured by, how a target instance is resolved before any thread exists, the modes an
//! instance offers through the model catalog, and a thread's access as its children see it.

use ace_json::Value;

use crate::access::modes::{Identity, Offer, is_access_mode, offers_of};
use crate::{EngineError, EngineStore, State};

/// The `AgentSelection` fields access reads (`index.ts:657`, `:674`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Selection {
    pub account_id: Option<String>,
    pub instance_id: Option<String>,
    pub acp_agent_id: Option<String>,
    pub installation_id: Option<String>,
}

impl Selection {
    pub fn from_value(value: Option<&Value>) -> Selection {
        let text = |key: &str| {
            value
                .and_then(|value| value.get(key))
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        Selection {
            account_id: text("accountId"),
            instance_id: text("instanceId"),
            acp_agent_id: text("acpAgentId"),
            installation_id: text("installationId"),
        }
    }
}

/// `targetInstance` (`index.ts:670`): the account a launch will use, before any thread exists.
pub fn target_instance(
    provider: &str,
    selection: Option<&Selection>,
    select_instance: Option<&str>,
) -> String {
    selection
        .and_then(|selection| selection.account_id.clone())
        .or_else(|| selection.and_then(|selection| selection.instance_id.clone()))
        .or_else(|| select_instance.map(str::to_owned))
        .unwrap_or_else(|| format!("{provider}-cli-default"))
}

/// `permissionTarget` (`index.ts:657`): the child identity a policy is checked against. ACP
/// policies carry the agent's install identity; every other provider names the target account.
pub fn permission_target(
    provider: &str,
    backend: Option<&str>,
    selection: Option<&Selection>,
    target: &str,
) -> Result<Identity, EngineError> {
    if provider == "acp" {
        let missing = |field: &str| {
            EngineError::Records(format!(
                "Invalid input: expected string, received undefined at {field}"
            ))
        };
        let selection = selection.ok_or_else(|| missing("acpAgentId"))?;
        let acp_agent_id = selection
            .acp_agent_id
            .clone()
            .ok_or_else(|| missing("acpAgentId"))?;
        let installation_id = selection
            .installation_id
            .clone()
            .ok_or_else(|| missing("installationId"))?;
        let instance_id = selection
            .instance_id
            .clone()
            .ok_or_else(|| missing("instanceId"))?;
        let identity = Identity {
            provider: "acp".to_owned(),
            backend: backend.map(str::to_owned),
            acp_agent_id: Some(acp_agent_id),
            installation_id: Some(installation_id),
            instance_id: Some(instance_id),
        };
        if !identity.valid() {
            return Err(EngineError::Records(
                "Invalid input: expected string to have >=1 characters".to_owned(),
            ));
        }
        return Ok(identity);
    }
    Ok(Identity {
        provider: provider.to_owned(),
        backend: backend.map(str::to_owned),
        acp_agent_id: None,
        installation_id: None,
        instance_id: Some(target.to_owned()),
    })
}

/// The model catalog's permission capabilities for one account (`EngineModels.permissionCapabilities`,
/// `models.ts:37`): the instance's reported modes over the provider's base capabilities, or none
/// while the catalog knows none.
///
/// E5.6's `ModelCatalog` supplies [`PermissionCatalog::permission_modes`]; the default
/// `permission_capabilities` is the adapter for `EngineModels.knownPermissionCapabilities`
/// (`models.ts:37`-`:58`), so a catalog never repeats the merge.
pub trait PermissionCatalog {
    /// The native permission-mode rows (the protocol's `NativePermissionMode` JSON) the account's
    /// catalogue knows, or `None` while it knows none: an agent that has not reported its session
    /// modes yet is unknown, not one that offers nothing.
    fn permission_modes(&self, _provider: &str, _instance: Option<&str>) -> Option<Vec<Value>> {
        None
    }

    /// `permissionCapabilities`: the catalog's modes over the base, else the base unchanged.
    fn permission_capabilities(
        &self,
        provider: &str,
        instance: Option<&str>,
        base: &Value,
    ) -> Option<Value> {
        merge_permission_capabilities(self.permission_modes(provider, instance)?, base)
    }
}

/// The adapter E5.6's `ModelCatalog` plugs in through: its `permission_modes` as a closure, so an
/// engine that holds the catalog behind a trait object needs no wrapper type of its own.
pub struct ModelCatalogAdapter<F>(pub F);

impl<F> PermissionCatalog for ModelCatalogAdapter<F>
where
    F: Fn(&str, Option<&str>) -> Option<Vec<Value>>,
{
    fn permission_modes(&self, provider: &str, instance: Option<&str>) -> Option<Vec<Value>> {
        (self.0)(provider, instance)
    }
}

/// `knownPermissionCapabilities` (`models.ts:43`-`:58`): the rows become the capabilities'
/// `permissionModes` and `permissions.modes`, on a base that already carries `permissions`. No
/// modes, or no base permissions, leaves the base.
fn merge_permission_capabilities(modes: Vec<Value>, base: &Value) -> Option<Value> {
    if modes.is_empty() {
        return None;
    }
    let mut next = base.clone();
    let map = next.as_object_mut()?;
    let permissions = map.get_mut("permissions")?.as_object_mut()?;
    let ids: Vec<Value> = modes
        .iter()
        .filter_map(|mode| mode.get("id").and_then(Value::as_str).map(Value::from))
        .collect();
    permissions.insert("permissionModes", Value::Array(modes.clone().into()));
    permissions.insert("modes", Value::Array(ids.into()));
    map.insert("permissionModes", Value::Array(modes.into()));
    Some(next)
}

/// `offeredModes` (`index.ts:696`): the access modes a provider's target instance genuinely
/// supports, as the model catalog reports them and ace's table fills in.
pub fn offered_modes(
    provider: &str,
    registered: bool,
    selection: Option<&Selection>,
    base: Option<&Value>,
    catalog: Option<&dyn PermissionCatalog>,
    select_instance: Option<&str>,
) -> Vec<Offer> {
    // `index.ts:700`: a provider the registry doesn't have offers nothing, not its table.
    if !registered {
        return Vec::new();
    }
    let base = base
        .cloned()
        .unwrap_or_else(|| Value::Object(ace_json::Map::new()));
    let instance = if provider == "acp" {
        selection.and_then(|selection| selection.instance_id.clone())
    } else {
        Some(target_instance(provider, selection, select_instance))
    };
    let capabilities = catalog
        .and_then(|catalog| catalog.permission_capabilities(provider, instance.as_deref(), &base))
        .unwrap_or(base);
    offers_of(provider, Some(&capabilities))
}

/// `access(id)` (`index.ts:653`): a thread's access as its children see it, an ace mode or null
/// when unranked.
pub fn access_mode(
    state: &mut State,
    store: &EngineStore,
    id: &str,
) -> Result<Option<String>, EngineError> {
    let effective = state.permission_effective(store, id)?;
    Ok(effective.filter(|mode| is_access_mode(mode)))
}

/// The thread's provider, for a caller that already holds the store.
pub fn thread_provider(store: &EngineStore, id: &str) -> Result<Option<String>, EngineError> {
    Ok(super::ceiling::thread_facts(store, id)?.map(|facts| facts.provider))
}

#[cfg(test)]
mod tests {
    //! `index.ts:653`-`:716`: target instance precedence, the ACP install identity, offered
    //! modes through the catalog, and access's four-or-null mapping.

    use super::*;
    use crate::access::storage::ensure;
    use crate::repository::testsupport::{Shell, header, home};

    fn selection(account: Option<&str>, instance: Option<&str>) -> Selection {
        Selection {
            account_id: account.map(str::to_owned),
            instance_id: instance.map(str::to_owned),
            ..Selection::default()
        }
    }

    #[test]
    fn a_target_instance_takes_the_account_then_the_selection_then_the_port_then_the_default() {
        assert_eq!(
            target_instance(
                "claude",
                Some(&selection(Some("acct"), Some("inst"))),
                Some("port")
            ),
            "acct"
        );
        assert_eq!(
            target_instance("claude", Some(&selection(None, Some("inst"))), Some("port")),
            "inst"
        );
        assert_eq!(target_instance("claude", None, Some("port")), "port");
        assert_eq!(target_instance("claude", None, None), "claude-cli-default");
    }

    #[test]
    fn a_child_identity_is_the_install_for_acp_and_the_target_account_for_everyone_else() {
        let claude = permission_target("claude", Some("acp"), None, "work").expect("claude");
        assert_eq!(claude.provider, "claude");
        assert_eq!(claude.backend.as_deref(), Some("acp"));
        assert_eq!(claude.instance_id.as_deref(), Some("work"));
        assert_eq!(claude.acp_agent_id, None);

        let acp = permission_target(
            "acp",
            Some("acp"),
            Some(&Selection {
                acp_agent_id: Some("local:one".into()),
                installation_id: Some("approved-one".into()),
                instance_id: Some("one:default".into()),
                ..Selection::default()
            }),
            "ignored",
        )
        .expect("acp");
        assert_eq!(acp.acp_agent_id.as_deref(), Some("local:one"));
        assert_eq!(acp.installation_id.as_deref(), Some("approved-one"));
        assert_eq!(acp.instance_id.as_deref(), Some("one:default"));

        // ACP without its install identity is refused, never given a default policy.
        assert!(permission_target("acp", None, None, "one").is_err());
        // `AcpIdentity`'s ids are non-empty: an empty installation id is refused too.
        assert!(
            permission_target(
                "acp",
                None,
                Some(&Selection {
                    acp_agent_id: Some("local:one".into()),
                    installation_id: Some(String::new()),
                    instance_id: Some("one:default".into()),
                    ..Selection::default()
                }),
                "one",
            )
            .is_err()
        );
    }

    struct Catalog;

    impl PermissionCatalog for Catalog {
        fn permission_modes(&self, provider: &str, instance: Option<&str>) -> Option<Vec<Value>> {
            (provider == "claude" && instance == Some("work")).then(|| {
                ace_json::parse(
                    r#"[{"id":"plan","label":"Plan","description":"Read only","risk":"read-only"},{"id":"default","label":"Default","description":"Ask","risk":"thread-write"}]"#,
                )
                .unwrap()
                .as_array()
                .map(|rows| rows.to_vec())
                .unwrap_or_default()
            })
        }
    }

    #[test]
    fn offered_modes_come_from_the_catalog_for_its_instance_and_from_the_table_otherwise() {
        let catalog = Catalog;
        let selection = selection(Some("work"), None);
        let base = ace_json::parse(
            r#"{"accessModes":[{"mode":"read-only","native":"plan"},{"mode":"ask","native":"default"}]}"#,
        )
        .unwrap();
        let offered = offered_modes(
            "claude",
            true,
            Some(&selection),
            Some(&base),
            Some(&catalog),
            None,
        );
        assert_eq!(
            offered
                .iter()
                .map(|offer| offer.mode.as_str())
                .collect::<Vec<_>>(),
            vec!["read-only", "ask"]
        );
        // Another account has no catalog row: the provider table still answers.
        let other = offered_modes("claude", true, None, None, Some(&catalog), None);
        assert_eq!(other.len(), 4);
        // A provider the registry doesn't have offers nothing.
        assert!(offered_modes("claude", false, None, None, Some(&catalog), None).is_empty());
    }

    #[test]
    fn the_model_catalog_adapter_merges_its_mode_rows_over_the_base_capabilities() {
        let base = ace_json::parse(
            r#"{"permissions":{"modes":[],"nativeAutoReview":true,"toolGate":true},"accessModes":[{"mode":"ask","native":"default"}]}"#,
        )
        .unwrap();
        let adapter = ModelCatalogAdapter(|provider: &str, instance: Option<&str>| {
            (provider == "claude" && instance == Some("work")).then(|| {
                ace_json::parse(r#"[{"id":"plan"},{"id":"default"}]"#)
                    .unwrap()
                    .as_array()
                    .map(|rows| rows.to_vec())
                    .unwrap_or_default()
            })
        });
        let merged = adapter
            .permission_capabilities("claude", Some("work"), &base)
            .expect("the catalog knows this account");
        assert_eq!(
            merged
                .get("permissionModes")
                .and_then(Value::as_array)
                .map(|rows| rows.len()),
            Some(2)
        );
        assert_eq!(
            merged
                .get("permissions")
                .and_then(|permissions| permissions.get("modes"))
                .and_then(Value::as_array)
                .map(|modes| modes.iter().filter_map(Value::as_str).collect::<Vec<_>>()),
            Some(vec!["plan", "default"])
        );
        // The base's own offers are kept: only the modes are replaced.
        assert!(merged.get("accessModes").is_some());
        // No modes for another account, or no base permissions, leaves the base.
        assert_eq!(adapter.permission_capabilities("claude", None, &base), None);
        let bare = ace_json::parse("{}").unwrap();
        assert_eq!(
            adapter.permission_capabilities("claude", Some("work"), &bare),
            None
        );
    }

    #[test]
    fn access_reads_one_of_the_four_modes_or_null() {
        let conn = home("target", &header("target"));
        let store = Shell::store(&conn);
        let mut state = State::default();
        ensure(&store, "target", None).expect("row");
        assert_eq!(
            access_mode(&mut state, &store, "target").expect("access"),
            None
        );
        conn.exec("UPDATE engine_permissions SET effective='ask' WHERE thread_id='target'")
            .unwrap();
        assert_eq!(
            access_mode(&mut state, &store, "target")
                .expect("access")
                .as_deref(),
            Some("ask")
        );
        conn.exec("UPDATE engine_permissions SET effective='custom:plan' WHERE thread_id='target'")
            .unwrap();
        assert_eq!(
            access_mode(&mut state, &store, "target").expect("access"),
            None
        );
    }
}
